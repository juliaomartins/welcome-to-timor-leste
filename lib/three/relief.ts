// Loads a relief PNG written by the data build: height in metres is stored as
// v = (h + 1000) * 10 across R (high byte) and G (low byte); B > 127 marks sea
// where a coastline was baked in (Dili), otherwise sea is simply h <= 0.

export type Relief = {
  width: number;
  height: number;
  heights: Float32Array;
  sea: Uint8Array;
  /** Bilinear height at grid coordinates (0..width-1, 0..height-1). */
  sample: (gx: number, gy: number) => number;
};

export async function loadRelief(url: string, seaFromBlue = false): Promise<Relief> {
  const blob = await (await fetch(url)).blob();
  // No colour management or premultiplication: the bytes are data, not colour.
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const W = bmp.width;
  const H = bmp.height;
  // Works on the main thread and inside the city build worker.
  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const px = g.getImageData(0, 0, W, H).data;
  const heights = new Float32Array(W * H);
  const sea = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const h = (px[i * 4] * 256 + px[i * 4 + 1]) / 10 - 1000;
    heights[i] = h;
    sea[i] = seaFromBlue ? (px[i * 4 + 2] > 127 ? 1 : 0) : h <= 0 ? 1 : 0;
  }
  const sample = (gx: number, gy: number) => {
    const x = Math.min(W - 1.001, Math.max(0, gx));
    const y = Math.min(H - 1.001, Math.max(0, gy));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * W + x0;
    const a = heights[i];
    const b = heights[i + 1];
    const c = heights[i + W];
    const d = heights[i + W + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  return { width: W, height: H, heights, sea, sample };
}

