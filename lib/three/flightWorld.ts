import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createAirliner, type Airliner } from "./airliner";
import { buildMapTerrain, mapToWorld, MAP_DEPTH, MAP_WIDTH, SEA_COLOR, type MapTerrain } from "./mapTerrain";
import { GOVERNMENT_PALACE, islandUV } from "../geo";
import { seededRandom } from "./noise";
import { loadRelief } from "./relief";
import type { TierSettings } from "./deviceTier";
import { FrameGovernor } from "./frameGovernor";
import { SkyLight } from "./skyLight";
import { createWaterNormals } from "./waterNormals";

// The splash: an airliner crosses the Savu Sea and the Ombai Strait and
// arrives over Dili, flown over a 3D relief built from the Wikimedia map.

export type FlightState = {
  flight: number; // 0..1 along the route
  chase: number; // 0 = establishing shot, 1 = chase camera
  arrive: number; // 0..1 blend to the camera hovering over Dili
  dive: number; // 0..1 final push down into the clouds
};

// Route as real longitude, latitude and altitude (world units): over the Savu
// Sea, up the Ombai Strait, along the north coast and down toward Dili.
const ROUTE: [number, number, number][] = [
  [122.55, -10.45, 3.4],
  [123.35, -9.8, 2.9],
  [124.15, -9.15, 2.3],
  [124.85, -8.85, 1.9],
  [125.3, -8.62, 1.5],
  [125.58, -8.54, 1.1],
  [125.75, -8.47, 0.9],
];
export const DILI_UV = islandUV(GOVERNMENT_PALACE);
const PLANE_SCALE = 0.1;

function cloudTexture(seed: number): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const rand = seededRandom(seed);
  for (let i = 0; i < 26; i++) {
    const x = size * (0.22 + rand() * 0.56);
    const y = size * (0.35 + rand() * 0.35);
    const r = size * (0.08 + rand() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    const shade = 235 + Math.round(rand() * 20);
    grad.addColorStop(0, `rgba(${shade},${shade},${shade + 2},0.55)`);
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class FlightWorld {
  readonly state: FlightState = { flight: 0, chase: 0, arrive: 0, dive: 0 };
  onRegion?: (name: string) => void;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 4000);
  private readonly composer: EffectComposer;
  private readonly skyLight: SkyLight;
  private readonly sun: THREE.DirectionalLight;
  private terrain: MapTerrain | null = null;
  private plane: Airliner | null = null;
  private readonly route: THREE.CatmullRomCurve3;
  private readonly clouds = new THREE.Group();
  private readonly marker = new THREE.Group();
  private beamMat: THREE.MeshBasicMaterial | null = null;
  private readonly seaNormal: THREE.DataTexture;
  private readonly seaMat: THREE.MeshStandardMaterial;
  private readonly disposables: { dispose: () => void }[] = [];
  private readonly clock = new THREE.Timer();
  private readonly governor: FrameGovernor;
  private raf = 0;
  private running = false;
  private region = "";
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly prevTangent = new THREE.Vector3(0, 0, 1);
  private bank = 0;
  private initialised = false;

  private readonly settings: TierSettings;

  /** The renderer is shared with the Dili act; this world never disposes it. */
  constructor(renderer: THREE.WebGLRenderer, settings: TierSettings) {
    this.renderer = renderer;
    this.settings = settings;
    const maxRatio = Math.min(window.devicePixelRatio, settings.maxPixelRatio);

    // Morning sun from the north-west, matching the hill-shading baked into the map.
    this.skyLight = new SkyLight(renderer, {
      turbidity: 3.2,
      rayleigh: 1.4,
      mieCoefficient: 0.004,
      mieDirectionalG: 0.8,
      cloudCoverage: 0.42,
      cloudDensity: 0.5,
    });
    this.skyLight.setSun(34, -48);
    this.scene.add(this.skyLight.sky);
    this.scene.environment = this.skyLight.updateEnvironment(true);
    this.scene.fog = new THREE.FogExp2("#c6dcea", 0.011);

    this.sun = new THREE.DirectionalLight("#fff1de", 1.55);
    this.sun.position.copy(this.skyLight.sunDirection).multiplyScalar(40);
    this.sun.castShadow = settings.shadowMap > 0;
    const sm = Math.max(512, settings.shadowMap);
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -20;
    sc.right = 20;
    sc.top = 20;
    sc.bottom = -20;
    sc.near = 1;
    sc.far = 90;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);

    // Open sea around (and as a glossy film over) the map.
    this.seaNormal = this.track(createWaterNormals(256, 3));
    this.seaNormal.repeat.set(420, 420);
    this.seaMat = this.track(
      new THREE.MeshStandardMaterial({
        color: SEA_COLOR.clone().multiplyScalar(0.55),
        roughness: 0.22,
        metalness: 0,
        transparent: true,
        opacity: 0.16,
        normalMap: this.seaNormal,
        normalScale: new THREE.Vector2(0.18, 0.18),
        envMapIntensity: 0.45,
      }),
    );
    const seaFilm = new THREE.Mesh(this.track(new THREE.PlaneGeometry(600, 600)), this.seaMat);
    seaFilm.rotation.x = -Math.PI / 2;
    seaFilm.position.y = 0.002;
    seaFilm.receiveShadow = true;
    const seaFloorMat = this.track(new THREE.MeshStandardMaterial({ color: SEA_COLOR, roughness: 1 }));
    const seaFloor = new THREE.Mesh(this.track(new THREE.PlaneGeometry(600, 600)), seaFloorMat);
    seaFloor.rotation.x = -Math.PI / 2;
    seaFloor.position.y = -0.065;
    seaFloor.receiveShadow = true;
    this.scene.add(seaFloor, seaFilm);

    this.route = new THREE.CatmullRomCurve3(
      ROUTE.map(([lon, lat, y]) => mapToWorld(...islandUV({ lon, lat }), y)),
      false,
      "centripetal",
    );

    this.buildClouds(settings.islandClouds);
    this.buildMarker();

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: settings.msaa,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (settings.bloom) {
      // Threshold is in scene-linear HDR, before exposure: the physical sky itself
      // sits well above 1, so only the sun, glints and the Dili beacon may bloom.
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.3, 0.45, 6));
    }
    this.composer.addPass(new OutputPass());
    this.governor = new FrameGovernor(renderer, maxRatio, () => this.resize());
    this.resize();
  }

  private track<T extends { dispose: () => void }>(o: T): T {
    this.disposables.push(o);
    return o;
  }

  async load(reliefUrl: string) {
    const relief = await loadRelief(reliefUrl);
    this.terrain = buildMapTerrain(relief, this.settings.islandSegments);
    this.scene.add(this.terrain.mesh);
    this.plane = createAirliner();
    this.plane.group.scale.setScalar(PLANE_SCALE);
    this.scene.add(this.plane.group);
    const [u, v] = DILI_UV;
    this.marker.position.copy(mapToWorld(u, v, this.terrain.heightAt(u, v) + 0.01));
    // Compile shaders before the first visible frame, so the flight starts without a hitch.
    await this.renderer.compileAsync(this.scene, this.camera);
    this.initialised = true;
  }

  private buildClouds(count: number) {
    const textures = [1, 2, 3, 4].map((s) => this.track(cloudTexture(s * 31)));
    const rand = seededRandom(5);
    // Sprites are unlit, so they are given HDR white: after tone mapping they
    // land on sunlit-cloud white instead of a dull grey.
    const materials = textures.map((map) =>
      this.track(
        new THREE.SpriteMaterial({
          map,
          color: new THREE.Color(1.45, 1.48, 1.52),
          transparent: true,
          depthWrite: false,
          opacity: 0.72,
        }),
      ),
    );
    const wideCamera = mapToWorld(0.12, 1.02, 7.5);
    const side = new THREE.Vector3();
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 6; tries++) {
      // Every third cloud drifts beside the flight corridor, so the chase camera
      // slips past their edges; the rest float over the islands.
      const nearRoute = placed % 3 === 0;
      let p: THREE.Vector3;
      let k: number;
      if (nearRoute) {
        const t = 0.08 + rand() * 0.6;
        p = this.route.getPointAt(t).clone();
        const tan = this.route.getTangentAt(t);
        side.set(-tan.z, 0, tan.x).normalize();
        p.addScaledVector(side, (rand() < 0.5 ? -1 : 1) * (1.2 + rand() * 2.2));
        p.y += -0.2 + rand() * 0.7;
        k = 1 + rand() * 1.3;
      } else {
        p = new THREE.Vector3((rand() - 0.5) * MAP_WIDTH * 1.5, 1.6 + rand() * 1.6, (rand() - 0.5) * MAP_DEPTH * 1.5);
        k = 1.5 + rand() * 2.2;
      }
      if (p.distanceTo(wideCamera) < 7) continue;
      const s = new THREE.Sprite(materials[placed % materials.length]);
      s.position.copy(p);
      s.scale.set(k * 1.7, k, 1);
      this.clouds.add(s);
      placed++;
    }
    this.scene.add(this.clouds);
  }

  private buildMarker() {
    const gold = new THREE.Color("#ffc726").multiplyScalar(14);
    const ringMat = this.track(new THREE.MeshBasicMaterial({ color: gold, transparent: true, side: THREE.DoubleSide }));
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(this.track(new THREE.RingGeometry(0.16, 0.2, 48)), ringMat.clone());
      this.track(ring.material);
      ring.rotation.x = -Math.PI / 2;
      ring.userData.phase = i * 0.5;
      this.marker.add(ring);
    }
    const beamGeo = this.track(new THREE.CylinderGeometry(0.004, 0.012, 1.2, 12, 1, true));
    beamGeo.translate(0, 0.7, 0);
    const beamMat = this.track(
      new THREE.MeshBasicMaterial({
        color: gold,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.beamMat = beamMat;
    this.marker.add(new THREE.Mesh(beamGeo, beamMat));
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 58 : 42;
    this.camera.updateProjectionMatrix();
  }

  private regionFor(p: number) {
    if (p < 0.3) return "Savu Sea";
    if (p < 0.6) return "Ombai Strait";
    if (p < 0.8) return "North coast of Timor";
    return "Dili";
  }

  private step(dt: number, time: number) {
    if (!this.initialised || !this.plane || !this.terrain) return;
    const st = this.state;
    const p = THREE.MathUtils.clamp(st.flight, 0, 1);

    // Airliner pose: follow the route, bank into turns.
    const pos = this.route.getPointAt(p);
    const tangent = this.route.getTangentAt(Math.min(p, 0.999));
    const turn = this.prevTangent.clone().cross(tangent).y;
    this.prevTangent.copy(tangent);
    this.bank += (THREE.MathUtils.clamp(-turn * 260, -0.5, 0.5) - this.bank) * (1 - Math.exp(-dt * 2.5));
    const g = this.plane.group;
    g.position.copy(pos);
    g.lookAt(pos.clone().add(tangent));
    g.rotateZ(this.bank);
    this.plane.update(time);

    // Camera: establishing shot -> chase -> hover over Dili -> dive.
    const wide = mapToWorld(0.12, 1.02, 7.5);
    const wideLook = mapToWorld(0.42, 0.5, 0.4);
    // Behind, above and slightly off the right wing, in the plane's own frame.
    const chaseOffset = new THREE.Vector3(-2.6, 1.7, -6.2).applyQuaternion(g.quaternion).multiplyScalar(PLANE_SCALE);
    const chase = pos.clone().add(chaseOffset);
    const chaseLook = pos.clone().addScaledVector(tangent, 0.6);
    const [du, dv] = DILI_UV;
    const dili = mapToWorld(du, dv, this.terrain.heightAt(du, dv));
    // Hover south of Dili, over the mountains, looking north across the bay to
    // Atauro; the final dive drops toward the city and into the clouds.
    const hover = dili.clone().add(new THREE.Vector3(-1.2, 4.6 - st.dive * 3.8, 5.6 - st.dive * 4.6));
    const targetPos = wide.clone().lerp(chase, st.chase).lerp(hover, st.arrive);
    const targetLook = wideLook.clone().lerp(chaseLook, st.chase).lerp(dili, st.arrive);
    if (this.camPos.lengthSq() === 0) {
      this.camPos.copy(targetPos);
      this.camLook.copy(targetLook);
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camPos.lerp(targetPos, k);
    this.camLook.lerp(targetLook, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    // Dili beacon.
    this.marker.visible = p > 0.55 && st.dive < 0.15;
    // The beam only rises once we arrive, so it never looms past the chase camera.
    if (this.beamMat) this.beamMat.opacity = 0.55 * st.arrive;
    this.marker.children.forEach((child) => {
      if (!(child instanceof THREE.Mesh) || child.userData.phase === undefined) return;
      const t = (time * 0.6 + child.userData.phase) % 1;
      child.scale.setScalar(0.4 + t * 1.2);
      (child.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.9;
    });

    this.seaNormal.offset.set(time * 0.01, time * 0.006);
    this.skyLight.setTime(time);

    const region = this.regionFor(p);
    if (region !== this.region) {
      this.region = region;
      this.onRegion?.(region);
    }

    this.composer.render(dt);
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Shared renderer: claim its global state for this act.
    this.renderer.toneMappingExposure = 0.42;
    this.renderer.shadowMap.enabled = this.settings.shadowMap > 0;
    this.resize();
    this.clock.reset();
    const loop = (ts: number) => {
      if (!this.running) return;
      this.clock.update(ts);
      const raw = this.clock.getDelta();
      this.governor.sample(raw);
      this.step(Math.min(raw, 0.1), this.clock.getElapsed());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.terrain?.dispose();
    this.plane?.dispose();
    for (const d of this.disposables) d.dispose();
    this.skyLight.dispose();
    this.composer.dispose();
  }
}
