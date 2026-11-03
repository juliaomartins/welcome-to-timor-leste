import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// The owner's Cristo Rei of Dili model, loaded once and shared by every scene.
// The mesh and its texture are used exactly as supplied; only the material is
// upgraded to weathered copper. The prepared model is normalised to a height of
// 1, centred, with its base on y = 0; scenes clone and scale it.

export const STATUE_URL = "/Cristo%20Rei%20of%20Dili%20Timor-Leste.glb";

let pending: Promise<THREE.Group> | null = null;
const listeners = new Set<(p: number) => void>();

export function loadCristoRei(onProgress?: (p: number) => void): Promise<THREE.Group> {
  if (onProgress) listeners.add(onProgress);
  if (!pending) {
    pending = new GLTFLoader()
      .loadAsync(STATUE_URL, (e) => {
        if (e.lengthComputable && e.total > 0) listeners.forEach((l) => l(e.loaded / e.total));
      })
      .then((gltf) => {
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const s = 1 / size.y;
        const root = new THREE.Group();
        model.scale.setScalar(s);
        model.position.set(-center.x * s, -box.min.y * s, -center.z * s);
        root.add(model);
        model.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          const old = mesh.material as THREE.MeshStandardMaterial;
          const map = old.map;
          if (map) {
            map.colorSpace = THREE.SRGBColorSpace;
            map.anisotropy = 8;
          }
          // Weathered copper: the baked texture becomes the patina colour, and its
          // brightness doubles as roughness (chalky light patina, polished dark metal).
          mesh.material = new THREE.MeshPhysicalMaterial({
            map,
            roughnessMap: map,
            roughness: 1.0,
            metalness: 0.28,
            bumpMap: map,
            bumpScale: 0.6,
            clearcoat: 0.18,
            clearcoatRoughness: 0.45,
            envMapIntensity: 1.5,
            side: THREE.DoubleSide,
          });
          old.dispose();
        });
        listeners.forEach((l) => l(1));
        listeners.clear();
        return root;
      })
      .catch((err) => {
        pending = null;
        throw err;
      });
  }
  return pending;
}

/** A scene-owned instance: shares geometry and material with the cached model. */
export async function createCristoRei(height: number, onProgress?: (p: number) => void) {
  const source = await loadCristoRei(onProgress);
  const statue = source.clone(true);
  statue.scale.setScalar(height);
  return statue;
}
