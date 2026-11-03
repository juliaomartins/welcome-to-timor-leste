import * as THREE from "three";
import { CRISTO_REI, toDili } from "../geo";
import type { TierSettings } from "./deviceTier";
import { assembleDiliCity, fetchDiliCity, type DiliCity, type DiliCityData } from "./diliCity";

// One Dili for the whole page. The intro builds it (worker, then assembly
// behind the cloud veil) and flies over it; the home page then adopts the very
// same objects, so the city is downloaded and built exactly once.

let dataPromise: Promise<DiliCityData> | null = null;
const listeners = new Set<(p: number) => void>();
let city: DiliCity | null = null;

/** Stage one, off the main thread. Safe to call repeatedly; the worker runs once. */
export function fetchSharedDili(settings: TierSettings, onProgress?: (p: number) => void) {
  if (onProgress) listeners.add(onProgress);
  if (!dataPromise) {
    dataPromise = fetchDiliCity({ settings, onProgress: (p) => listeners.forEach((l) => l(p)) }).catch((err) => {
      dataPromise = null;
      throw err;
    });
  }
  return dataPromise;
}

/** Stage two, on the main thread (about a second), also only once. */
export async function getSharedDili(settings: TierSettings): Promise<DiliCity> {
  if (city) return city;
  const data = await fetchSharedDili(settings);
  if (!city) city = assembleDiliCity(data, settings);
  return city;
}

export function sharedDiliIfReady() {
  return city;
}

/** Cristo Rei's exact site: the Google Maps pin, on the highest ground within a few metres. */
export function statueSite(c: DiliCity) {
  const [x, z] = toDili(CRISTO_REI);
  let top = -Infinity;
  for (let a = 0; a < 12; a++) for (const r of [0, 6, 12]) top = Math.max(top, c.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
  return new THREE.Vector3(x, top, z);
}

/** The stone platform the monument stands on, sized to the 27 m statue. */
export function createStatuePlaza() {
  const geo = new THREE.CylinderGeometry(7.5, 9, 3, 32);
  const mat = new THREE.MeshStandardMaterial({ color: "#a59c8d", roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
