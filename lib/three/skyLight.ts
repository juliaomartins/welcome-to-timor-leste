import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

export type SkySettings = {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  cloudCoverage: number;
  cloudDensity: number;
};

// One physical sky drives three things so they can never disagree:
// the visible dome, the image-based lighting (PMREM), and the sun direction.
export class SkyLight {
  readonly sky: Sky;
  readonly sunDirection = new THREE.Vector3();
  environment: THREE.Texture | null = null;

  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private readonly envSky: Sky;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lastEnvKey = "";

  constructor(renderer: THREE.WebGLRenderer, settings: SkySettings) {
    this.sky = new Sky();
    this.sky.scale.setScalar(10000);
    this.envSky = new Sky();
    this.envSky.scale.setScalar(50);
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    for (const s of [this.sky, this.envSky]) {
      const u = s.material.uniforms;
      u.turbidity.value = settings.turbidity;
      u.rayleigh.value = settings.rayleigh;
      u.mieCoefficient.value = settings.mieCoefficient;
      u.mieDirectionalG.value = settings.mieDirectionalG;
      u.cloudCoverage.value = settings.cloudCoverage;
      u.cloudDensity.value = settings.cloudDensity;
    }
    // The environment copy has no sun disc: a pin-point HDR sun in the IBL
    // causes sparkly fireflies on rough surfaces; the DirectionalLight owns it.
    this.envSky.material.uniforms.showSunDisc.value = 0;
  }

  /** Elevation and azimuth in degrees. Azimuth 0 points to -Z, 90 to +X. */
  setSun(elevationDeg: number, azimuthDeg: number) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDirection.setFromSphericalCoords(1, phi, theta);
    // setFromSphericalCoords puts theta=0 on +Z; rotate so 0 means -Z.
    this.sunDirection.z *= -1;
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDirection);
    this.envSky.material.uniforms.sunPosition.value.copy(this.sunDirection);
  }

  setTime(t: number) {
    this.sky.material.uniforms.time.value = t;
  }

  /** Rebuild the IBL only when the sun has moved enough to be visible. */
  updateEnvironment(force = false): THREE.Texture | null {
    const key = this.sunDirection.toArray().map((v) => v.toFixed(2)).join(",");
    if (!force && key === this.lastEnvKey && this.environment) return this.environment;
    this.lastEnvKey = key;
    const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000, { size: 256 });
    this.envTarget?.dispose();
    this.envTarget = next;
    this.environment = next.texture;
    return this.environment;
  }

  dispose() {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.envSky.geometry.dispose();
    this.envSky.material.dispose();
  }
}
