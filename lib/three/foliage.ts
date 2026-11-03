import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { fbm2 } from "./noise";

// Instancing-ready plant geometry with baked vertex colours, so one draw call
// covers a whole hillside or avenue.

// Every part ends up with exactly position + normal + color, so they merge.
function paint(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  geo.deleteAttribute("uv");
  if (!geo.attributes.normal) geo.computeVertexNormals();
  geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return geo;
}

/** Broadleaf tree, 1 m tall overall (scale per instance): trunk plus a lumpy crown. */
export function createBroadleafGeometry(detail = 1) {
  const lobes: THREE.BufferGeometry[] = [];
  const layout: [number, number, number, number][] = [
    [0, 0.05, 0, 0.82],
    [0.48, -0.08, 0.2, 0.6],
    [-0.42, -0.04, -0.25, 0.64],
  ];
  layout.forEach(([ox, oy, oz, r], li) => {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute("normal");
    g.deleteAttribute("uv");
    g = mergeVertices(g);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const k = 0.82 + fbm2(v.x * 2.4 + li * 7, v.z * 2.4 + v.y * 1.9, 3, 4) * 0.38;
      v.multiplyScalar(k * r);
      v.y *= 0.74;
      p.setXYZ(i, v.x + ox, v.y + oy, v.z + oz);
    }
    g.computeVertexNormals();
    lobes.push(paint(g, "#ffffff"));
  });
  const crown = mergeGeometries(lobes)!;
  lobes.forEach((g) => g.dispose());
  // Self-shading baked into the colours: a darker underside, a sunlit top and
  // a little leaf-cluster variation, multiplied by each instance's own green.
  {
    const p = crown.attributes.position as THREE.BufferAttribute;
    const col = crown.attributes.color as THREE.BufferAttribute;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < p.count; i++) {
      y0 = Math.min(y0, p.getY(i));
      y1 = Math.max(y1, p.getY(i));
    }
    for (let i = 0; i < p.count; i++) {
      const t = (p.getY(i) - y0) / (y1 - y0 || 1);
      const n = fbm2(p.getX(i) * 5 + 3, p.getZ(i) * 5 + p.getY(i) * 3, 2, 8);
      const k = 0.55 + 0.6 * t * t + (n - 0.5) * 0.25;
      col.setXYZ(i, k, k * 1.02, k * 0.92);
    }
  }
  // Crown sits on top of a 1-unit trunk; whole tree normalised to height 1.
  crown.scale(0.32, 0.32, 0.32);
  crown.translate(0, 0.72, 0);
  const trunk = new THREE.CylinderGeometry(0.025, 0.04, 0.6, 5, 1, true);
  trunk.translate(0, 0.3, 0);
  const trunkPainted = paint(trunk.toNonIndexed(), "#5a4634");
  trunk.dispose();
  const crownNI = crown.index ? crown.toNonIndexed() : crown;
  if (crownNI !== crown) crown.dispose();
  const geo = mergeGeometries([trunkPainted, crownNI])!;
  trunkPainted.dispose();
  crownNI.dispose();
  return geo;
}

/** Coconut palm, 1 m tall: a leaning, tapering trunk and a crown of drooping fronds. */
export function createPalmGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0.02, 0.35, 0),
    new THREE.Vector3(0.07, 0.7, 0),
    new THREE.Vector3(0.12, 0.93, 0),
  ]);
  const trunk = new THREE.TubeGeometry(curve, 10, 0.018, 6, false);
  parts.push(paint(trunk.toNonIndexed(), "#8a7660"));
  trunk.dispose();
  const top = curve.getPoint(1);
  const fronds = 9;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + (f % 2) * 0.2;
    const len = 0.34 + (f % 3) * 0.03;
    // A frond is a narrow strip arching up and drooping down.
    const seg = 8;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const r = t * len;
      const y = Math.sin(t * Math.PI * 0.85) * 0.07 - t * t * 0.16;
      const w = Math.sin(t * Math.PI) * 0.045 + 0.004;
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const px = -Math.sin(a) * w;
      const pz = Math.cos(a) * w;
      pos.push(top.x + cx - px, top.y + y, top.z + cz - pz, top.x + cx + px, top.y + y - 0.012, top.z + cz + pz);
      if (i < seg) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const ni = g.toNonIndexed();
    g.dispose();
    parts.push(paint(ni, f % 2 ? "#4f7d33" : "#5d8a3a"));
  }
  const geo = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return geo;
}

/** Slim cypress / columnar conifer, 1 m tall. */
export function createCypressGeometry() {
  const g = new THREE.SphereGeometry(0.5, 8, 10);
  g.scale(0.22, 1, 0.22);
  g.translate(0, 0.5, 0);
  const ni = g.toNonIndexed();
  g.dispose();
  return paint(ni, "#2f5530");
}
