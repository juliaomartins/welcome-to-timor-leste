import * as THREE from "three";
import { createCristoRei } from "./cristoRei";
import { Water } from "three/addons/objects/Water.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { fbm2, seededRandom, valueNoise2 } from "./noise";
import { FrameGovernor } from "./frameGovernor";
import { SkyLight } from "./skyLight";
import { createWaterNormals } from "./waterNormals";

// Cape Fatucama at sunrise: the hill, the 570-step stairway with its 14
// stations, the pedestal, Cristo Rei, the Wetar Strait and distant islands.
// The statue faces west (+Z); the sun rises behind it in the east (-Z).

export type Rig = {
  theta: number; // camera azimuth around the statue, degrees (0 = in front)
  radius: number;
  height: number; // camera height above the plaza
  targetY: number; // look-at height above the plaza
  offset: number; // lateral look-at offset: positive puts the statue on the left
  sunElev: number;
  title: number; // opacity of the sky title
};

export const PLAZA_Y = 3.3;
const STATUE_HEIGHT = 4.4; // statue, globe and the model's own columned base
const PEDESTAL_HEIGHT = 0.38;
// Sunrise off the statue's right shoulder: rim light plus modelling on the face.
const SUN_AZIMUTH = -68;

function capeHeight(x: number, z: number): number {
  const r = Math.hypot(x, z * 1.12);
  const mound = 4.6 * Math.exp(-Math.pow(r / 8.2, 2));
  // Fatucama peninsula: a ridge running back to the mainland on the -X side.
  const along = THREE.MathUtils.smoothstep(-x, 2, 60);
  const ridge = (3.1 - along * 1.2) * Math.exp(-Math.pow((z + x * 0.12) / (6 + along * 10), 2)) * (x < 2 ? 1 : Math.exp(-Math.pow((x - 2) / 5, 2)));
  let h = Math.max(mound, ridge) - 1.3;
  const rough = THREE.MathUtils.smoothstep(r, 2.6, 7);
  h += (fbm2(x * 0.18, z * 0.18, 5, 3) - 0.5) * 1.6 * rough;
  h += (fbm2(x * 0.9, z * 0.9, 3, 9) - 0.5) * 0.18 * rough;
  // Flat plaza for the monument.
  const plaza = 1 - THREE.MathUtils.smoothstep(r, 2.3, 3.4);
  return THREE.MathUtils.lerp(h, PLAZA_Y, plaza);
}

function slopeAt(x: number, z: number) {
  const e = 0.25;
  const dx = capeHeight(x + e, z) - capeHeight(x - e, z);
  const dz = capeHeight(x, z + e) - capeHeight(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

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
  private readonly water: Water;
  private readonly title: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly statueRoot = new THREE.Group();
  private readonly clock = new THREE.Timer();
  private readonly governor: FrameGovernor;
  private readonly pointer = new THREE.Vector2();
  private readonly pointerSmooth = new THREE.Vector2();
  private readonly disposables: { dispose: () => void }[] = [];
  private envElev = Number.NaN;
  private raf = 0;
  private running = false;
  private readonly opts: WorldOptions;
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly fogDawn = new THREE.Color("#858b96");
  private readonly fogMorning = new THREE.Color("#a7bfcc");
  private readonly sunDawn = new THREE.Color("#ff9a5c");
  private readonly sunMorning = new THREE.Color("#ffe9d2");

  constructor(canvas: HTMLCanvasElement, initial: Rig, opts: WorldOptions) {
    this.opts = opts;
    this.target = { ...initial };
    this.current = { ...initial };

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    const maxRatio = Math.min(window.devicePixelRatio, opts.quality === "high" ? 1.75 : 1.25);
    renderer.setPixelRatio(maxRatio);
    this.governor = new FrameGovernor(renderer, maxRatio, () => this.resize());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.72;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.2, 60000);

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
    this.scene.fog = new THREE.FogExp2(this.fogDawn.clone(), 0.0016);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const sm = opts.quality === "high" ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -10;
    sc.right = 10;
    sc.top = 10;
    sc.bottom = -10;
    sc.near = 1;
    sc.far = 120;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 3;
    this.sun.target.position.set(0, PLAZA_Y, 0);
    this.scene.add(this.sun, this.sun.target);
    // Faint bounce from the open sky and the warm hillside, so faces in shadow still read.
    this.scene.add(new THREE.HemisphereLight("#9db4c6", "#4a3c2e", 0.4));

    this.water = this.buildOcean();
    this.buildCape();
    this.buildIslands();
    this.title = this.buildTitle();

    this.statueRoot.position.set(0, PLAZA_Y, 0);
    this.scene.add(this.statueRoot);
    this.buildPedestal();

    // Post: HDR bloom only on what is genuinely bright (sun, glints), then
    // tone mapping, then a gentle lens vignette and film grain.
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: opts.quality === "high" ? 4 : 0,
    });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    if (opts.quality === "high") {
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

  private buildOcean(): Water {
    const normals = this.track(createWaterNormals(256));
    const geo = this.track(new THREE.PlaneGeometry(50000, 50000));
    const water = new Water(geo, {
      textureWidth: this.opts.quality === "high" ? 1024 : 512,
      textureHeight: this.opts.quality === "high" ? 1024 : 512,
      waterNormals: normals,
      sunDirection: new THREE.Vector3(),
      sunColor: 0xffd6ad,
      waterColor: 0x08303c,
      distortionScale: 1.7,
      // No fog on the sea: at grazing angles it reflects the sky's own horizon
      // colour, so sea and sky meet without a seam.
      fog: false,
    });
    water.material.uniforms.size.value = 7.5;
    water.rotation.x = -Math.PI / 2;
    this.track(water.material);
    this.scene.add(water);
    return water;
  }

  private buildCape() {
    const SIZE = 120;
    const SEG = this.opts.quality === "high" ? 260 : 160;
    const geo = this.track(new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const sand = new THREE.Color("#cdb48a");
    const wetSand = new THREE.Color("#8f7a5c");
    const dryGrass = new THREE.Color("#9a8a4e");
    const green = new THREE.Color("#4f6a32");
    const rock = new THREE.Color("#7a6c5e");
    const plaza = new THREE.Color("#b9b1a4");
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = capeHeight(x, z);
      pos.setY(i, h);
      const slope = slopeAt(x, z);
      const n = fbm2(x * 0.22, z * 0.22, 4, 21);
      c.copy(dryGrass).lerp(green, THREE.MathUtils.smoothstep(n, 0.35, 0.7));
      c.lerp(rock, THREE.MathUtils.smoothstep(slope, 0.55, 1.1) * 0.85);
      c.lerp(sand, 1 - THREE.MathUtils.smoothstep(h, 0.15, 0.55));
      c.lerp(wetSand, 1 - THREE.MathUtils.smoothstep(h, -0.1, 0.12));
      const r = Math.hypot(x, z * 1.12);
      c.lerp(plaza, 1 - THREE.MathUtils.smoothstep(r, 2.2, 2.6));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = this.track(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.8 }),
    );
    const cape = new THREE.Mesh(geo, mat);
    cape.receiveShadow = true;
    cape.castShadow = true;
    this.scene.add(cape);

    // The stairway from Cristo Rei Beach, with the 14 Stations of the Cross.
    const ctrl = [
      [0.45, 2.5],
      [0.95, 4.0],
      [0.5, 5.6],
      [1.05, 7.2],
      [0.6, 8.9],
      [1.15, 10.6],
      [0.85, 12.4],
    ].map(([a, r]) => new THREE.Vector3(Math.sin(a) * r, 0, Math.cos(a) * r));
    const curve = new THREE.CatmullRomCurve3(ctrl, false, "centripetal");
    const samples = curve.getSpacedPoints(240);
    const half = 0.16;
    const verts: number[] = [];
    const idx: number[] = [];
    const tangent = new THREE.Vector3();
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const q = samples[Math.min(samples.length - 1, i + 1)];
      const o = samples[Math.max(0, i - 1)];
      tangent.subVectors(q, o).setY(0).normalize();
      const nx = -tangent.z;
      const nz = tangent.x;
      for (const s of [-1, 1]) {
        const x = p.x + nx * half * s;
        const z = p.z + nz * half * s;
        verts.push(x, capeHeight(x, z) + 0.05, z);
      }
      if (i < samples.length - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const pathGeo = this.track(new THREE.BufferGeometry());
    pathGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    pathGeo.setIndex(idx);
    pathGeo.computeVertexNormals();
    const concrete = this.track(new THREE.MeshStandardMaterial({ color: "#c9c2b6", roughness: 0.9 }));
    const path = new THREE.Mesh(pathGeo, concrete);
    path.receiveShadow = true;
    this.scene.add(path);

    const chapelBody = this.track(new THREE.BoxGeometry(0.16, 0.18, 0.12));
    const chapelRoof = this.track(new THREE.ConeGeometry(0.13, 0.1, 4));
    chapelRoof.rotateY(Math.PI / 4);
    const white = this.track(new THREE.MeshStandardMaterial({ color: "#f1ede6", roughness: 0.7 }));
    const roofMat = this.track(new THREE.MeshStandardMaterial({ color: "#8c3b2a", roughness: 0.75 }));
    for (let k = 0; k < 14; k++) {
      const t = 0.05 + (k / 13) * 0.9;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t);
      const side = k % 2 === 0 ? 1 : -1;
      const x = p.x - tan.z * 0.38 * side;
      const z = p.z + tan.x * 0.38 * side;
      const y = capeHeight(x, z);
      const body = new THREE.Mesh(chapelBody, white);
      body.position.set(x, y + 0.09, z);
      body.rotation.y = Math.atan2(tan.x, tan.z);
      const roof = new THREE.Mesh(chapelRoof, roofMat);
      roof.position.set(x, y + 0.23, z);
      roof.rotation.y = body.rotation.y;
      body.castShadow = roof.castShadow = true;
      body.receiveShadow = true;
      this.scene.add(body, roof);
    }

    // Tropical dry-forest trees, kept off the plaza and the stairway.
    const rand = seededRandom(11);
    const count = this.opts.quality === "high" ? 340 : 160;
    // Each crown is a cluster of lumpy, smooth-shaded lobes rather than one ball.
    const lobes: THREE.BufferGeometry[] = [];
    const lobeLayout: [number, number, number, number][] = [
      [0, 0.05, 0, 0.82],
      [0.48, -0.08, 0.2, 0.6],
      [-0.42, -0.04, -0.25, 0.64],
      [0.05, 0.32, -0.12, 0.55],
    ];
    lobeLayout.forEach(([ox, oy, oz, r], li) => {
      let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 3);
      g.deleteAttribute("normal");
      g.deleteAttribute("uv");
      g = mergeVertices(g);
      const lp = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < lp.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(lp, i);
        const k = 0.82 + fbm2(v.x * 2.4 + li * 7, v.z * 2.4 + v.y * 1.9, 3, 4) * 0.38;
        v.multiplyScalar(k * r);
        v.y *= 0.74;
        lp.setXYZ(i, v.x + ox, v.y + oy, v.z + oz);
      }
      g.computeVertexNormals();
      lobes.push(g);
    });
    const canopyGeo = this.track(mergeGeometries(lobes)!);
    lobes.forEach((g) => g.dispose());
    const trunkGeo = this.track(new THREE.CylinderGeometry(0.05, 0.08, 1, 6));
    trunkGeo.translate(0, 0.5, 0);
    const canopyMat = this.track(new THREE.MeshStandardMaterial({ roughness: 0.88, color: "#ffffff" }));
    const trunkMat = this.track(new THREE.MeshStandardMaterial({ color: "#4a3b2c", roughness: 0.95 }));
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, count);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const leaf = new THREE.Color();
    let placed = 0;
    for (let tries = 0; tries < count * 12 && placed < count; tries++) {
      const x = (rand() - 0.5) * 70 - 8;
      const z = (rand() - 0.5) * 50;
      const r = Math.hypot(x, z * 1.12);
      if (r < 3.4) continue;
      const h = capeHeight(x, z);
      if (h < 0.55 || slopeAt(x, z) > 1.0) continue;
      let nearPath = false;
      for (let j = 0; j < samples.length; j += 4) {
        if (Math.hypot(samples[j].x - x, samples[j].z - z) < 0.65) {
          nearPath = true;
          break;
        }
      }
      if (nearPath) continue;
      const size = 0.32 + rand() * 0.42;
      const trunkH = size * (1.1 + rand() * 0.6);
      q.setFromEuler(new THREE.Euler(0, rand() * Math.PI * 2, 0));
      m.compose(p.set(x, h - 0.05, z), q, s.set(size * 0.9, trunkH, size * 0.9));
      trunks.setMatrixAt(placed, m);
      m.compose(p.set(x, h + trunkH * 0.95, z), q, s.set(size, size * (0.8 + rand() * 0.3), size));
      canopies.setMatrixAt(placed, m);
      leaf.setHSL(0.2 + rand() * 0.07, 0.38 + rand() * 0.2, 0.17 + rand() * 0.1);
      canopies.setColorAt(placed, leaf);
      placed++;
    }
    canopies.count = trunks.count = placed;
    canopies.castShadow = canopies.receiveShadow = true;
    trunks.castShadow = true;
    this.scene.add(canopies, trunks);
  }

  private buildIslands() {
    // Atauro Island and the mountains around Dili Bay, softened by aerial perspective.
    const make = (w: number, d: number, peak: number, seed: number, color: string) => {
      const geo = this.track(new THREE.PlaneGeometry(w, d, 120, 40));
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) / (w / 2);
        const z = pos.getZ(i) / (d / 2);
        const fall = Math.max(0, 1 - x * x) * Math.max(0, 1 - z * z * 1.4);
        const n = fbm2(pos.getX(i) * 0.02 + seed, pos.getZ(i) * 0.02, 5, seed);
        pos.setY(i, Math.pow(fall, 0.8) * peak * (0.55 + n * 0.9) - 4);
      }
      geo.computeVertexNormals();
      const mat = this.track(new THREE.MeshStandardMaterial({ color, roughness: 1, envMapIntensity: 0.6 }));
      return new THREE.Mesh(geo, mat);
    };
    const atauro = make(260, 80, 46, 3, "#4f6548");
    atauro.position.set(70, 0, -520);
    const diliHills = make(900, 180, 95, 8, "#4a5e44");
    diliHills.position.set(-950, 0, 260);
    diliHills.rotation.y = Math.PI / 2.4;
    const eastRange = make(500, 120, 60, 14, "#52664b");
    eastRange.position.set(-560, 0, -620);
    eastRange.rotation.y = -0.5;
    this.scene.add(atauro, diliHills, eastRange);
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
    const geo = this.track(new THREE.PlaneGeometry(50, 12.5));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, PLAZA_Y + 14.5, -46);
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

  // Weathered paving: slab joints, speckle and rain staining, as colour and roughness.
  private stoneTextures() {
    const size = 512;
    const color = document.createElement("canvas");
    const rough = document.createElement("canvas");
    color.width = color.height = rough.width = rough.height = size;
    const cg = color.getContext("2d")!;
    const rg = rough.getContext("2d")!;
    const ci = cg.createImageData(size, size);
    const ri = rg.createImageData(size, size);
    const slab = 128;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const n = fbm2(x / 48, y / 48, 5, 31);
        const speck = valueNoise2(x * 0.9, y * 0.9, 77);
        const sx = x % slab;
        const sy = (y + (Math.floor(x / slab) % 2) * (slab / 2)) % slab;
        const joint = sx < 2 || sy < 2 ? 1 : 0;
        const tint = (Math.floor(x / slab) * 7 + Math.floor(y / slab) * 13) % 5;
        let v = 206 + (n - 0.5) * 34 + (speck - 0.5) * 16 - tint * 2 - joint * 58;
        v = Math.max(0, Math.min(255, v));
        ci.data[i] = v + 6;
        ci.data[i + 1] = v + 1;
        ci.data[i + 2] = v - 8;
        ci.data[i + 3] = 255;
        const r = Math.min(255, 196 + (n - 0.5) * 60 + joint * 50);
        ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = r;
        ri.data[i + 3] = 255;
      }
    }
    cg.putImageData(ci, 0, 0);
    rg.putImageData(ri, 0, 0);
    const map = this.track(new THREE.CanvasTexture(color));
    map.colorSpace = THREE.SRGBColorSpace;
    const roughnessMap = this.track(new THREE.CanvasTexture(rough));
    for (const t of [map, roughnessMap]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(2.5, 2.5);
      t.anisotropy = 8;
    }
    return { map, roughnessMap };
  }

  private buildPedestal() {
    const { map, roughnessMap } = this.stoneTextures();
    const stone = this.track(
      new THREE.MeshStandardMaterial({ map, roughnessMap, roughness: 1, metalness: 0, envMapIntensity: 0.9 }),
    );
    const tiers: [number, number, number][] = [
      [2.25, 2.3, 0.22],
      [1.35, 1.5, PEDESTAL_HEIGHT],
    ];
    let y = 0;
    for (const [top, bottom, h] of tiers) {
      const geo = this.track(new THREE.CylinderGeometry(top, bottom, h, top > 2 ? 48 : 8));
      const mesh = new THREE.Mesh(geo, stone);
      mesh.position.y = y + h / 2;
      mesh.castShadow = mesh.receiveShadow = true;
      this.statueRoot.add(mesh);
      if (top > 2) continue; // the plaza disc sits flush with the ground
      y += h;
    }
  }

  async load(onProgress: (p: number) => void) {
    const model = await createCristoRei(STATUE_HEIGHT, onProgress);
    model.position.y = PEDESTAL_HEIGHT - 0.02;
    this.statueRoot.add(model);
    this.loaded = true;
    onProgress(1);
  }

  setPointer(x: number, y: number) {
    this.pointer.set(x, y);
  }

  private applySun(elev: number, force = false) {
    this.skyLight.setSun(elev, SUN_AZIMUTH);
    const dir = this.skyLight.sunDirection;
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 60);
    const k = THREE.MathUtils.smoothstep(elev, 0, 14);
    this.sun.color.copy(this.sunDawn).lerp(this.sunMorning, k);
    // Light fades as the sun approaches the horizon (longer path through air).
    this.sun.intensity = THREE.MathUtils.lerp(2.4, 3.6, k) * THREE.MathUtils.smoothstep(elev, -1.5, 2.5);
    (this.scene.fog as THREE.FogExp2).color.copy(this.fogDawn).lerp(this.fogMorning, k);
    this.water.material.uniforms.sunDirection.value.copy(dir);
    this.water.material.uniforms.sunColor.value.copy(this.sun.color);
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

    const theta = THREE.MathUtils.degToRad(c.theta + this.pointerSmooth.x * 2.2);
    const cam = this.camera.position;
    cam.set(Math.sin(theta) * c.radius, PLAZA_Y + c.height + this.pointerSmooth.y * 0.25, Math.cos(theta) * c.radius);
    // Never let the lens dip below the hillside.
    const ground = capeHeight(cam.x, cam.z) + 0.6;
    if (cam.y < ground) cam.y = ground;
    const right = this.tmpA.set(Math.cos(theta), 0, -Math.sin(theta));
    const look = this.tmpB.set(0, PLAZA_Y + c.targetY, 0).addScaledVector(right, c.offset);
    this.camera.lookAt(look);

    this.applySun(c.sunElev);
    this.title.material.opacity = c.title;
    this.title.visible = c.title > 0.01;
    this.title.lookAt(this.camera.position.x * 0.15, this.title.position.y, this.camera.position.z);

    this.water.material.uniforms.time.value = time * 0.35;
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
    // The statue's geometry and texture are shared with other scenes (see
    // cristoRei.ts) and live for the whole page, so only owned resources go.
    for (const d of this.disposables) d.dispose();
    this.skyLight.dispose();
    this.bloom?.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
