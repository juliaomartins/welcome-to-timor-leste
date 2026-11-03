import * as THREE from "three";

// One place that decides how much the 3D intro may cost on this device.
// Detection is a best guess from the GPU, cores, memory and input type; the
// frame governor then fine-tunes resolution at runtime. ?quality=low|medium|high
// overrides the guess for testing.

export type Tier = "high" | "medium" | "low";

export type TierSettings = {
  tier: Tier;
  maxPixelRatio: number;
  msaa: number;
  bloom: boolean;
  shadowMap: number; // 0 disables shadows
  islandSegments: number;
  islandClouds: number;
  diliTerrainSegments: number;
  capeStep: number; // metres between cape patch vertices
  trees: number;
  capeTrees: number;
  palms: boolean;
  /** Buildings further than this from the flight corridor are left out (metres). */
  corridor: number;
  traffic: number;
  boats: number;
};

const SETTINGS: Record<Tier, Omit<TierSettings, "tier">> = {
  high: {
    maxPixelRatio: 1.6, msaa: 4, bloom: true, shadowMap: 2048, islandSegments: 380, islandClouds: 36,
    diliTerrainSegments: 720, capeStep: 4, trees: 12000, capeTrees: 4000, palms: true, corridor: Infinity, traffic: 700, boats: 40,
  },
  medium: {
    maxPixelRatio: 1, msaa: 0, bloom: false, shadowMap: 1024, islandSegments: 300, islandClouds: 26,
    diliTerrainSegments: 520, capeStep: 6, trees: 5000, capeTrees: 2400, palms: true, corridor: 2600, traffic: 400, boats: 28,
  },
  low: {
    maxPixelRatio: 1, msaa: 0, bloom: false, shadowMap: 0, islandSegments: 200, islandClouds: 16,
    diliTerrainSegments: 340, capeStep: 9, trees: 2200, capeTrees: 1400, palms: true, corridor: 1500, traffic: 160, boats: 16,
  },
};

function gpuName(): string {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return "no-webgl2";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return name;
  } catch {
    return "unknown";
  }
}

let cached: TierSettings | null = null;

export function detectTier(): TierSettings {
  if (cached) return cached;
  const forced = new URLSearchParams(window.location.search).get("quality");
  let tier: Tier;
  if (forced === "high" || forced === "medium" || forced === "low") {
    tier = forced;
  } else {
    const gpu = gpuName();
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    const cores = navigator.hardwareConcurrency ?? 4;
    const small = Math.min(window.innerWidth, window.innerHeight) < 600;
    if (/no-webgl2|swiftshader|llvmpipe|software|basic render/i.test(gpu) || memory <= 2) tier = "low";
    else if (coarse || small) tier = memory >= 6 && cores >= 6 && /apple|adreno \(tm\) 7|adreno 7/i.test(gpu) ? "medium" : "low";
    else if (/nvidia|geforce|rtx|quadro|radeon|amd|apple m\d|apple gpu/i.test(gpu) && cores >= 6) tier = "high";
    else if (/intel|uhd|iris|hd graphics|mali|adreno|powervr/i.test(gpu) || cores <= 4) tier = memory <= 4 ? "low" : "medium";
    else tier = "medium";
  }
  cached = { tier, ...SETTINGS[tier] };
  return cached;
}

/** The intro's single WebGL renderer, shared by both acts so only one context is alive. */
export function createIntroRenderer(canvas: HTMLCanvasElement, s: TierSettings) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, s.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = s.shadowMap > 0;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}
