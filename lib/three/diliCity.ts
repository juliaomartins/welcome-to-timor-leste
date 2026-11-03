import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { TierSettings } from "./deviceTier";
import { CAPE_PATCH, createHeightField, FAR, NEAR, sculptedHeight, type PalaceFrameData } from "./diliCore";
import { fbm2, seededRandom } from "./noise";
import type { CityPayload } from "./diliCity.worker";
import { createBroadleafGeometry, createCypressGeometry, createPalmGeometry } from "./foliage";
import { buildGovernmentPalace, planGovernmentPalace } from "./governmentPalace";
import type { Relief } from "./relief";
import { createWaterNormals } from "./waterNormals";

// Dili at true scale (metres), assembled from real data:
// - terrain: Terrarium elevation (SRTM) with the OpenStreetMap coastline baked in
// - buildings, roads, rivers, land use, the Tasi Tolu lakes: OpenStreetMap (ODbL)
// - Government Palace: OSM footprint position and orientation, modelled from the references
// The heavy lifting happens in diliCity.worker.ts; this file only wraps the
// results in GPU objects. Local frame: origin at the Government Palace pin,
// x east, z south, y up.

export type DiliCity = {
  group: THREE.Group;
  heightAt: (x: number, z: number) => number;
  palace: PalaceFrameData;
  lakeCenters: THREE.Vector3[];
  stats: Record<string, number>;
  /** Moves the traffic and rocks the moored boats. */
  update: (time: number) => void;
  dispose: () => void;
};

function reliefFrom(r: CityPayload["near"]): Relief {
  const { width: W, height: H, heights } = r;
  return {
    ...r,
    sample(gx, gy) {
      const x = Math.min(W - 1.001, Math.max(0, gx));
      const y = Math.min(H - 1.001, Math.max(0, gy));
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const i = y0 * W + x0;
      const a = heights[i], b = heights[i + 1], c = heights[i + W], d = heights[i + W + 1];
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    },
  };
}

function runWorker(settings: TierSettings, onProgress?: (p: number) => void, signal?: AbortSignal) {
  return new Promise<CityPayload>((resolve, reject) => {
    const worker = new Worker(new URL("./diliCity.worker.ts", import.meta.url), { type: "module" });
    // A disposed scene must not leave a worker burning CPU in the background.
    signal?.addEventListener("abort", () => {
      worker.terminate();
      reject(new DOMException("aborted", "AbortError"));
    });
    worker.onmessage = (e: MessageEvent<{ type: string; p?: number; payload?: CityPayload; message?: string }>) => {
      if (e.data.type === "progress") onProgress?.(e.data.p ?? 0);
      else if (e.data.type === "done") {
        worker.terminate();
        resolve(e.data.payload!);
      } else {
        worker.terminate();
        reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ settings });
  });
}

function gridGeometry(b: typeof NEAR, grid: { segX: number; segZ: number; y: Float32Array; normal: Float32Array }) {
  const geo = new THREE.PlaneGeometry(b.xE - b.xW, b.zS - b.zN, grid.segX, grid.segZ);
  geo.rotateX(-Math.PI / 2);
  geo.translate((b.xW + b.xE) / 2, 0, (b.zN + b.zS) / 2);
  const p = geo.attributes.position as THREE.BufferAttribute;
  // PlaneGeometry's vertex order matches the worker's grid: rows north to south, columns west to east.
  for (let i = 0; i < p.count; i++) p.setY(i, grid.y[i]);
  geo.setAttribute("normal", new THREE.BufferAttribute(grid.normal, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** Tileable value-noise texture for close-range ground grain. */
function detailTexture(size = 256) {
  // Integer-frequency waves tile seamlessly; random phases make it read as grain.
  const rand = seededRandom(13);
  const waves = Array.from({ length: 40 }, () => {
    const a = Math.round((rand() * 2 - 1) * 24);
    const b = Math.round((rand() * 2 - 1) * 24);
    return { a, b, amp: 1 / Math.max(1, Math.hypot(a, b)), ph: rand() * Math.PI * 2 };
  });
  const norm = waves.reduce((s2, w) => s2 + w.amp, 0);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (const w of waves) n += Math.sin(((w.a * x + w.b * y) / size) * Math.PI * 2 + w.ph) * w.amp;
      const v = 0.5 + (n / norm) * 1.6;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(Math.min(1, Math.max(0, v)) * 255);
      data[i + 3] = 255;
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** Adds world-space grain to the painted ground, faded out with distance. */
function addGroundDetail(mat: THREE.MeshStandardMaterial, detail: THREE.Texture) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: detail };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;\nuniform sampler2D uDetail;")
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float camDist = length(vWorldPos - cameraPosition);
        float grain = texture2D(uDetail, vWorldPos.xz / 23.0).r * 0.6 + texture2D(uDetail, vWorldPos.xz / 5.7).r * 0.4;
        diffuseColor.rgb *= mix(0.78 + grain * 0.44, 1.0, smoothstep(250.0, 1400.0, camDist));`,
      );
  };
  mat.customProgramCacheKey = () => "dili-ground-detail";
}

/**
 * Facades without extra geometry: windows and floor lines are drawn in the
 * fragment shader from world position on wall faces, and fade to a flat tint
 * once they are too small to resolve (so nothing shimmers from the air).
 */
function addFacades(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWorldPos;\nfloat glassMask = 0.0;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec3 wn = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
        float wall = 1.0 - smoothstep(0.35, 0.6, abs(wn.y));
        vec2 along = normalize(vec2(-wn.z, wn.x) + 1e-5);
        float u = dot(vWorldPos.xz, along) / 3.1;
        float v = vWorldPos.y / 3.3;
        float fw = max(fwidth(u), fwidth(v));
        float resolve = 1.0 - smoothstep(0.25, 0.6, fw);
        vec2 cell = fract(vec2(u, v));
        float win = step(0.22, cell.x) * step(cell.x, 0.78) * step(0.32, cell.y) * step(cell.y, 0.78);
        float band = 1.0 - step(0.06, cell.y);
        glassMask = win * wall * resolve;
        vec3 glass = mix(vec3(0.10, 0.14, 0.18), vec3(0.32, 0.40, 0.46), cell.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, glassMask);
        diffuseColor.rgb *= 1.0 - band * wall * resolve * 0.18;
        // Far away, windows average into a slightly darker wall.
        diffuseColor.rgb *= mix(1.0, 0.86, wall * (1.0 - resolve));`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.12, glassMask);`,
      );
  };
  mat.customProgramCacheKey = () => "dili-facades";
}

function carGeometry() {
  // A small car or minibus: body, glasshouse and dark wheels, 1 m long (scaled per instance).
  const body = new THREE.BoxGeometry(1, 0.32, 0.43);
  body.translate(0, 0.25, 0);
  const cabin = new THREE.BoxGeometry(0.55, 0.22, 0.4);
  cabin.translate(-0.05, 0.52, 0);
  const parts = [body, cabin].map((g, i) => {
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3).fill(i === 0 ? 1 : 0.25);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.deleteAttribute("uv");
    return g.toNonIndexed();
  });
  const geo = mergeGeometries(parts)!;
  parts.forEach((p) => p.dispose());
  return geo;
}

function boatGeometry() {
  // Fishing boat / small yacht: a tapered hull and a low cabin, 1 m long.
  const hull = new THREE.CylinderGeometry(0.16, 0.1, 1, 10, 1);
  hull.rotateZ(Math.PI / 2);
  hull.scale(1, 0.7, 1);
  const p = hull.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    if (x > 0.3) p.setZ(i, p.getZ(i) * (1 - (x - 0.3) * 1.6)); // pointed bow
  }
  hull.computeVertexNormals();
  const cabin = new THREE.BoxGeometry(0.28, 0.12, 0.16);
  cabin.translate(-0.1, 0.14, 0);
  const parts = [hull, cabin].map((g) => {
    const n = g.attributes.position.count;
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    g.deleteAttribute("uv");
    return g.index ? g.toNonIndexed() : g;
  });
  const geo = mergeGeometries(parts)!;
  parts.forEach((pp) => pp.dispose());
  return geo;
}

/** Stage one, off the main thread: the worker builds every buffer. */
export function fetchDiliCity(opts: { settings: TierSettings; onProgress?: (p: number) => void; signal?: AbortSignal }) {
  return runWorker(opts.settings, opts.onProgress, opts.signal);
}

export type DiliCityData = CityPayload;

/** Stage two, on the main thread (about a second): wrap the buffers in GPU objects. */
export function assembleDiliCity(data: CityPayload, s: TierSettings): DiliCity {
  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(o: T) => (disposables.push(o), o);
  const group = new THREE.Group();
  group.name = "Dili";
  const shadows = s.shadowMap > 0;

  const field = createHeightField(reliefFrom(data.near), reliefFrom(data.far));
  const { heightAt } = sculptedHeight(field, { palace: data.palace, lakes: data.lakes });

  // Terrain: detailed core with the painted ground, coarse ring around it.
  const groundTex = track(new THREE.Texture(data.ground));
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = s.tier === "low" ? 4 : 16;
  // ImageBitmaps upload without flipY; flip through the UV transform instead.
  groundTex.flipY = false;
  groundTex.repeat.set(1, -1);
  groundTex.offset.set(0, 1);
  groundTex.needsUpdate = true;
  disposables.push({ dispose: () => data.ground.close() });
  const detail = track(detailTexture());
  const groundMat = track(new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.96, metalness: 0, envMapIntensity: 0.5 }));
  addGroundDetail(groundMat, detail);
  const nearMesh = new THREE.Mesh(track(gridGeometry(NEAR, data.terrain)), groundMat);
  nearMesh.receiveShadow = shadows;
  group.add(nearMesh);

  // Cape Fatucama at 4-9 m: same ground texture, with a little rocky relief on
  // the steep sides so the finale's close-ups hold up.
  {
    const { cx, cz, size } = CAPE_PATCH;
    const seg = Math.round(size / s.capeStep);
    const geo = track(new THREE.PlaneGeometry(size, size, seg, seg));
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, 0, cz);
    const p = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const nearW = NEAR.xE - NEAR.xW;
    const nearD = NEAR.zS - NEAR.zN;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const h = heightAt(x, z);
      const e = 3;
      const slope = Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
      const rock = h > 1 ? (fbm2(x * 0.06, z * 0.06, 4, 17) - 0.5) * 3 * Math.min(1, slope) : 0;
      p.setY(i, h + rock);
      // Ground-texture UVs, matching the main terrain (v = 1 at the north edge).
      uv.setXY(i, (x - NEAR.xW) / nearW, 1 - (z - NEAR.zN) / nearD);
    }
    geo.computeVertexNormals();
    const cape = new THREE.Mesh(geo, groundMat);
    cape.receiveShadow = shadows;
    cape.castShadow = shadows;
    group.add(cape);
  }
  const farGeo = track(gridGeometry(FAR, data.farTerrain));
  farGeo.setAttribute("color", new THREE.BufferAttribute(data.farTerrain.color, 3));
  group.add(new THREE.Mesh(farGeo, track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, envMapIntensity: 0.45 }))));

  // Tasi Tolu: three saline lakes, water at their real shorelines.
  const lakeNormals = track(createWaterNormals(256, 11));
  lakeNormals.repeat.set(0.08, 0.08);
  const lakeMat = track(
    new THREE.MeshStandardMaterial({
      color: "#2a6f6b",
      roughness: 0.1,
      metalness: 0.05,
      envMapIntensity: 0.8,
      normalMap: lakeNormals,
      normalScale: new THREE.Vector2(0.12, 0.12),
    }),
  );
  const lakeCenters: THREE.Vector3[] = [];
  for (const l of data.lakes) {
    const shape = new THREE.Shape(l.p.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = track(new THREE.ShapeGeometry(shape, 2));
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, lakeMat);
    mesh.position.y = l.level;
    mesh.receiveShadow = shadows;
    group.add(mesh);
    lakeCenters.push(new THREE.Vector3((l.box.x0 + l.box.x1) / 2, l.level, (l.box.z0 + l.box.z1) / 2));
  }

  // OpenStreetMap buildings in one flat-shaded draw call, with shader facades.
  const bGeo = track(new THREE.BufferGeometry());
  bGeo.setAttribute("position", new THREE.BufferAttribute(data.buildings.position, 3));
  bGeo.setAttribute("color", new THREE.BufferAttribute(data.buildings.color, 3, true));
  bGeo.setIndex(new THREE.BufferAttribute(data.buildings.index, 1));
  bGeo.computeBoundingSphere();
  const buildingMat = track(
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.82, metalness: 0.02, side: THREE.DoubleSide }),
  );
  addFacades(buildingMat);
  const buildings = new THREE.Mesh(bGeo, buildingMat);
  buildings.castShadow = shadows;
  buildings.receiveShadow = shadows;
  group.add(buildings);

  // Government Palace on its real footprint, facing the sea.
  const palace = buildGovernmentPalace(planGovernmentPalace(data.palace.depth));
  palace.group.position.set(data.palace.cx, data.palace.ground, data.palace.cz);
  palace.group.rotation.y = data.palace.angle;
  if (!shadows) palace.group.traverse((o) => ((o as THREE.Mesh).castShadow = (o as THREE.Mesh).receiveShadow = false));
  group.add(palace.group);
  disposables.push(palace);

  // Vegetation from the worker's placements.
  const vegMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const treeCount = data.trees.length / 19;
  const trees = new THREE.InstancedMesh(track(createBroadleafGeometry(0)), vegMat, Math.max(1, treeCount));
  for (let i = 0; i < treeCount; i++) {
    m.fromArray(data.trees, i * 19);
    trees.setMatrixAt(i, m);
    trees.setColorAt(i, c.fromArray(data.trees, i * 19 + 16));
  }
  trees.count = treeCount;
  trees.castShadow = shadows;
  trees.receiveShadow = shadows;
  const instanced = (geo: THREE.BufferGeometry, mats: Float32Array, stride = 16) => {
    const n = Math.floor(mats.length / stride);
    const mesh = new THREE.InstancedMesh(track(geo), vegMat, Math.max(1, n));
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, m.fromArray(mats, i * stride));
    mesh.count = n;
    mesh.castShadow = shadows;
    return mesh;
  };
  group.add(trees, instanced(createPalmGeometry(), data.palms), instanced(createCypressGeometry(), data.cypress));

  // Boats moored off the seafront (see the palace reference), rocking gently.
  const boatMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
  const boatCount = Math.floor(data.boats.length / 17);
  const boats = new THREE.InstancedMesh(track(boatGeometry()), boatMat, Math.max(1, boatCount));
  const boatBase: THREE.Matrix4[] = [];
  const hullColors = ["#f6f6f2", "#f6f6f2", "#f6f6f2", "#2f6fa5", "#c94a3a", "#e2b33d"].map((h) => new THREE.Color(h));
  for (let i = 0; i < boatCount; i++) {
    const base = new THREE.Matrix4().fromArray(data.boats, i * 17);
    boatBase.push(base);
    boats.setMatrixAt(i, base);
    boats.setColorAt(i, hullColors[Math.floor(data.boats[i * 17 + 16] * hullColors.length) % hullColors.length]);
  }
  boats.count = boatCount;
  boats.castShadow = shadows;
  group.add(boats);

  // Traffic on the main roads, driving on the left as in Timor-Leste.
  const lanePts = data.lanes.points;
  const laneInfo = data.lanes.info;
  const cars = data.lanes.cars;
  const carCount = Math.floor(cars.length / 7);
  const laneCum: Float32Array[] = [];
  for (let l = 0; l < laneInfo.length / 3; l++) {
    const first = laneInfo[l * 3];
    const n = laneInfo[l * 3 + 1];
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const a = (first + i - 1) * 3;
      const b = (first + i) * 3;
      cum[i] = cum[i - 1] + Math.hypot(lanePts[b] - lanePts[a], lanePts[b + 2] - lanePts[a + 2]);
    }
    laneCum.push(cum);
  }
  const carMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.3 }));
  const carMesh = new THREE.InstancedMesh(track(carGeometry()), carMat, Math.max(1, carCount));
  for (let i = 0; i < carCount; i++) carMesh.setColorAt(i, c.setRGB(cars[i * 7 + 4], cars[i * 7 + 5], cars[i * 7 + 6]));
  carMesh.count = carCount;
  carMesh.frustumCulled = false;
  group.add(carMesh);
  const carPos = new THREE.Vector3();
  const carQuat = new THREE.Quaternion();
  const carScale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const rand = seededRandom(5);
  const carLen = Array.from({ length: carCount }, () => 4.2 + rand() * 1.6);
  const roll = new THREE.Matrix4();

  const update = (time: number) => {
    for (let i = 0; i < carCount; i++) {
      const lane = cars[i * 7];
      const cum = laneCum[lane];
      const len = cum[cum.length - 1];
      if (!len) continue;
      const dir = cars[i * 7 + 3];
      let sPos = (cars[i * 7 + 1] + dir * cars[i * 7 + 2] * time) % len;
      if (sPos < 0) sPos += len;
      // Binary search for the segment.
      let lo = 0;
      let hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= sPos) lo = mid;
        else hi = mid;
      }
      const first = laneInfo[lane * 3];
      const a = (first + lo) * 3;
      const b = (first + hi) * 3;
      const t = (sPos - cum[lo]) / Math.max(0.001, cum[hi] - cum[lo]);
      const dx = (lanePts[b] - lanePts[a]) * dir;
      const dz = (lanePts[b + 2] - lanePts[a + 2]) * dir;
      const dl = Math.hypot(dx, dz) || 1;
      // Keep left: offset 2 m to the left of the direction of travel.
      carPos.set(
        lanePts[a] + (lanePts[b] - lanePts[a]) * t + (dz / dl) * 2,
        lanePts[a + 1] + (lanePts[b + 1] - lanePts[a + 1]) * t + 0.05,
        lanePts[a + 2] + (lanePts[b + 2] - lanePts[a + 2]) * t - (dx / dl) * 2,
      );
      carQuat.setFromAxisAngle(up, Math.atan2(-dz, dx));
      const L = carLen[i];
      m.compose(carPos, carQuat, carScale.set(L, L * 0.95, L));
      carMesh.setMatrixAt(i, m);
    }
    carMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < boatCount; i++) {
      const phase = data.boats[i * 17 + 16] * 40;
      m.copy(boatBase[i]);
      m.multiply(roll.makeRotationX(Math.sin(time * 0.9 + phase) * 0.04));
      m.elements[13] += Math.sin(time * 1.1 + phase) * 0.12;
      boats.setMatrixAt(i, m);
    }
    boats.instanceMatrix.needsUpdate = true;
  };
  update(0);

  return {
    group,
    heightAt,
    palace: data.palace,
    lakeCenters,
    stats: data.stats,
    update,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

// Regenerates public/data/dili-ground.jpg: paints the ground texture from the OSM
// layers in the worker and returns it as JPEG bytes. Wired to ?bake=ground in
// development (see SplashFlight); run it after refreshing the OSM data.
export function bakeDiliGround(settings: TierSettings): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./diliCity.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ type: string; jpeg?: ArrayBuffer; message?: string }>) => {
      if (e.data.type === "baked") {
        worker.terminate();
        resolve(e.data.jpeg!);
      } else if (e.data.type === "error") {
        worker.terminate();
        reject(new Error(e.data.message));
      }
    };
    // Every building contributes to the ground's yards, whatever the device tier.
    worker.postMessage({ settings: { ...settings, corridor: Infinity }, bake: true });
  });
}
