import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CRISTO_REI, TASI_TOLU, toDili } from "../geo";
import { createAirliner, type Airliner } from "./airliner";
import { createCristoRei } from "./cristoRei";
import { diliRoutePoints } from "./diliRoute";
import { assembleDiliCity, fetchDiliCity, type DiliCity, type DiliCityData } from "./diliCity";
import type { TierSettings } from "./deviceTier";
import { FrameGovernor } from "./frameGovernor";
import { seededRandom } from "./noise";
import { SkyLight } from "./skyLight";
import { createWaterNormals } from "./waterNormals";

// The second half of the intro: an airliner low over Dili at true scale, from
// the Tasi Tolu lakes along the coast over the Government Palace to Cristo Rei
// on Cape Fatucama, where the camera settles into an orbit of the statue.

export type DiliFlightState = {
  flight: number; // 0..1 along the route
  orbit: number; // 0..1 blend from chase camera to the Cristo Rei orbit
};

const STATUE_HEIGHT = 27; // the monument: statue, globe and pedestal (Wikipedia)
const PLANE_SCALE = 9.5; // airliner model is 4 units long: about 38 m

function cloudTexture(seed: number): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const rand = seededRandom(seed);
  for (let i = 0; i < 24; i++) {
    const x = size * (0.22 + rand() * 0.56);
    const y = size * (0.35 + rand() * 0.35);
    const r = size * (0.08 + rand() * 0.16);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "rgba(255,255,255,0.5)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class DiliWorld {
  readonly state: DiliFlightState = { flight: 0, orbit: 0 };
  onRegion?: (name: string) => void;
  ready = false;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(46, 1, 1, 70000);
  private readonly composer: EffectComposer;
  private readonly governor: FrameGovernor;
  private readonly skyLight: SkyLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly seaNormals: THREE.DataTexture;
  private readonly disposables: { dispose: () => void }[] = [];
  private readonly clock = new THREE.Timer();
  private readonly settings: TierSettings;
  private city: DiliCity | null = null;
  private plane: Airliner | null = null;
  private statueTop = new THREE.Vector3();
  private route: THREE.CatmullRomCurve3 | null = null;
  private lakes = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly prevTangent = new THREE.Vector3(1, 0, 0);
  private bank = 0;
  private region = "";
  private raf = 0;
  private running = false;
  private readonly abort = new AbortController();
  private warmTarget: THREE.WebGLRenderTarget | null = null;
  private pending: { data: DiliCityData; statue: THREE.Group } | null = null;

  /** The renderer is shared with the island act; this world never disposes it. */
  constructor(renderer: THREE.WebGLRenderer, settings: TierSettings) {
    this.settings = settings;
    this.renderer = renderer;
    const maxRatio = Math.min(window.devicePixelRatio, settings.maxPixelRatio);

    // Afternoon light from the west: the statue faces west, so the final shot is lit from the front.
    this.skyLight = new SkyLight(renderer, {
      turbidity: 4,
      rayleigh: 1.3,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.8,
      cloudCoverage: 0.38,
      cloudDensity: 0.45,
    });
    this.skyLight.setSun(32, -104);
    this.scene.add(this.skyLight.sky);
    this.scene.environment = this.skyLight.updateEnvironment(true);
    this.scene.fog = new THREE.FogExp2("#c3d5e0", 0.000042);

    this.sun = new THREE.DirectionalLight("#fff0dc", 2.6);
    this.sun.castShadow = settings.shadowMap > 0;
    const sm = Math.max(512, settings.shadowMap);
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -650;
    sc.right = 650;
    sc.top = 650;
    sc.bottom = -650;
    sc.near = 10;
    sc.far = 5000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new THREE.HemisphereLight("#bcd3e6", "#5b5040", 0.35));

    // Dili Bay: glassy, slightly see-through so the reef shallows tint the coast.
    this.seaNormals = this.track(createWaterNormals(256, 5));
    this.seaNormals.repeat.set(3600, 3600);
    const sea = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(140000, 140000)),
      this.track(
        new THREE.MeshStandardMaterial({
          color: "#1b6a8c",
          roughness: 0.07,
          metalness: 0.02,
          transparent: true,
          opacity: 0.9,
          normalMap: this.seaNormals,
          normalScale: new THREE.Vector2(0.22, 0.22),
          envMapIntensity: 1,
        }),
      ),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = 0;
    sea.receiveShadow = true;
    this.scene.add(sea);

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: settings.msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (settings.bloom) {
      // Scene-linear threshold above the sky: only glints and the sun bloom.
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.25, 0.4, 6));
    }
    this.composer.addPass(new OutputPass());
    this.governor = new FrameGovernor(renderer, maxRatio, () => this.resize());
    this.resize();
  }

  private track<T extends { dispose: () => void }>(o: T): T {
    this.disposables.push(o);
    return o;
  }

  /** Stage one, in the background: the worker build and the statue download. */
  async load(onProgress?: (p: number) => void) {
    const [data, statue] = await Promise.all([
      fetchDiliCity({ settings: this.settings, onProgress, signal: this.abort.signal }),
      createCristoRei(STATUE_HEIGHT),
    ]);
    this.pending = { data, statue };
  }

  /**
   * Stage two, while the cloud veil covers the screen: assemble the scene, compile
   * its shaders and upload every buffer, so the flight itself never stalls.
   */
  async assemble() {
    if (!this.pending || this.abort.signal.aborted) return;
    const { data, statue } = this.pending;
    this.pending = null;
    const city = assembleDiliCity(data, this.settings);
    this.city = city;
    this.scene.add(city.group);

    // Cristo Rei at the Google Maps pin, on the summit of Cape Fatucama, facing west.
    const [sx, sz] = toDili(CRISTO_REI);
    let top = -Infinity;
    for (let a = 0; a < 12; a++) {
      for (const r of [0, 6, 12]) top = Math.max(top, city.heightAt(sx + Math.cos(a) * r, sz + Math.sin(a) * r));
    }
    const plaza = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(7.5, 9, 3, 32)),
      this.track(new THREE.MeshStandardMaterial({ color: "#a59c8d", roughness: 0.9 })),
    );
    plaza.position.set(sx, top - 1.2, sz);
    plaza.receiveShadow = true;
    plaza.castShadow = true;
    statue.position.set(sx, top + 0.2, sz);
    statue.rotation.y = -Math.PI / 2; // model faces +Z; west is -X
    this.scene.add(plaza, statue);
    this.statueTop.set(sx, top + STATUE_HEIGHT * 0.62, sz);

    const [tx, tz] = toDili(TASI_TOLU);
    this.lakes.set(tx, 0, tz);
    // Route (metres): in over the sea west of Tasi Tolu, across the lakes,
    // along the coast over Comoro to the Government Palace, across the bay to the cape.
    const pts = diliRoutePoints(top);
    this.route = new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, "centripetal");

    this.plane = createAirliner();
    this.plane.group.scale.setScalar(PLANE_SCALE);
    this.scene.add(this.plane.group);
    const plane = this.plane;
    this.disposables.push({ dispose: () => plane.dispose() });

    // A thin cloud deck the camera breaks through at the start.
    const rand = seededRandom(41);
    const textures = [1, 2, 3].map((s) => this.track(cloudTexture(s * 17)));
    const mats = textures.map((map) =>
      this.track(new THREE.SpriteMaterial({ map, color: new THREE.Color(1.6, 1.62, 1.66), transparent: true, depthWrite: false, opacity: 0.85 })),
    );
    for (let i = 0; i < 36; i++) {
      const s = new THREE.Sprite(mats[i % mats.length]);
      const t = i < 14 ? rand() * 0.12 : rand();
      const p = this.route.getPointAt(t);
      const side = (rand() - 0.5) * (i < 14 ? 900 : 5000);
      s.position.set(p.x + side, 650 + rand() * 500, p.z + (rand() - 0.5) * 2400);
      const k = 380 + rand() * 520;
      s.scale.set(k * 1.7, k, 1);
      this.scene.add(s);
    }
    // Compile shaders and upload the city's buffers while this act is still
    // hidden, so the first visible frame does not stall the timeline.
    // Shaders first, in parallel and off the critical path; then one frame to upload buffers.
    await this.renderer.compileAsync(this.scene, this.camera);
    // Warm up off-screen with culling disabled, so even objects that only come
    // into view late in the flight are uploaded now rather than mid-flight.
    const warm = new THREE.WebGLRenderTarget(64, 64);
    const culled: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false;
        culled.push(o);
      }
    });
    this.warmTarget = warm;
    this.step(0, 0);
    this.warmTarget = null;
    culled.forEach((o) => (o.frustumCulled = true));
    warm.dispose();
    this.ready = true;
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 62 : 46;
    this.camera.updateProjectionMatrix();
  }

  private regionFor(p: number, orbit: number) {
    if (orbit > 0.2 || p > 0.8) return "Cristo Rei of Dili";
    if (p < 0.3) return "Tasi Tolu";
    if (p < 0.4) return "Comoro";
    if (p < 0.62) return "Government Palace";
    return "Dili Bay";
  }

  private step(dt: number, time: number) {
    if (!this.route || !this.plane || !this.city) return;
    const st = this.state;
    const p = THREE.MathUtils.clamp(st.flight, 0, 1);
    const pos = this.route.getPointAt(p);
    const tangent = this.route.getTangentAt(Math.min(p, 0.999));
    const turn = this.prevTangent.clone().cross(tangent).y;
    this.prevTangent.copy(tangent);
    this.bank += (THREE.MathUtils.clamp(-turn * 220, -0.45, 0.45) - this.bank) * (1 - Math.exp(-dt * 2.5));
    const g = this.plane.group;
    g.position.copy(pos);
    g.lookAt(pos.clone().add(tangent));
    g.rotateZ(this.bank);
    this.plane.update(time);
    this.city.update(time);

    // Chase camera behind, above and right of the airliner, looking ahead and down at the city.
    const offset = new THREE.Vector3(-4.5, 6, -17).applyQuaternion(g.quaternion).multiplyScalar(PLANE_SCALE);
    const chase = pos.clone().add(offset);
    const ahead = pos.clone().addScaledVector(tangent, 260);
    ahead.y = Math.max(0, pos.y - 260);
    // Glance at each landmark as it passes beneath.
    const bump = (c: number, w: number) => Math.max(0, 1 - Math.abs(p - c) / w);
    const look = ahead.clone();
    look.lerp(this.lakes, THREE.MathUtils.smootherstep(bump(0.12, 0.13), 0, 1) * 0.85);
    look.lerp(new THREE.Vector3(this.city.palace.cx, 8, this.city.palace.cz), THREE.MathUtils.smootherstep(bump(0.54, 0.12), 0, 1) * 0.95);
    look.lerp(this.statueTop, THREE.MathUtils.smoothstep(p, 0.68, 0.86));
    // Final shot after the references: from over the sea north-west of the cape.
    const a = 0.78 + time * 0.018;
    const orbitPos = this.statueTop.clone().add(new THREE.Vector3(-Math.cos(a) * 270, 28, -Math.sin(a) * 270));
    const targetPos = chase.lerp(orbitPos, THREE.MathUtils.smootherstep(st.orbit, 0, 1));
    // Aim above the statue so it sits in the lower part of the frame, under the greeting.
    const targetLook = look.lerp(this.statueTop.clone().add(new THREE.Vector3(0, 26, 0)), st.orbit);
    if (this.camPos.lengthSq() === 0) {
      this.camPos.copy(targetPos);
      this.camLook.copy(targetLook);
    }
    const k = 1 - Math.exp(-dt * 5);
    this.camPos.lerp(targetPos, k);
    this.camLook.lerp(targetLook, k);
    const ground = this.city.heightAt(this.camPos.x, this.camPos.z) + 25;
    if (this.camPos.y < ground) this.camPos.y = ground;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);

    // Shadows follow whatever the camera is looking at.
    this.sun.target.position.copy(this.camLook).setY(0);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.skyLight.sunDirection, 2000);
    this.seaNormals.offset.set(time * 0.004, time * 0.0025);
    this.skyLight.setTime(time);

    const region = this.running ? this.regionFor(p, st.orbit) : this.region;
    if (region !== this.region) {
      this.region = region;
      this.onRegion?.(region);
    }
    if (this.warmTarget) {
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.warmTarget);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(prev);
      return;
    }
    this.composer.render(dt);
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Shared renderer: claim its global state for this act.
    this.renderer.toneMappingExposure = 0.5;
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
    this.abort.abort();
    this.city?.dispose();
    for (const d of this.disposables) d.dispose();
    this.skyLight.dispose();
    this.composer.dispose();
  }
}
