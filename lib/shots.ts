import type { Rig } from "./three/capeWorld";

// One camera "shot" per page section. Scrolling interpolates between them, and
// across the whole page the sun rises (Timór Lorosa'e: where the sun rises)
// while Cristo Rei travels from the top of the frame down to the bottom.

export type ShotId = "hero" | "name" | "facts" | "history" | "land" | "culture" | "cristo" | "closing";

export const DESKTOP_SHOTS: Record<ShotId, Rig> = {
  hero: { theta: 0, radius: 12.5, height: 1.2, targetY: 3.6, offset: 0, sunElev: 3, title: 1 },
  name: { theta: 24, radius: 11.5, height: 2.4, targetY: 3.2, offset: -2.3, sunElev: 4, title: 0 },
  facts: { theta: -22, radius: 12, height: 3.4, targetY: 3.4, offset: 2.5, sunElev: 4.5, title: 0 },
  history: { theta: 68, radius: 12.5, height: 4.6, targetY: 4.0, offset: -2.6, sunElev: 6.5, title: 0 },
  land: { theta: 150, radius: 22, height: 8.5, targetY: 3.6, offset: 4.2, sunElev: 8.5, title: 0 },
  culture: { theta: 228, radius: 11, height: 2.2, targetY: 3.4, offset: -2.4, sunElev: 10.5, title: 0 },
  cristo: { theta: 352, radius: 6.2, height: 3.6, targetY: 3.5, offset: 1.25, sunElev: 12.5, title: 0 },
  closing: { theta: 360, radius: 16, height: 2.4, targetY: 6.5, offset: 0, sunElev: 15, title: 0 },
};

// On narrow screens text sits over the statue, so it stays centred and further away.
export const MOBILE_SHOTS: Record<ShotId, Rig> = Object.fromEntries(
  Object.entries(DESKTOP_SHOTS).map(([id, s]) => [
    id,
    { ...s, offset: 0, radius: s.radius * 1.18, targetY: id === "closing" ? s.targetY : s.targetY + 0.6 },
  ]),
) as Record<ShotId, Rig>;

export function mixShots(a: Rig, b: Rig, t: number): Rig {
  const out = { ...a };
  for (const key of Object.keys(a) as (keyof Rig)[]) {
    out[key] = a[key] + (b[key] - a[key]) * t;
  }
  return out;
}
