import * as THREE from "three";

// Turns the flat Wikimedia relief map (East_Timor_map_mhn.jpg, public domain)
// into a lit 3D terrain: the colour tells us land vs. sea, and the hypsometric
// tint (green lowland -> tan highland) gives an elevation estimate.

export const MAP_WIDTH = 30;
export const MAP_ASPECT = 2313 / 2975;
export const MAP_DEPTH = MAP_WIDTH * MAP_ASPECT;
export const SEA_COLOR = new THREE.Color("#7fd0ec");
const HEIGHT_SCALE = 0.75;

/** Map image UV (0..1 from top-left) to world XZ on the terrain. */
export function mapToWorld(u: number, v: number, y = 0, target = new THREE.Vector3()) {
  return target.set((u - 0.5) * MAP_WIDTH, y, (v - 0.5) * MAP_DEPTH);
}

function boxBlur(src: Float32Array, weight: Float32Array, w: number, h: number, radius: number) {
  const tmpV = new Float32Array(w * h);
  const tmpW = new Float32Array(w * h);
  const outV = new Float32Array(w * h);
  // Horizontal pass, weighted so unknown pixels (map labels) borrow from neighbours.
  for (let y = 0; y < h; y++) {
    let sv = 0;
    let sw = 0;
    for (let x = -radius; x <= radius; x++) {
      const i = y * w + Math.min(w - 1, Math.max(0, x));
      sv += src[i] * weight[i];
      sw += weight[i];
    }
    for (let x = 0; x < w; x++) {
      tmpV[y * w + x] = sv;
      tmpW[y * w + x] = sw;
      const add = y * w + Math.min(w - 1, x + radius + 1);
      const rem = y * w + Math.max(0, x - radius);
      sv += src[add] * weight[add] - src[rem] * weight[rem];
      sw += weight[add] - weight[rem];
    }
  }
  for (let x = 0; x < w; x++) {
    let sv = 0;
    let sw = 0;
    for (let y = -radius; y <= radius; y++) {
      const i = Math.min(h - 1, Math.max(0, y)) * w + x;
      sv += tmpV[i];
      sw += tmpW[i];
    }
    for (let y = 0; y < h; y++) {
      outV[y * w + x] = sw > 1e-5 ? sv / sw : 0;
      const add = Math.min(h - 1, y + radius + 1) * w + x;
      const rem = Math.max(0, y - radius) * w + x;
      sv += tmpV[add] - tmpV[rem];
      sw += tmpW[add] - tmpW[rem];
    }
  }
  return outV;
}

function edgeFade(u: number, v: number) {
  const e = Math.min(u, v, 1 - u, 1 - v);
  return THREE.MathUtils.smoothstep(e, 0.0, 0.07);
}

export type MapTerrain = {
  mesh: THREE.Mesh;
  heightAt: (u: number, v: number) => number;
  dispose: () => void;
};

export function buildMapTerrain(image: HTMLImageElement, segments = 420): MapTerrain {
  // Colour texture: the original map with its borders feathered into open sea,
  // so the edge of the image never reads as the edge of the world.
  const texW = Math.min(4096, image.naturalWidth || 2048);
  const texH = Math.round(texW * MAP_ASPECT);
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = texW;
  colorCanvas.height = texH;
  const cg = colorCanvas.getContext("2d")!;
  cg.drawImage(image, 0, 0, texW, texH);
  const sea = `#${SEA_COLOR.getHexString()}`;
  const fade = 0.07;
  const grads: [number, number, number, number][] = [
    [0, 0, texW * fade, 0],
    [texW, 0, texW * (1 - fade), 0],
    [0, 0, 0, texH * fade],
    [0, texH, 0, texH * (1 - fade)],
  ];
  for (const [x0, y0, x1, y1] of grads) {
    const g = cg.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, sea);
    g.addColorStop(1, "rgba(127,208,236,0)");
    cg.fillStyle = g;
    cg.fillRect(0, 0, texW, texH);
  }
  const colorTex = new THREE.CanvasTexture(colorCanvas);
  colorTex.colorSpace = THREE.SRGBColorSpace;
  colorTex.anisotropy = 8;

  // Elevation field at reduced resolution.
  const w = 640;
  const h = Math.round(w * MAP_ASPECT);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(image, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const land = new Float32Array(w * h);
  const elev = new Float32Array(w * h);
  const weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4];
    const gr = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    const lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    const isLabel = lum < 70; // black text, dots and borders: let neighbours decide
    const isLand = gr > b + 10 || r > b + 30;
    land[i] = isLand ? 1 : 0;
    elev[i] = isLand ? THREE.MathUtils.clamp((r - 125) / 105, 0, 1) : 0;
    weight[i] = isLabel ? 0 : 1;
  }
  const landSoft = boxBlur(land, weight, w, h, 5);
  const elevSoft = boxBlur(elev, weight, w, h, 4);
  const heights = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const coast = THREE.MathUtils.smoothstep(landSoft[i], 0.2, 0.9);
      const fadeK = edgeFade(x / (w - 1), y / (h - 1));
      heights[i] = (coast * (0.06 + 0.94 * Math.pow(elevSoft[i], 1.25)) * HEIGHT_SCALE - (1 - coast) * 0.06) * fadeK;
    }
  }

  const heightAt = (u: number, v: number) => {
    const fx = THREE.MathUtils.clamp(u, 0, 1) * (w - 1);
    const fy = THREE.MathUtils.clamp(v, 0, 1) * (h - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = heights[y0 * w + x0];
    const b = heights[y0 * w + x1];
    const cc = heights[y1 * w + x0];
    const d = heights[y1 * w + x1];
    return a + (b - a) * tx + (cc - a) * ty + (a - b - cc + d) * tx * ty;
  };

  const segX = segments;
  const segZ = Math.round(segments * MAP_ASPECT);
  const geo = new THREE.PlaneGeometry(MAP_WIDTH, MAP_DEPTH, segX, segZ);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    // PlaneGeometry uv.y = 1 at the far (-Z) edge, which is the top of the image.
    pos.setY(i, heightAt(uv.getX(i), 1 - uv.getY(i)));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    map: colorTex,
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: 0.3,
  });
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
