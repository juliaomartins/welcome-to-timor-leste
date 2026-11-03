import { CRISTO_REI, DILI_BOUNDS, DILI_FAR_BOUNDS, diliBoundsXZ, toDili } from "../geo";
import type { Relief } from "./relief";

// Pure geometry and height queries for Dili, shared by the build worker and
// the main thread (no DOM, no WebGL).

export type Ring = [number, number][];
export type Lake = { n: string; p: Ring; level: number; box: Box };
export type Box = { x0: number; x1: number; z0: number; z1: number };
export type PalaceFrameData = { cx: number; cz: number; angle: number; ground: number; depth: number; halfWidth: number };

export const NEAR = diliBoundsXZ(DILI_BOUNDS);
export const FAR = diliBoundsXZ(DILI_FAR_BOUNDS);

// Cape Fatucama gets a finer terrain patch (4 m) because the finale is filmed
// close to Cristo Rei; the coarse terrain is dropped out of sight beneath it.
const [CR_X, CR_Z] = toDili(CRISTO_REI);
export const CAPE_PATCH = { cx: CR_X + 260, cz: CR_Z + 240, size: 1700, step: 4 };
export function inCapeHole(x: number, z: number) {
  const h = CAPE_PATCH.size / 2 - 40;
  return Math.abs(x - CAPE_PATCH.cx) < h && Math.abs(z - CAPE_PATCH.cz) < h;
}

export function pointInRing(x: number, z: number, ring: Ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringBox(ring: Ring): Box {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return { x0, x1, z0, z1 };
}

export function palaceToLocal(p: PalaceFrameData, x: number, z: number): [number, number] {
  const c = Math.cos(p.angle);
  const s = Math.sin(p.angle);
  const dx = x - p.cx;
  const dz = z - p.cz;
  return [dx * c - dz * s, dx * s + dz * c];
}

export function palaceToWorld(p: PalaceFrameData, lx: number, lz: number): [number, number] {
  const c = Math.cos(p.angle);
  const s = Math.sin(p.angle);
  return [p.cx + lx * c + lz * s, p.cz - lx * s + lz * c];
}

export function createHeightField(near: Relief, far: Relief) {
  const gridOf = (r: Relief, b: typeof NEAR, x: number, z: number) =>
    [((x - b.xW) / (b.xE - b.xW)) * r.width - 0.5, ((z - b.zN) / (b.zS - b.zN)) * r.height - 0.5] as const;
  const insideNear = (x: number, z: number) => x > NEAR.xW && x < NEAR.xE && z > NEAR.zN && z < NEAR.zS;
  const raw = (x: number, z: number) => {
    if (insideNear(x, z)) return near.sample(...gridOf(near, NEAR, x, z));
    const h = far.sample(...gridOf(far, FAR, x, z));
    return h <= 0 ? -8 : h;
  };
  const sea = (x: number, z: number) => {
    if (!insideNear(x, z)) return raw(x, z) <= 0;
    const [gx, gy] = gridOf(near, NEAR, x, z);
    const i = Math.round(Math.min(near.height - 1, Math.max(0, gy))) * near.width + Math.round(Math.min(near.width - 1, Math.max(0, gx)));
    return near.sea[i] === 1;
  };
  const farRaw = (x: number, z: number) => far.sample(...gridOf(far, FAR, x, z));
  return { raw, sea, farRaw, insideNear };
}

export type Sculpt = {
  palace: PalaceFrameData;
  lakes: Lake[];
};

/** Terrain height after the palace pad and the lake beds are sculpted in. */
export function sculptedHeight(field: ReturnType<typeof createHeightField>, s: Sculpt) {
  const inPalace = (x: number, z: number, pad = 0) => {
    const [lx, lz] = palaceToLocal(s.palace, x, z);
    return Math.abs(lx) < s.palace.halfWidth + 4 + pad && lz > -18 - pad && lz < s.palace.depth + 6 + pad;
  };
  const lakeAt = (x: number, z: number) => {
    for (const l of s.lakes) {
      if (x < l.box.x0 || x > l.box.x1 || z < l.box.z0 || z > l.box.z1) continue;
      if (pointInRing(x, z, l.p)) return l;
    }
    return null;
  };
  const heightAt = (x: number, z: number) => {
    if (inPalace(x, z)) return s.palace.ground;
    const lake = lakeAt(x, z);
    if (lake) return lake.level - 2;
    return field.raw(x, z);
  };
  return { heightAt, inPalace, lakeAt };
}
