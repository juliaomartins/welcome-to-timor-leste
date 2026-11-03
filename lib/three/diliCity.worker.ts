/// <reference lib="webworker" />
import { Color, SRGBColorSpace, ShapeUtils, Vector2 } from "three";
import { CRISTO_REI, toDili } from "../geo";
import {
  FAR, NEAR, createHeightField, inCapeHole, palaceToWorld, ringBox, sculptedHeight,
  type Lake, type PalaceFrameData, type Ring,
} from "./diliCore";
import { planGovernmentPalace } from "./governmentPalace";
import { hash2, seededRandom } from "./noise";
import type { TierSettings } from "./deviceTier";
import { distanceToRoute } from "./diliRoute";
import { loadRelief } from "./relief";

// Builds Dili off the main thread so the intro keeps flying while it works.
// Everything heavy happens here: relief decoding, the ground texture, terrain
// heights and normals, 70,000 extruded buildings and all vegetation placement.

type MapData = {
  landmarks: { palace: { ring: Ring } | null };
  lakes: { n: string; p: Ring }[];
  areas: { k: string; p: Ring; n: string }[];
  roads: { c: number; p: Ring }[];
  rivers: { c: number; p: Ring }[];
};

export type CityPayload = {
  near: { heights: Float32Array; sea: Uint8Array; width: number; height: number };
  far: { heights: Float32Array; sea: Uint8Array; width: number; height: number };
  palace: PalaceFrameData;
  lakes: Lake[];
  ground: ImageBitmap;
  terrain: { segX: number; segZ: number; y: Float32Array; normal: Float32Array };
  farTerrain: { segX: number; segZ: number; y: Float32Array; normal: Float32Array; color: Float32Array };
  buildings: { position: Float32Array; color: Uint8Array; index: Uint32Array };
  trees: Float32Array; // per instance: 16 matrix + 3 colour
  palms: Float32Array; // per instance: 16 matrix
  cypress: Float32Array;
  lanes: { points: Float32Array; info: Float32Array; cars: Float32Array };
  boats: Float32Array; // per boat: 16 matrix + 1 random

  stats: Record<string, number>;
};

const AREA_COLORS: Record<string, string> = {
  urban: "#c5bcaa", park: "#6da24a", forest: "#3f6e33", scrub: "#8b8a57", farm: "#a5a26a",
  cemetery: "#b9b3a3", sand: "#e2d3a6", wetland: "#6f8f69", rock: "#9a8f80", water: "#3d7f8c",
};
// Roof shares follow the aerial references: mostly terracotta and blue, then metal grey, white and teal.
const ROOFS = ["#b4553c", "#3f6fb3", "#9ca1a4", "#e3e1da", "#4f9886", "#c4683f"].map((c) => new Color(c));
const ROOF_SHARE = [0.38, 0.6, 0.76, 0.86, 0.94, 1];
const WALLS = ["#f1eee6", "#ece4d3", "#f3e7c9", "#e3ebee", "#f0dcd2", "#ffffff"].map((c) => new Color(c));
const TAGGED_ROOF = [0, 1, 3, 2, 4]; // roof:colour index written by the data build -> palette

function polyArea(r: Ring) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x0, z0] = r[i];
    const [x1, z1] = r[(i + 1) % r.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

function compose(out: Float32Array, o: number, x: number, y: number, z: number, rotY: number, sx: number, sy: number, sz: number) {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  out.set([c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1], o);
}

type BuildResult = { payload: CityPayload; transfer: Transferable[] } | { baked: ArrayBuffer };

async function build(settings: TierSettings, progress: (p: number) => void, bake = false): Promise<BuildResult> {
  const [near, far, map, bin] = await Promise.all([
    loadRelief("/data/dili-relief.png", true),
    loadRelief("/data/dili-far-relief.png"),
    fetch("/data/dili-map.json").then((r) => r.json() as Promise<MapData>),
    fetch("/data/dili-buildings.bin").then((r) => r.arrayBuffer()),
  ]);
  progress(0.12);
  const field = createHeightField(near, far);
  const stats: Record<string, number> = {};

  // ---------- Government Palace frame from its OSM footprint ----------
  const ring = map.landmarks.palace?.ring ?? [[-30, -10], [30, -10], [30, 10], [-30, 10]];
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  let sxx = 0, szz = 0, sxz = 0;
  for (const [x, z] of ring) {
    sxx += (x - cx) ** 2; szz += (z - cz) ** 2; sxz += (x - cx) * (z - cz);
  }
  const axisAngle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  let nx = -Math.sin(axisAngle);
  let nz = Math.cos(axisAngle);
  const distToSea = (dx: number, dz: number) => {
    for (let d = 10; d < 1200; d += 5) if (field.sea(cx + dx * d, cz + dz * d)) return d;
    return 1200;
  };
  const dA = distToSea(nx, nz);
  const dB = distToSea(-nx, -nz);
  if (dB < dA) { nx = -nx; nz = -nz; }
  const plan = planGovernmentPalace(Math.min(dA, dB) - 28);
  const palace: PalaceFrameData = {
    cx, cz, angle: Math.atan2(nx, nz), ground: field.raw(cx, cz), depth: plan.gardenDepth, halfWidth: plan.halfWidth,
  };

  // ---------- Lakes ----------
  const lakes: Lake[] = map.lakes.map((l) => {
    const shore = l.p.map(([x, z]) => field.raw(x, z)).sort((a, b) => a - b);
    return { n: l.n, p: l.p, box: ringBox(l.p), level: Math.max(0.25, shore[Math.floor(shore.length * 0.2)] - 0.3) };
  });
  const { heightAt, inPalace, lakeAt } = sculptedHeight(field, { palace, lakes });
  const [crX, crZ] = toDili(CRISTO_REI);
  const nearStatue = (x: number, z: number, r = 45) => Math.hypot(x - crX, z - crZ) < r;

  // ---------- Buildings ----------
  const dv = new DataView(bin);
  const count = dv.getUint32(4, true);
  type B = { ring: Ring; h: number; base: number; roof: number; seed: number; tagged: boolean };
  const blds: B[] = [];
  let off = 8;
  for (let b = 0; b < count; b++) {
    const n = dv.getUint16(off, true);
    const h = dv.getUint16(off + 2, true) / 10;
    const base = dv.getInt16(off + 4, true) / 10;
    const roof = dv.getUint8(off + 6);
    const r: Ring = [];
    let sx = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      const x = dv.getInt16(off + 8 + i * 4, true) / 2;
      const z = dv.getInt16(off + 10 + i * 4, true) / 2;
      r.push([x, z]);
      sx += x; sz += z;
    }
    off += 8 + n * 4;
    sx /= n; sz /= n;
    // The palace complex and the statue's summit are modelled separately.
    if (inPalace(sx, sz, 6) || nearStatue(sx, sz) || lakeAt(sx, sz)) continue;
    // Lighter tiers only build what the camera passes near; the palace and cape districts always stay.
    if (
      settings.corridor < Infinity &&
      distanceToRoute(sx, sz) > settings.corridor &&
      Math.hypot(sx - crX, sz - crZ) > 1500 &&
      Math.hypot(sx - palace.cx, sz - palace.cz) > 1200
    )
      continue;
    blds.push({ ring: r, h, base, roof, seed: b, tagged: false });
  }
  stats.buildings = blds.length;

  const nearW = NEAR.xE - NEAR.xW;
  const nearD = NEAR.zS - NEAR.zN;

  // ---------- Ground texture (baked once into public/data/dili-ground.jpg) ----------
  const paintGround = () => {
    const TW = 4096;
    const TH = Math.round((TW * nearD) / nearW);
    const mpp = nearW / TW;
    const canvas = new OffscreenCanvas(TW, TH);
    const g = canvas.getContext("2d")!;
    {
      const W = near.width;
      const H = near.height;
      const base = new OffscreenCanvas(W, H);
      const bg = base.getContext("2d")!;
      const img = bg.createImageData(W, H);
      const lowland = new Color("#6f9a4b");
      const hillGreen = new Color("#5f8640");
      const dryHill = new Color("#94895a");
      const sand = new Color("#e1d2a6");
      const shallow = new Color("#5cc2bd");
      const deepSea = new Color("#0f4f73");
      const c = new Color();
      const smooth = (x: number, a: number, b: number) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
      };
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const h = near.heights[i];
          if (near.sea[i]) {
            c.copy(shallow).lerp(deepSea, smooth(-h, 3, 45));
          } else {
            const sx = near.heights[y * W + Math.min(W - 1, x + 1)] - near.heights[y * W + Math.max(0, x - 1)];
            const sy = near.heights[Math.min(H - 1, y + 1) * W + x] - near.heights[Math.max(0, y - 1) * W + x];
            const slope = Math.hypot(sx, sy) / 20;
            const n = hash2(x >> 2, y >> 2, 9);
            // Dili's hills: green valleys, dry olive-brown ridges (see the city references).
            c.copy(lowland).lerp(hillGreen, smooth(h, 10, 120));
            c.lerp(dryHill, smooth(h, 60, 500) * smooth(slope + n * 0.4, 0.15, 0.9) * 0.8);
            let coast = false;
            if (h < 5) {
              for (let k = -2; k <= 2 && !coast; k++)
                for (let l = -2; l <= 2; l++) {
                  const j = Math.min(H - 1, Math.max(0, y + k)) * W + Math.min(W - 1, Math.max(0, x + l));
                  if (near.sea[j]) { coast = true; break; }
                }
            }
            if (coast) c.copy(sand);
            c.multiplyScalar(0.94 + n * 0.1);
          }
          img.data[i * 4] = c.r * 255;
          img.data[i * 4 + 1] = c.g * 255;
          img.data[i * 4 + 2] = c.b * 255;
          img.data[i * 4 + 3] = 255;
        }
      }
      bg.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(base, 0, 0, TW, TH);
    }
    const toPx = (x: number, z: number) => [((x - NEAR.xW) / nearW) * TW, ((z - NEAR.zN) / nearD) * TH] as const;
    const pathRing = (r: Ring, close: boolean) => {
      g.beginPath();
      r.forEach(([x, z], i) => {
        const [px, py] = toPx(x, z);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      if (close) g.closePath();
    };
    const areas = [...map.areas].sort((a, b) => {
      const A = ringBox(a.p), B = ringBox(b.p);
      return (B.x1 - B.x0) * (B.z1 - B.z0) - (A.x1 - A.x0) * (A.z1 - A.z0);
    });
    for (const a of areas) {
      const box = ringBox(a.p);
      const areaKm2 = ((box.x1 - box.x0) * (box.z1 - box.z0)) / 1e6;
      // Water polygons out at sea (harbour basins) are already sea; skip them.
      if (a.k === "water" && field.sea((box.x0 + box.x1) / 2, (box.z0 + box.z1) / 2)) continue;
      g.fillStyle = AREA_COLORS[a.k] ?? "#8a9a6a";
      // Land use is a tint, not paint: big polygons (residential districts,
      // the Cristo Rei protected area) only nudge the terrain colour.
      g.globalAlpha = a.k === "urban" ? (areaKm2 > 0.5 ? 0.18 : 0.35) : areaKm2 > 1 ? 0.22 : 0.8;
      if (a.k === "park" && areaKm2 > 1) g.fillStyle = AREA_COLORS.forest;
      pathRing(a.p, true);
      g.fill();
    }
    g.globalAlpha = 1;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const r of map.rivers) {
      g.strokeStyle = "#b8ab92";
      g.lineWidth = (r.c === 2 ? 34 : 7) / mpp;
      pathRing(r.p, false);
      g.stroke();
      g.strokeStyle = "#5f8c8f";
      g.lineWidth = (r.c === 2 ? 7 : 2) / mpp;
      pathRing(r.p, false);
      g.stroke();
    }
    for (const l of lakes) {
      g.fillStyle = g.strokeStyle = "#a7a183";
      g.lineWidth = 14 / mpp;
      pathRing(l.p, true);
      g.fill();
      g.stroke();
    }
    // Batched: one path and one fill/stroke per style instead of one per feature.
    const addRing = (r: Ring, close: boolean) => {
      r.forEach(([x, z], i) => {
        const [px, py] = toPx(x, z);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      if (close) g.closePath();
    };
    // A few hundred shapes per path: far fewer draw calls than one per feature,
    // without handing the rasteriser one enormous path.
    const BATCH = 300;
    g.fillStyle = "rgba(196,188,172,0.55)";
    for (let i = 0; i < blds.length; i += BATCH) {
      g.beginPath();
      for (let k = i; k < Math.min(blds.length, i + BATCH); k++) addRing(blds[k].ring, true);
      g.fill();
    }
    const ROAD_W = [0, 2.6, 4, 6.5, 9, 12, 15];
    const roadColor = (c: number) => (c <= 1 ? "#9a917f" : c === 2 ? "#7b7c7a" : "#55585a");
    for (const pass of [0, 1]) {
      for (let cls = 1; cls <= 6; cls++) {
        if (pass === 0 && cls < 3) continue;
        g.strokeStyle = pass === 0 ? "#d6d0c2" : roadColor(cls);
        g.lineWidth = (pass === 0 ? ROAD_W[cls] + 3 : ROAD_W[cls]) / mpp;
        const roads = map.roads.filter((r) => r.c === cls);
        for (let i = 0; i < roads.length; i += BATCH) {
          g.beginPath();
          for (let k = i; k < Math.min(roads.length, i + BATCH); k++) addRing(roads[k].p, false);
          g.stroke();
        }
      }
    }
    return canvas;
  };
  if (bake) {
    const jpeg = await paintGround().convertToBlob({ type: "image/jpeg", quality: 0.9 });
    return { baked: await jpeg.arrayBuffer() };
  }
  const ground = await createImageBitmap(await (await fetch("/data/dili-ground.jpg")).blob());
  progress(0.38);

  // ---------- Terrain heights and normals ----------
  const grid = (b: typeof NEAR, segX: number, segZ: number, hFn: (x: number, z: number) => number) => {
    const y = new Float32Array((segX + 1) * (segZ + 1));
    const dx = (b.xE - b.xW) / segX;
    const dz = (b.zS - b.zN) / segZ;
    for (let iz = 0; iz <= segZ; iz++)
      for (let ix = 0; ix <= segX; ix++) y[iz * (segX + 1) + ix] = hFn(b.xW + ix * dx, b.zN + iz * dz);
    const normal = new Float32Array(y.length * 3);
    for (let iz = 0; iz <= segZ; iz++)
      for (let ix = 0; ix <= segX; ix++) {
        const l = y[iz * (segX + 1) + Math.max(0, ix - 1)];
        const r = y[iz * (segX + 1) + Math.min(segX, ix + 1)];
        const u = y[Math.max(0, iz - 1) * (segX + 1) + ix];
        const d = y[Math.min(segZ, iz + 1) * (segX + 1) + ix];
        const gx = (r - l) / (2 * dx);
        const gz = (d - u) / (2 * dz);
        const len = Math.hypot(gx, 1, gz);
        const k = (iz * (segX + 1) + ix) * 3;
        normal[k] = -gx / len;
        normal[k + 1] = 1 / len;
        normal[k + 2] = -gz / len;
      }
    return { segX, segZ, y, normal };
  };
  const segX = settings.diliTerrainSegments;
  const segZ = Math.round((segX * nearD) / nearW);
  // Under the cape patch the coarse terrain drops away, out of sight.
  const terrain = grid(NEAR, segX, segZ, (x, z) =>
    inCapeHole(x, z) ? heightAt(x, z) - 40 : inPalace(x, z, -2) ? palace.ground - 0.25 : heightAt(x, z),
  );
  const inset = 250;
  const farSegX = 300;
  const farSegZ = 260;
  const farGrid = grid(FAR, farSegX, farSegZ, (x, z) => {
    let h = field.farRaw(x, z);
    if (h <= 0) h = -12;
    if (x > NEAR.xW + inset && x < NEAR.xE - inset && z > NEAR.zN + inset && z < NEAR.zS - inset) h -= 60;
    return h - 1.5;
  });
  const farColor = new Float32Array(farGrid.y.length * 3);
  {
    const lo = new Color("#6a9448"), mid = new Color("#55803e"), hi = new Color("#8a8458"), sea = new Color("#0f4f73");
    const c = new Color();
    for (let i = 0; i < farGrid.y.length; i++) {
      const h = farGrid.y[i] + 1.5;
      if (h <= -11) c.copy(sea);
      else c.copy(lo).lerp(mid, Math.min(1, Math.max(0, (h - 20) / 280))).lerp(hi, Math.min(1, Math.max(0, (h - 300) / 1100)) * 0.7);
      farColor.set([c.r, c.g, c.b], i * 3);
    }
  }
  progress(0.5);

  // ---------- Building mesh: shared wall corners, hipped roofs on simple houses ----------
  let verts = 0;
  let tris = 0;
  for (const b of blds) {
    const n = b.ring.length;
    verts += n * 3 + (n === 4 ? 2 : 0);
    tris += n * 2 + (n === 4 ? 6 : n - 2);
  }
  const pos = new Float32Array(verts * 3);
  const col = new Uint8Array(verts * 3);
  const idx = new Uint32Array(tris * 3);
  let v = 0;
  let t = 0;
  const setV = (x: number, y: number, z: number, c: Color, k = 1) => {
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    col[v * 3] = Math.min(255, c.r * k * 255);
    col[v * 3 + 1] = Math.min(255, c.g * k * 255);
    col[v * 3 + 2] = Math.min(255, c.b * k * 255);
    return v++;
  };
  const roofC = new Color();
  const ridgeC = new Color();
  let done = 0;
  for (const b of blds) {
    const n = b.ring.length;
    const r = hash2(b.seed, 7, 1);
    const wall = WALLS[Math.floor(r * WALLS.length) % WALLS.length];
    const pick = hash2(b.seed, 11, 5);
    const roofIndex = ROOF_SHARE.findIndex((s) => pick <= s);
    roofC.copy(b.tagged ? ROOFS[TAGGED_ROOF[b.roof] ?? 2] : ROOFS[roofIndex]).multiplyScalar(0.86 + hash2(b.seed, 3, 2) * 0.26);
    const bottom = b.base - 1.8;
    const top = b.base + b.h;
    const ring = polyArea(b.ring) < 0 ? [...b.ring].reverse() : b.ring;
    const v0 = v;
    for (const [x, z] of ring) setV(x, bottom, z, wall, 0.55);
    for (const [x, z] of ring) setV(x, top, z, wall, 1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx[t++] = v0 + i; idx[t++] = v0 + j; idx[t++] = v0 + n + j;
      idx[t++] = v0 + i; idx[t++] = v0 + n + j; idx[t++] = v0 + n + i;
    }
    const r0 = v;
    for (const [x, z] of ring) setV(x, top, z, roofC, 1);
    if (n === 4) {
      const [a, bb, c2, d] = ring;
      const l01 = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
      const l12 = Math.hypot(c2[0] - bb[0], c2[1] - bb[1]);
      const long01 = l01 >= l12;
      const S = Math.min(l01, l12);
      const rise = Math.min(4, S * 0.3);
      const mid = (p: [number, number], q: [number, number]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number];
      const [m1, m2] = long01 ? [mid(d, a), mid(bb, c2)] : [mid(a, bb), mid(c2, d)];
      const ddx = m2[0] - m1[0];
      const ddz = m2[1] - m1[1];
      const L = Math.hypot(ddx, ddz) || 1;
      const pull = Math.min(S / 2, L / 2 - 0.01);
      ridgeC.copy(roofC).multiplyScalar(1.08);
      const ra = setV(m1[0] + (ddx / L) * pull, top + rise, m1[1] + (ddz / L) * pull, ridgeC);
      const rb = setV(m2[0] - (ddx / L) * pull, top + rise, m2[1] - (ddz / L) * pull, ridgeC);
      if (long01) idx.set([r0, r0 + 1, rb, r0, rb, ra, r0 + 2, r0 + 3, ra, r0 + 2, ra, rb, r0 + 1, r0 + 2, rb, r0 + 3, r0, ra], t);
      else idx.set([r0 + 1, r0 + 2, rb, r0 + 1, rb, ra, r0 + 3, r0, ra, r0 + 3, ra, rb, r0 + 2, r0 + 3, rb, r0, r0 + 1, ra], t);
      t += 18;
    } else {
      const faces = ShapeUtils.triangulateShape(ring.map(([x, z]) => new Vector2(x, z)), []);
      for (const f of faces) {
        idx[t++] = r0 + f[0]; idx[t++] = r0 + f[1]; idx[t++] = r0 + f[2];
      }
      for (let k = faces.length; k < n - 2; k++) {
        idx[t++] = r0; idx[t++] = r0; idx[t++] = r0;
      }
    }
    if (++done % 10000 === 0) progress(0.5 + (done / blds.length) * 0.3);
  }
  stats.buildingTriangles = tris;

  // ---------- Vegetation ----------
  const rand = seededRandom(23);
  const CELL = 6;
  const gw = Math.ceil(nearW / CELL);
  const gh = Math.ceil(nearD / CELL);
  const occupied = new Uint8Array(gw * gh);
  for (const b of blds) {
    const bx = ringBox(b.ring);
    for (let z = Math.floor((bx.z0 - NEAR.zN) / CELL); z <= Math.floor((bx.z1 - NEAR.zN) / CELL); z++)
      for (let x = Math.floor((bx.x0 - NEAR.xW) / CELL); x <= Math.floor((bx.x1 - NEAR.xW) / CELL); x++)
        if (x >= 0 && z >= 0 && x < gw && z < gh) occupied[z * gw + x] = 1;
  }
  for (const r of map.roads) {
    for (let i = 0; i < r.p.length - 1; i++) {
      const [x0, z0] = r.p[i];
      const [x1, z1] = r.p[i + 1];
      const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 3);
      for (let s = 0; s <= steps; s++) {
        const x = Math.floor((x0 + ((x1 - x0) * s) / steps - NEAR.xW) / CELL);
        const z = Math.floor((z0 + ((z1 - z0) * s) / steps - NEAR.zN) / CELL);
        if (x >= 0 && z >= 0 && x < gw && z < gh) occupied[z * gw + x] = 1;
      }
    }
  }
  const free = (x: number, z: number) => {
    const gx = Math.floor((x - NEAR.xW) / CELL);
    const gz = Math.floor((z - NEAR.zN) / CELL);
    return gx >= 0 && gz >= 0 && gx < gw && gz < gh && !occupied[gz * gw + gx];
  };
  const UCELL = 10;
  const um = new OffscreenCanvas(Math.ceil(nearW / UCELL), Math.ceil(nearD / UCELL));
  const ug = um.getContext("2d", { willReadFrequently: true })!;
  ug.fillStyle = "#fff";
  for (const a of map.areas) {
    if (a.k !== "urban") continue;
    ug.beginPath();
    a.p.forEach(([x, z], i) => {
      const px = (x - NEAR.xW) / UCELL;
      const pz = (z - NEAR.zN) / UCELL;
      if (i === 0) ug.moveTo(px, pz);
      else ug.lineTo(px, pz);
    });
    ug.closePath();
    ug.fill();
  }
  const urbanPx = ug.getImageData(0, 0, um.width, um.height).data;
  const inUrban = (x: number, z: number) => urbanPx[(Math.floor((z - NEAR.zN) / UCELL) * um.width + Math.floor((x - NEAR.xW) / UCELL)) * 4] > 127;

  const capeTrees = settings.capeTrees;
  const maxTrees = settings.trees + capeTrees;
  const trees = new Float32Array(maxTrees * 19);
  const leaf = new Color();
  let placed = 0;
  // The summit itself is a paved plaza on open, grassy ground: clear around the
  // statue and sparse out to the edge of the hilltop, where the home page's camera stands.
  const summitClear = (x: number, z: number) => {
    const d = Math.hypot(x - crX, z - crZ);
    return d < 40 || (d < 130 && rand() > 0.25);
  };
  // Cape Fatucama first: a dense green cover around the statue, as in the references.
  for (let tries = 0; placed < capeTrees && tries < capeTrees * 8; tries++) {
    const a = rand() * Math.PI * 2;
    const r = 28 + Math.sqrt(rand()) * 1050;
    const x = crX + 260 + Math.cos(a) * r;
    const z = crZ + 240 + Math.sin(a) * r;
    if (field.sea(x, z) || !free(x, z) || field.raw(x, z) < 2 || summitClear(x, z)) continue;
    const size = 6 + rand() * 7;
    compose(trees, placed * 19, x, heightAt(x, z) - 0.4, z, rand() * Math.PI * 2, size, size * 0.9, size);
    leaf.setHSL(0.24 + rand() * 0.07, 0.42 + rand() * 0.2, 0.16 + rand() * 0.1, SRGBColorSpace);
    trees.set([leaf.r, leaf.g, leaf.b], placed * 19 + 16);
    placed++;
  }
  for (let tries = 0; placed < maxTrees && tries < maxTrees * 10; tries++) {
    const x = NEAR.xW + rand() * nearW;
    const z = NEAR.zN + rand() * nearD;
    if (field.sea(x, z) || lakeAt(x, z) || inPalace(x, z, 4) || summitClear(x, z) || !free(x, z)) continue;
    const h = field.raw(x, z);
    const urban = inUrban(x, z);
    // Cape Fatucama is densely wooded (see the Cristo Rei references).
    const cape = Math.hypot(x - crX, z - crZ) < 1100 && !urban;
    if (rand() > (cape ? 0.95 : urban ? 0.55 : h < 400 ? 0.42 : 0.18)) continue;
    const size = (urban ? 7 : 6) + rand() * (urban ? 7 : 6);
    compose(trees, placed * 19, x, heightAt(x, z) - 0.3, z, rand() * Math.PI * 2, size * 0.9, size, size * 0.9);
    leaf.setHSL(0.21 + rand() * 0.08, 0.34 + rand() * 0.2, h > 200 ? 0.2 + rand() * 0.08 : 0.17 + rand() * 0.09, SRGBColorSpace);
    trees.set([leaf.r, leaf.g, leaf.b], placed * 19 + 16);
    placed++;
  }
  stats.trees = placed;

  const palmList: number[] = [];
  const palmAt = (x: number, y: number, z: number) => {
    const m = new Float32Array(16);
    const s = 12 + rand() * 5;
    compose(m, 0, x, y, z, rand() * Math.PI * 2, s, s, s);
    palmList.push(...m);
  };
  for (const [lx, lz] of plan.palms) {
    const [wx, wz] = palaceToWorld(palace, lx, lz);
    palmAt(wx, palace.ground, wz);
  }
  // The seafront from Dili to Cape Fatucama: walk south from the sea to the beach line.
  for (let x = -2600; x < 3300; x += 22) {
    for (let z = -4500; z < 1500; z += 4) {
      if (field.sea(x, z)) continue;
      if (field.raw(x, z) < 6) {
        const pz = z + 10 + rand() * 8;
        if (!inPalace(x, pz) && free(x, pz)) palmAt(x + rand() * 6, field.raw(x, pz), pz);
      }
      break;
    }
  }
  const cypress = new Float32Array(plan.cypress.length * 16);
  plan.cypress.forEach(([lx, lz], i) => {
    const [wx, wz] = palaceToWorld(palace, lx, lz);
    compose(cypress, i * 16, wx, palace.ground, wz, 0, 9, 9, 9);
  });
  const palms = new Float32Array(palmList);
  stats.palms = palms.length / 16;

  // ---------- Traffic lanes: the main roads the camera flies over ----------
  // Timor-Leste drives on the left; the scene offsets each car to the left of its direction.
  const lanePts: number[] = [];
  const laneInfo: number[] = []; // per lane: first point index, point count, length
  const majors = map.roads
    .filter((r) => r.c >= 4 && r.p.length >= 2)
    .map((r) => {
      let len = 0;
      for (let i = 1; i < r.p.length; i++) len += Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
      return { r, len, d: distanceToRoute(r.p[0][0], r.p[0][1]) };
    })
    .filter((o) => o.len > 120 && o.d < Math.min(2500, settings.corridor + 800))
    .sort((a, b) => b.len - a.len)
    .slice(0, 160);
  for (const { r, len } of majors) {
    laneInfo.push(lanePts.length / 3, r.p.length, len);
    for (const [x, z] of r.p) lanePts.push(x, Math.max(0.3, heightAt(x, z)), z);
  }
  const totalLen = majors.reduce((sum, o) => sum + o.len, 0);
  const carData: number[] = []; // per car: lane, start, speed, direction, r, g, b
  const CAR_COLORS = ["#f2f2f0", "#d9dadc", "#2b2f33", "#8a9097", "#b8312f", "#1f4e8c", "#e2c044", "#f2f2f0"].map((c) => new Color(c));
  if (majors.length) {
    for (let i = 0; i < settings.traffic; i++) {
      // Pick lanes in proportion to their length so traffic density is even.
      let pick = rand() * totalLen;
      let lane = 0;
      while (lane < majors.length - 1 && pick > majors[lane].len) pick -= majors[lane++].len;
      const c = CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)];
      carData.push(lane, rand() * majors[lane].len, 8 + rand() * 7, rand() < 0.5 ? 1 : -1, c.r, c.g, c.b);
    }
  }
  const lanes = { points: new Float32Array(lanePts), info: new Float32Array(laneInfo), cars: new Float32Array(carData) };
  stats.cars = carData.length / 7;

  // ---------- Boats moored in Dili Bay, off the seafront ----------
  const boats: number[] = [];
  for (let tries = 0; boats.length / 17 < settings.boats && tries < settings.boats * 60; tries++) {
    const x = -3200 + rand() * 5800;
    const z = -1800 + rand() * 1700;
    if (!field.sea(x, z)) continue;
    // Between 40 and 450 m from shore: walk south to the beach.
    let shore = Infinity;
    for (let d = 10; d < 460; d += 10) if (!field.sea(x, z + d)) { shore = d; break; }
    if (shore < 40 || shore > 450) continue;
    const m = new Float32Array(16);
    const len = 7 + rand() * 11;
    compose(m, 0, x, 0.15, z, -0.35 + rand() * 0.7 + (rand() < 0.5 ? 0 : Math.PI), len, len, len);
    boats.push(...m, rand());
  }
  const boatData = new Float32Array(boats);
  stats.boats = boatData.length / 17;
  progress(0.95);

  const payload: CityPayload = {
    near: { heights: near.heights, sea: near.sea, width: near.width, height: near.height },
    far: { heights: far.heights, sea: far.sea, width: far.width, height: far.height },
    palace,
    lakes,
    ground,
    terrain,
    farTerrain: { ...farGrid, color: farColor, segX: farSegX, segZ: farSegZ },
    buildings: { position: pos, color: col, index: idx },
    trees: trees.subarray(0, placed * 19).slice(),
    palms,
    cypress,
    lanes,
    boats: boatData,
    stats,
  };
  const transfer: Transferable[] = [
    near.heights.buffer, near.sea.buffer, far.heights.buffer, far.sea.buffer, ground,
    terrain.y.buffer, terrain.normal.buffer, farGrid.y.buffer, farGrid.normal.buffer, farColor.buffer,
    pos.buffer, col.buffer, idx.buffer, payload.trees.buffer, palms.buffer, cypress.buffer,
    lanes.points.buffer, lanes.info.buffer, lanes.cars.buffer, boatData.buffer,
  ];
  return { payload, transfer };
}

self.onmessage = async (e: MessageEvent<{ settings: TierSettings; bake?: boolean }>) => {
  try {
    const result = await build(e.data.settings, (p) => self.postMessage({ type: "progress", p }), e.data.bake);
    if ("baked" in result) self.postMessage({ type: "baked", jpeg: result.baked }, { transfer: [result.baked] });
    else self.postMessage({ type: "done", payload: result.payload }, { transfer: result.transfer });
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
