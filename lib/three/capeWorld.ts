import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { CRISTO_REI, toDili } from "../geo";
import { createCristoRei } from "./cristoRei";
import type { TierSettings } from "./deviceTier";
import type { DiliCity } from "./diliCity";
import { createStatuePlaza, getSharedDili, sharedDiliIfReady, statueSite } from "./diliShared";
import { FrameGovernor } from "./frameGovernor";
import { SkyLight } from "./skyLight";
import { createWaterNormals } from "./waterNormals";

// The home page: Cristo Rei at its real site on the summit of Cape Fatucama,
// inside the same real Dili the intro flies over (terrain, coastline, 70,000
// OpenStreetMap buildings, the Government Palace, the Tasi Tolu lakes). The
// statue faces west, toward Dili; the sun rises over the Wetar Strait in the
// east, behind it, as the visitor scrolls.

export type Rig = {
  theta: number; // camera azimuth around the statue, degrees (0 = in front)
  radius: number;
  height: number; // camera height above the statue's base
  targetY: number; // look-at height above the base
  offset: number; // lateral look-at offset: positive puts the statue on the left
  sunElev: number;
  title: number; // opacity of the sky title
};

const STATUE_M = 27; // the monument, statue and globe (Wikipedia)
// The camera shots (lib/shots.ts) were composed around a 4.4-unit statue, so
// one rig unit is 27 / 4.4 metres of real Cape Fatucama.
const S = STATUE_M / 4.4;
// Early-November sunrise at Dili: just south of due east, over the Wetar Strait.
const SUN_AZIMUTH = 100;
// Summit height at the Google Maps pin (from the elevation data), used until the city arrives.
const DEFAULT_TOP = 76;

const VIGNETTE_GRAIN_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    strength: { value: 0.32 },
    grain: { value: 0.035 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float strength;
    uniform float grain;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.2, length(d * vec2(1.0, 1.25)));
      c.rgb *= mix(1.0 - strength, 1.0, v);
      c.rgb += (rand(vUv * 1000.0 + time) - 0.5) * grain;
      gl_FragColor = c;
    }
  `,
};

type WorldOptions = {
  quality: "high" | "low";
  settings: TierSettings;
  titleFont: string;
  reducedMotion: boolean;
};

export class CapeWorld {
  readonly target: Rig;
  readonly current: Rig;
  loaded = false;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass | null;
  private readonly finish: ShaderPass;
  private readonly skyLight: SkyLight;
  private readonly sun: THREE.DirectionalLight;
  private readonly seaNormals: THREE.DataTexture;
  private readonly title: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly statueRoot = new THREE.Group();
  private readonly plaza: THREE.Mesh;
  private readonly clock = new THREE.Timer();
  private readonly governor: FrameGovernor;
  private readonly pointer = new THREE.Vector2();
  private readonly pointerSmooth = new THREE.Vector2();
  private readonly disposables: { dispose: () => void }[] = [];
  /** Statue base: the summit at the Google Maps pin. */
  private readonly base: THREE.Vector3;
  private city: DiliCity | null = null;
  private disposed = false;
  private envElev = Number.NaN;
  private raf = 0;
  private running = false;
  private readonly opts: WorldOptions;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly fogDawn = new THREE.Color("#8d919a");
  private readonly fogMorning = new THREE.Color("#b3c8d4");
  private readonly sunDawn = new THREE.Color("#ff9a5c");
  private readonly sunMorning = new THREE.Color("#ffe9d2");

  constructor(canvas: HTMLCanvasElement, initial: Rig, opts: WorldOptions) {
    this.opts = opts;
    this.target = { ...initial };
    this.current = { ...initial };
    const [px, pz] = toDili(CRISTO_REI);
    this.base = new THREE.Vector3(px, DEFAULT_TOP, pz);
    const high = opts.quality === "high";

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    const maxRatio = Math.min(window.devicePixelRatio, Math.max(1, opts.settings.maxPixelRatio));
    renderer.setPixelRatio(maxRatio);
    this.governor = new FrameGovernor(renderer, maxRatio, () => this.resize());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.66;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.5, 70000);

    // Sky, sun and image-based light from one source.
    this.skyLight = new SkyLight(renderer, {
      turbidity: 6,
      rayleigh: 2.2,
      mieCoefficient: 0.006,
      mieDirectionalG: 0.82,
      cloudCoverage: 0.32,
      cloudDensity: 0.45,
    });
    this.scene.add(this.skyLight.sky);
    this.scene.fog = new THREE.FogExp2(this.fogDawn.clone(), 0.00005);

    // Sunlight with crisp shadows around the summit (statue, plaza, the cape's trees).
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sm = high ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -220;
    sc.right = 220;
    sc.top = 220;
    sc.bottom = -220;
    sc.near = 10;
    sc.far = 3000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.4;
    this.sun.shadow.radius = 3;
    this.scene.add(this.sun, this.sun.target);
    // Faint bounce from the open sky and the warm hillside, so faces in shadow still read.
    this.scene.add(new THREE.HemisphereLight("#9db4c6", "#4a3c2e", 0.4));

    // Dili Bay and the Wetar Strait: glassy, slightly see-through over the real seabed.
    this.seaNormals = this.track(createWaterNormals(256, 5));
    this.seaNormals.repeat.set(3600, 3600);
    const sea = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(140000, 140000)),
      this.track(
        new THREE.MeshStandardMaterial({
          color: "#16607f",
          roughness: 0.06,
          metalness: 0.02,
          transparent: true,
          opacity: 0.9,
          normalMap: this.seaNormals,
          normalScale: new THREE.Vector2(0.22, 0.22),
          envMapIntensity: 1.05,
        }),
      ),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.receiveShadow = true;
    this.scene.add(sea);

    // Cristo Rei faces west (the model faces +Z; west is -X), on its stone platform.
    this.statueRoot.rotation.y = -Math.PI / 2;
    this.plaza = createStatuePlaza();
    this.track(this.plaza.geometry);
    this.track(this.plaza.material as THREE.Material);
    this.scene.add(this.statueRoot, this.plaza);
    this.placeStatue();
    this.title = this.buildTitle();

    // Post: HDR bloom only on what is genuinely bright (sun, glints), then
    // tone mapping, then a gentle lens vignette and film grain.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: opts.settings.msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (opts.settings.bloom) {
      // Threshold is scene-linear HDR (pre-exposure); the sky must stay below it.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.3, 0.55, 4);
      this.composer.addPass(this.bloom);
    } else {
      this.bloom = null;
    }
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(VIGNETTE_GRAIN_SHADER);
    this.composer.addPass(this.finish);

    this.applySun(initial.sunElev, true);
    this.resize();
  }

  private track<T extends { dispose: () => void }>(o: T): T {
    this.disposables.push(o);
    return o;
  }

  private placeStatue() {
    this.statueRoot.position.set(this.base.x, this.base.y + 0.2, this.base.z);
    this.plaza.position.set(this.base.x, this.base.y - 1.2, this.base.z);
    this.sun.target.position.copy(this.base);
    this.title?.position.copy(this.titlePosition());
  }

  /** Behind the statue (east), high in the sunrise sky. */
  private titlePosition() {
    return new THREE.Vector3(this.base.x + 46 * S, this.base.y + 14.5 * S, this.base.z);
  }

  private buildTitle() {
    const canvas = document.createElement("canvas");
    canvas.width = 4096;
    canvas.height = 1024;
    const tex = this.track(new THREE.CanvasTexture(canvas));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = this.track(
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        fog: false,
        color: new THREE.Color("#fff3e6").multiplyScalar(0.86),
        toneMapped: true,
      }),
    );
    const geo = this.track(new THREE.PlaneGeometry(50 * S, 12.5 * S));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.titlePosition());
    mesh.renderOrder = 1;
    this.scene.add(mesh);

    const draw = () => {
      const g = canvas.getContext("2d")!;
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#ffffff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = `760px ${this.opts.titleFont}`;
      g.fillText("Timor-Leste", canvas.width / 2, canvas.height / 2 + 40);
      tex.needsUpdate = true;
    };
    draw();
    if (document.fonts) {
      document.fonts.load(`760px ${this.opts.titleFont}`).then(draw).catch(() => {});
    }
    return mesh;
  }

  async load(onProgress: (p: number) => void) {
    const model = await createCristoRei(STATUE_M, onProgress);
    this.statueRoot.add(model);
    this.loaded = true;
    onProgress(1);
  }

  /**
   * Adopts the shared Dili (built by the intro) into this scene and compiles it
   * for this renderer. Call it while the intro's veil still covers the screen.
   * If the city is not ready within maxWaitMs, it is attached when it arrives.
   */
  async attachCity(maxWaitMs = 1500) {
    const attach = async (city: DiliCity) => {
      if (this.city || this.disposed) return;
      this.city = city;
      this.scene.add(city.group);
      this.base.copy(statueSite(city));
      this.placeStatue();
      await this.renderer.compileAsync(this.scene, this.camera);
    };
    const ready = sharedDiliIfReady();
    if (ready) return attach(ready);
    const pending = getSharedDili(this.opts.settings)
      .then(attach)
      .catch(() => {});
    await Promise.race([pending, new Promise((r) => setTimeout(r, maxWaitMs))]);
  }

  setPointer(x: number, y: number) {
    this.pointer.set(x, y);
  }

  private applySun(elev: number, force = false) {
    this.skyLight.setSun(elev, SUN_AZIMUTH);
    const dir = this.skyLight.sunDirection;
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 1500);
    const k = THREE.MathUtils.smoothstep(elev, 0, 14);
    this.sun.color.copy(this.sunDawn).lerp(this.sunMorning, k);
    // Light fades as the sun approaches the horizon (longer path through air).
    this.sun.intensity = THREE.MathUtils.lerp(2.4, 3.6, k) * THREE.MathUtils.smoothstep(elev, -1.5, 2.5);
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogDawn).lerp(this.fogMorning, k);
    if (force || Math.abs(elev - this.envElev) > 0.6) {
      this.envElev = elev;
      this.scene.environment = this.skyLight.updateEnvironment(true);
    }
  }

  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    // Keep the statue framed on tall phone screens by widening the lens.
    this.camera.fov = w / h < 0.8 ? 48 : 34;
    this.camera.updateProjectionMatrix();
  }

  private step(dt: number, time: number) {
    const k = this.opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.0);
    const t = this.target;
    const c = this.current;
    for (const key of Object.keys(t) as (keyof Rig)[]) {
      c[key] += (t[key] - c[key]) * k;
    }
    this.pointerSmooth.lerp(this.pointer, this.opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 2));

    // Orbit around the statue. theta = 0 is in front of it, i.e. west of the
    // statue looking east toward the sunrise; the rig is scaled to metres.
    const theta = THREE.MathUtils.degToRad(c.theta + this.pointerSmooth.x * 2.2);
    const R = c.radius * S;
    const cam = this.camera.position;
    cam.set(
      this.base.x - Math.cos(theta) * R,
      this.base.y + (c.height + this.pointerSmooth.y * 0.25) * S,
      this.base.z + Math.sin(theta) * R,
    );
    // Never let the lens dip below the real hillside or the sea.
    const ground = Math.max(1.5, (this.city?.heightAt(cam.x, cam.z) ?? 0) + 4);
    if (cam.y < ground) cam.y = ground;
    const right = this.tmpA.set(Math.sin(theta), 0, Math.cos(theta));
    const look = this.tmpB.copy(this.base).addScaledVector(right, c.offset * S);
    look.y += c.targetY * S;
    this.camera.lookAt(look);

    this.applySun(c.sunElev);
    this.title.material.opacity = c.title;
    this.title.visible = c.title > 0.01;
    this.title.lookAt(cam.x, this.title.position.y, cam.z);

    this.city?.update(time);
    this.seaNormals.offset.set(time * 0.004, time * 0.0025);
    this.skyLight.setTime(time);
    (this.finish.uniforms.time as { value: number }).value = time % 100;
    this.composer.render(dt);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.reset();
    const loop = (ts: number) => {
      if (!this.running) return;
      this.clock.update(ts);
      const raw = this.clock.getDelta();
      this.governor.sample(raw);
      const dt = Math.min(raw, 0.1);
      this.step(dt, this.clock.getElapsed());
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
    this.disposed = true;
    // The statue and the city are shared (cristoRei.ts, diliShared.ts) and live
    // for the whole page, so only this scene's own resources are released.
    if (this.city && this.city.group.parent === this.scene) this.scene.remove(this.city.group);
    for (const d of this.disposables) d.dispose();
    this.skyLight.dispose();
    this.bloom?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
