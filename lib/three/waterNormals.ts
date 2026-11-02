import * as THREE from "three";
import { seededRandom } from "./noise";

// Tileable ocean normal map built from integer-frequency sine waves, so it
// repeats seamlessly without shipping a texture file.
export function createWaterNormals(size = 512, seed = 7): THREE.DataTexture {
  const rand = seededRandom(seed);
  const waves = Array.from({ length: 28 }, () => {
    const a = Math.round((rand() * 2 - 1) * 14);
    const b = Math.round((rand() * 2 - 1) * 14);
    const freq = Math.max(1, Math.hypot(a, b));
    return { a, b, amp: 0.9 / Math.pow(freq, 1.15), phase: rand() * Math.PI * 2 };
  });

  const data = new Uint8Array(size * size * 4);
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const c = Math.cos(TAU * (w.a * u + w.b * v) + w.phase) * w.amp * TAU;
        dx += c * w.a;
        dy += c * w.b;
      }
      const s = 0.035;
      const n = new THREE.Vector3(-dx * s, -dy * s, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
