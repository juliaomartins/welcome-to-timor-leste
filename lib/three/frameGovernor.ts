import type * as THREE from "three";

// Dynamic resolution: when frames run slower than ~30 fps, render fewer pixels;
// when there is headroom again, step back up. Keeps the motion smooth on
// integrated GPUs without giving up quality on fast machines.
export class FrameGovernor {
  private acc = 0;
  private frames = 0;
  private cooldown = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly maxRatio: number,
    private readonly onChange: () => void,
    private readonly minRatio = 0.6,
  ) {}

  /** Feed the real (uncapped) frame time in seconds. */
  sample(rawDt: number) {
    if (this.cooldown > 0) {
      this.cooldown -= rawDt;
      return;
    }
    this.acc += rawDt;
    this.frames++;
    if (this.acc < 1.2) return;
    const avg = this.acc / this.frames;
    this.acc = 0;
    this.frames = 0;
    const ratio = this.renderer.getPixelRatio();
    let next = ratio;
    if (avg > 1 / 30) next = Math.max(this.minRatio, ratio * 0.78);
    else if (avg < 1 / 55) next = Math.min(this.maxRatio, ratio * 1.1);
    if (Math.abs(next - ratio) > 0.02) {
      this.renderer.setPixelRatio(next);
      this.onChange();
      this.cooldown = 0.8;
    }
  }
}
