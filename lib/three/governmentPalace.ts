import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Palácio do Governo, Dili, modelled from the owner's reference photographs
// (references/goverment-palace-*.jfif): a long white two-storey range with a
// continuous ground-floor arcade of round arches, rectangular windows above,
// grey-green hipped roofs, a taller flat-topped centre block carrying the
// "PALÁCIO DO GOVERNO" sign, projecting end pavilions, and a seaward garden with
// a long pool, a round fountain with a white monument, palms and cypresses,
// parking courts and a white-pillared gate with black iron railings.
//
// Local frame: x runs along the facade, +z points out of the front facade
// (toward the sea), y is up, metres. The plan is built first, then compiled
// into one geometry per material slot.

const BAY = 4.2;
const FLOOR = 5.2;
const LOGGIA = 2.4; // depth of the arcade behind the front arches

type Block = { name: string; x0: number; x1: number; back: number; front: number; roof: "hip" | "flat"; extra: number };

export type PalacePlan = {
  blocks: Block[];
  gardenDepth: number;
  palms: [number, number][];
  cypress: [number, number][];
  halfWidth: number;
};

export function planGovernmentPalace(gardenDepth: number): PalacePlan {
  const D = Math.max(46, Math.min(78, gardenDepth));
  const blocks: Block[] = [
    { name: "west-pavilion", x0: -71, x1: -54.2, back: -9, front: 10.5, roof: "hip", extra: 0.6 },
    { name: "west-range", x0: -54.2, x1: -16.4, back: -8, front: 8, roof: "hip", extra: 0 },
    { name: "centre", x0: -16.4, x1: 16.4, back: -11, front: 12, roof: "flat", extra: 1.8 },
    { name: "east-range", x0: 16.4, x1: 54.2, back: -8, front: 8, roof: "hip", extra: 0 },
    { name: "east-pavilion", x0: 54.2, x1: 71, back: -9, front: 10.5, roof: "hip", extra: 0.6 },
  ];
  const palms: [number, number][] = [];
  const cypress: [number, number][] = [];
  for (let z = 27; z <= D - 12; z += 7.5) {
    palms.push([-9.5, z], [9.5, z], [-31, z], [31, z]);
  }
  for (let x = -66; x <= 66; x += 11) palms.push([x, D + 4.5]); // seafront promenade
  cypress.push([-5.5, 26.5], [5.5, 26.5], [-5.5, 45], [5.5, 45], [-20, 26], [20, 26]);
  return { blocks, gardenDepth: D, palms, cypress, halfWidth: 76 };
}

type Slot = "wall" | "trim" | "recess" | "glass" | "roof" | "paving" | "asphalt" | "lawn" | "water" | "iron" | "hedge" | "sign";

function hipRoof(w: number, d: number, rise: number) {
  // Ridge runs along the longer side.
  const along = w >= d;
  const L = along ? w : d;
  const S = along ? d : w;
  const r = Math.max(0, (L - S) / 2);
  const hw = w / 2;
  const hd = d / 2;
  const ridgeA = along ? [-r, rise, 0] : [0, rise, -r];
  const ridgeB = along ? [r, rise, 0] : [0, rise, r];
  const c = [
    [-hw, 0, -hd],
    [hw, 0, -hd],
    [hw, 0, hd],
    [-hw, 0, hd],
  ];
  const tris: number[][] = along
    ? [
        [c[3], c[2], ridgeB], [c[3], ridgeB, ridgeA], // front slope
        [c[1], c[0], ridgeA], [c[1], ridgeA, ridgeB], // back slope
        [c[2], c[1], ridgeB], // east hip
        [c[0], c[3], ridgeA], // west hip
      ].flat()
    : [
        [c[0], c[3], ridgeB], [c[0], ridgeB, ridgeA],
        [c[2], c[1], ridgeA], [c[2], ridgeA, ridgeB],
        [c[3], c[2], ridgeB],
        [c[1], c[0], ridgeA],
      ].flat();
  const pos = new Float32Array(tris.flat());
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) {
    uv[i * 2] = pos[i * 3] / 4;
    uv[i * 2 + 1] = pos[i * 3 + 2] / 4;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

function arcadePanel(width: number, height: number, bays: number, archW: number, archH: number) {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, 0);
  s.lineTo(width / 2, 0);
  s.lineTo(width / 2, height);
  s.lineTo(-width / 2, height);
  s.closePath();
  const step = width / bays;
  const r = archW / 2;
  for (let i = 0; i < bays; i++) {
    const cx = -width / 2 + step * (i + 0.5);
    const h = new THREE.Path();
    h.moveTo(cx - r, 0.0001);
    h.lineTo(cx + r, 0.0001);
    h.lineTo(cx + r, archH - r);
    h.absarc(cx, archH - r, r, 0, Math.PI, false);
    h.lineTo(cx - r, 0.0001);
    s.holes.push(h);
  }
  return new THREE.ExtrudeGeometry(s, { depth: 0.6, bevelEnabled: false, curveSegments: 8 });
}

function signTexture() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f4f2ec";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#1f2a33";
  g.font = "600 70px Georgia, serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("PALÁCIO DO GOVERNO", c.width / 2, c.height / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export type GovernmentPalace = {
  group: THREE.Group;
  plan: PalacePlan;
  stats: { triangles: number; slots: number };
  dispose: () => void;
};

export function buildGovernmentPalace(plan: PalacePlan): GovernmentPalace {
  const parts = new Map<Slot, THREE.BufferGeometry[]>();
  const m = new THREE.Matrix4();
  const add = (slot: Slot, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0) => {
    m.makeRotationY(ry).setPosition(x, y, z);
    geo.applyMatrix4(m);
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    (parts.get(slot) ?? parts.set(slot, []).get(slot)!).push(g);
  };
  const box = (slot: Slot, w: number, h: number, d: number, x: number, y: number, z: number) =>
    add(slot, new THREE.BoxGeometry(w, h, d), x, y + h / 2, z);

  // ---- Building blocks ----
  for (const b of plan.blocks) {
    const w = b.x1 - b.x0;
    const cx = (b.x0 + b.x1) / 2;
    const depth = b.front - b.back;
    const top = FLOOR * 2 + b.extra;
    const bays = Math.max(2, Math.round(w / BAY));
    // Ground floor sits behind the arcade; the upper floor oversails it.
    box("wall", w, FLOOR, depth - LOGGIA, cx, 0, b.back + (depth - LOGGIA) / 2);
    box("recess", w - 0.4, FLOOR - 0.4, 0.1, cx, 0, b.front - LOGGIA + 0.06);
    box("wall", w, FLOOR + b.extra, depth, cx, FLOOR, b.back + depth / 2);
    const arcade = arcadePanel(w, FLOOR, bays, b.name === "centre" ? 3.4 : 2.7, b.name === "centre" ? 4.3 : 3.7);
    add("trim", arcade, cx, 0, b.front - 0.6);
    // Storey band, cornice and plinth.
    box("trim", w + 0.3, 0.35, depth + 0.3, cx, FLOOR - 0.1, b.back + depth / 2);
    box("trim", w + 0.7, 0.55, depth + 0.7, cx, top, b.back + depth / 2);
    box("trim", w + 0.2, 0.45, 0.4, cx, 0, b.front + 0.1);
    // Upper windows, front and back, one per bay, with white surrounds.
    const step = w / bays;
    for (let i = 0; i < bays; i++) {
      const wx = b.x0 + step * (i + 0.5);
      for (const [z, s] of [[b.front, 1], [b.back, -1]] as const) {
        box("trim", 1.9, 2.9, 0.16, wx, FLOOR + 1.0, z + s * 0.06);
        box("glass", 1.35, 2.4, 0.06, wx, FLOOR + 1.25, z + s * 0.15);
        if (s === -1) {
          box("trim", 1.9, 2.5, 0.16, wx, 0.9, z - 0.06);
          box("glass", 1.35, 2.0, 0.06, wx, 1.1, z - 0.15);
        }
      }
    }
    // End walls of the pavilions get windows too.
    if (b.name.endsWith("pavilion")) {
      const ex = b.name.startsWith("west") ? b.x0 : b.x1;
      const s = b.name.startsWith("west") ? -1 : 1;
      for (let k = 0; k < 4; k++) {
        const wz = b.back + (depth / 4) * (k + 0.5);
        for (const fy of [0.9, FLOOR + 1.0]) {
          box("trim", 0.16, 2.7, 1.9, ex + s * 0.06, fy, wz);
          box("glass", 0.06, 2.2, 1.35, ex + s * 0.15, fy + 0.25, wz);
        }
      }
    }
    if (b.roof === "hip") {
      add("roof", hipRoof(w + 1.0, depth + 1.0, 3.8), cx, top + 0.55, b.back + depth / 2);
    } else {
      box("roof", w - 0.4, 0.2, depth - 0.4, cx, top + 0.3, b.back + depth / 2);
      // Parapet and the sign over the entrance.
      box("trim", w + 0.7, 1.3, 0.35, cx, top + 0.55, b.front + 0.18);
      box("trim", w + 0.7, 1.3, 0.35, cx, top + 0.55, b.back - 0.18);
      box("trim", 0.35, 1.3, depth + 0.7, b.x0 - 0.18, top + 0.55, b.back + depth / 2);
      box("trim", 0.35, 1.3, depth + 0.7, b.x1 + 0.18, top + 0.55, b.back + depth / 2);
      const sign = new THREE.PlaneGeometry(9, 1.1);
      add("sign", sign, cx, top + 1.2, b.front + 0.37);
    }
  }

  // ---- Garden, forecourt and seafront gate ----
  const D = plan.gardenDepth;
  const HW = plan.halfWidth;
  add("paving", new THREE.BoxGeometry(HW * 2, 0.3, D + 26), 0, 0.15 - 0.3, (D - 14) / 2 - 6);
  box("asphalt", HW * 2, 0.05, 11, 0, 0.0, 18.5);
  for (const sx of [-1, 1]) {
    // Lawns either side of the central axis.
    box("lawn", 21, 0.12, D - 36, sx * 19.5, 0.0, 24 + (D - 36) / 2);
    box("hedge", 21, 0.7, 0.8, sx * 19.5, 0.0, 24.4);
    // Parking courts outside the lawns.
    box("asphalt", 38, 0.06, D - 36, sx * 52, 0.0, 24 + (D - 36) / 2);
  }
  // Long reflecting pool with a stone rim, then the round fountain and its monument.
  box("trim", 8.6, 0.55, 22.6, 0, 0, 36);
  box("water", 7.4, 0.5, 21.4, 0, 0.12, 36);
  const fz = Math.min(D - 14, 56);
  add("trim", new THREE.CylinderGeometry(7.2, 7.4, 0.6, 48), 0, 0.3, fz);
  add("water", new THREE.CylinderGeometry(6.4, 6.4, 0.5, 48), 0, 0.37, fz);
  add("trim", new THREE.CylinderGeometry(1.1, 1.4, 1.8, 16), 0, 0.9, fz);
  add("trim", new THREE.CylinderGeometry(0.45, 0.6, 3.6, 12), 0, 3.6, fz);
  add("trim", new THREE.SphereGeometry(0.6, 12, 10), 0, 5.6, fz);
  // Seafront wall line with white posts and black railings, and the main gate.
  for (let x = -HW; x <= HW; x += 5.5) {
    if (Math.abs(x) < 6.5) continue;
    box("trim", 0.55, 1.9, 0.55, x, 0, D);
  }
  for (const sx of [-1, 1]) {
    box("iron", HW - 6.5, 0.08, 0.08, sx * (6.5 + (HW - 6.5) / 2), 1.55, D);
    box("iron", HW - 6.5, 0.08, 0.08, sx * (6.5 + (HW - 6.5) / 2), 0.55, D);
    box("trim", HW - 6.5, 0.45, 0.5, sx * (6.5 + (HW - 6.5) / 2), 0, D);
    // Gate pillars with caps, and the iron gate leaves between them.
    box("trim", 1.9, 4.2, 1.9, sx * 5.4, 0, D);
    box("trim", 2.3, 0.4, 2.3, sx * 5.4, 4.2, D);
    box("iron", 4.4, 2.6, 0.12, sx * 2.2, 0.2, D);
  }

  // ---- Compile by material slot ----
  const sign = signTexture();
  const mats: Record<Slot, THREE.Material> = {
    wall: new THREE.MeshStandardMaterial({ color: "#f1efe9", roughness: 0.78 }),
    trim: new THREE.MeshStandardMaterial({ color: "#fbfaf6", roughness: 0.62 }),
    recess: new THREE.MeshStandardMaterial({ color: "#9aa4ab", roughness: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ color: "#1c2a33", roughness: 0.12, metalness: 0.4 }),
    roof: new THREE.MeshStandardMaterial({ color: "#8ea89a", roughness: 0.55, metalness: 0.25, side: THREE.DoubleSide }),
    paving: new THREE.MeshStandardMaterial({ color: "#cfc8bb", roughness: 0.92 }),
    asphalt: new THREE.MeshStandardMaterial({ color: "#4a4d50", roughness: 0.95 }),
    lawn: new THREE.MeshStandardMaterial({ color: "#5f9a3d", roughness: 1 }),
    water: new THREE.MeshStandardMaterial({ color: "#2f7d8f", roughness: 0.08, metalness: 0.1 }),
    iron: new THREE.MeshStandardMaterial({ color: "#16191c", roughness: 0.45, metalness: 0.7 }),
    hedge: new THREE.MeshStandardMaterial({ color: "#3d6b2c", roughness: 1 }),
    sign: new THREE.MeshStandardMaterial({ map: sign, roughness: 0.7 }),
  };
  const group = new THREE.Group();
  group.name = "Palácio do Governo";
  let triangles = 0;
  for (const [slot, geos] of parts) {
    const merged = mergeGeometries(geos)!;
    geos.forEach((g) => g.dispose());
    triangles += merged.attributes.position.count / 3;
    const mesh = new THREE.Mesh(merged, mats[slot]);
    mesh.castShadow = slot !== "paving" && slot !== "lawn" && slot !== "asphalt" && slot !== "water";
    mesh.receiveShadow = true;
    mesh.name = slot;
    group.add(mesh);
  }
  return {
    group,
    plan,
    stats: { triangles, slots: parts.size },
    dispose() {
      group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      Object.values(mats).forEach((mt) => mt.dispose());
      sign.dispose();
    },
  };
}
