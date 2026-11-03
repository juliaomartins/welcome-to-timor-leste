import * as THREE from "three";
import { ISLAND_BOUNDS } from "../geo";
import type { Relief } from "./relief";
import { hash2 } from "./noise";

// Island-scale terrain for the intro flight, built from real elevation and
// bathymetry (Terrarium tiles) over the same frame as the Wikimedia map of
// East Timor. No labels, roads or borders: land is green, the sea shows its
// real depth through a glassy surface.

export const MAP_WIDTH = 30;
const LON_SPAN_KM =
  (ISLAND_BOUNDS.lonE - ISLAND_BOUNDS.lonW) * 111.32 * Math.cos((((ISLAND_BOUNDS.latN + ISLAND_BOUNDS.latS) / 2) * Math.PI) / 180);
const LAT_SPAN_KM = (ISLAND_BOUNDS.latN - ISLAND_BOUNDS.latS) * 110.57;
export const MAP_DEPTH = (MAP_WIDTH * LAT_SPAN_KM) / LON_SPAN_KM;
export const SEA_COLOR = new THREE.Color("#1a7fae");

// Vertical exaggeration x4.5 so the mountain spine reads from cruising height.
const UNITS_PER_KM = MAP_WIDTH / LON_SPAN_KM;
const HEIGHT_PER_M = (UNITS_PER_KM / 1000) * 4.5;

/** Map UV (0..1 from the top-left) to world XZ on the terrain. */
export function mapToWorld(u: number, v: number, y = 0, target = new THREE.Vector3()) {
  return target.set((u - 0.5) * MAP_WIDTH, y, (v - 0.5) * MAP_DEPTH);
}

function edgeFade(u: number, v: number) {
  const e = Math.min(u, v, 1 - u, 1 - v);
  return THREE.MathUtils.smoothstep(e, 0.0, 0.05);
}

type Stop = [number, string];
function ramp(stops: Stop[]) {
  const cols = stops.map(([t, c]) => [t, new THREE.Color(c)] as const);
  const out = new THREE.Color();
  return (t: number) => {
    if (t <= cols[0][0]) return out.copy(cols[0][1]);
    for (let i = 1; i < cols.length; i++) {
      if (t <= cols[i][0]) {
        const k = (t - cols[i - 1][0]) / (cols[i][0] - cols[i - 1][0]);
        return out.copy(cols[i - 1][1]).lerp(cols[i][1], k);
      }
    }
    return out.copy(cols[cols.length - 1][1]);
  };
}

// Land: tropical lowland to montane forest. Sea: reef shallows to the deep straits.
const LAND = ramp([
  [0, "#7aa95a"],
  [60, "#5f9a47"],
  [400, "#4a8a3d"],
  [1200, "#3c7336"],
  [2000, "#3f6634"],
  [2800, "#5a6b45"],
]);
const SEA = ramp([
  [0, "#7fd6d2"],
  [15, "#3fb7c4"],
  [80, "#1d8fb6"],
  [400, "#136d9f"],
  [2000, "#0c5287"],
  [5000, "#093f70"],
]);
const SAND = new THREE.Color("#d8c99c");

export type MapTerrain = {
  mesh: THREE.Mesh;
  heightAt: (u: number, v: number) => number;
  dispose: () => void;
};

export function buildMapTerrain(relief: Relief, segments = 380): MapTerrain {
  const { width: W, height: H, heights, sea } = relief;

  // Albedo texture at relief resolution.
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const img = g.createImageData(W, H);
  const c = new THREE.Color();
  const deep = new THREE.Color("#093f70");
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const h = heights[i];
      const n = hash2(x, y, 3) - 0.5;
      if (sea[i]) {
        c.copy(SEA(-h));
      } else {
        // Beaches: low ground touching the sea.
        let coast = false;
        if (h < 8) {
          for (let k = -2; k <= 2 && !coast; k++)
            for (let l = -2; l <= 2; l++) {
              const j = Math.min(H - 1, Math.max(0, y + k)) * W + Math.min(W - 1, Math.max(0, x + l));
              if (sea[j]) {
                coast = true;
                break;
              }
            }
        }
        c.copy(LAND(h));
        // Steep valley sides read darker and a little browner.
        const sx = heights[y * W + Math.min(W - 1, x + 1)] - heights[y * W + Math.max(0, x - 1)];
        const sy = heights[Math.min(H - 1, y + 1) * W + x] - heights[Math.max(0, y - 1) * W + x];
        const slope = Math.hypot(sx, sy) / 600;
        c.multiplyScalar(1 - Math.min(0.22, slope * 0.18));
        if (coast) c.lerp(SAND, 0.75);
      }
      c.multiplyScalar(1 + n * 0.06);
      const fade = edgeFade(x / (W - 1), y / (H - 1));
      if (fade < 1) c.lerp(deep, 1 - fade);
      img.data[i * 4] = Math.round(THREE.MathUtils.clamp(c.r, 0, 1) * 255);
      img.data[i * 4 + 1] = Math.round(THREE.MathUtils.clamp(c.g, 0, 1) * 255);
      img.data[i * 4 + 2] = Math.round(THREE.MathUtils.clamp(c.b, 0, 1) * 255);
      img.data[i * 4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const colorTex = new THREE.CanvasTexture(canvas);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.anisotropy = 8;

  const heightAt = (u: number, v: number) => {
    const m = relief.sample(u * (W - 1), v * (H - 1));
    const fade = edgeFade(u, v);
    const y = m > 0 ? m * HEIGHT_PER_M : Math.max(-0.12, m * HEIGHT_PER_M * 0.12) - 0.012;
    return y * fade - 0.06 * (1 - fade);
  };

  const segX = segments;
  const segZ = Math.round((segments * MAP_DEPTH) / MAP_WIDTH);
  const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_DEPTH, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    // PlaneGeometry uv.y = 1 at the far (-Z) edge, which is the north (top) of the relief.
    pos.setY(i, heightAt(uv.getX(i), 1 - uv.getY(i)));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ map: colorTex, roughness: 0.93, metalness: 0, envMapIntensity: 0.35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  return {
    mesh,
    heightAt,
    dispose() {
      geo.dispose();
      mat.dispose();
      colorTex.dispose();
    },
  };
}
