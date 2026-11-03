import { CRISTO_REI, TASI_TOLU, toDili } from "../geo";

// The Dili flyover in local metres: in over the coast west of Tasi Tolu,
// across the lakes, along the coast over Comoro to the Government Palace,
// across the bay to Cristo Rei on Cape Fatucama. Shared by the scene (to fly
// it) and the build worker (to decide which buildings the camera can see).

export function diliRoutePoints(statueGround = 75): [number, number, number][] {
  const [tx, tz] = toDili(TASI_TOLU);
  const [sx, sz] = toDili(CRISTO_REI);
  return [
    [tx - 1800, 360, tz - 1500],
    [tx - 300, 300, tz - 250],
    [tx + 1900, 330, tz - 1200],
    [-2700, 330, -260],
    [-260, 230, -70],
    [1400, 300, -950],
    [2700, 270, -2650],
    [sx - 80, statueGround + 170, sz + 120],
    [sx + 700, 300, sz - 900],
  ];
}

/** Horizontal distance from a point to the route's polyline. */
export function distanceToRoute(x: number, z: number, pts = diliRoutePoints()) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, , az] = pts[i];
    const [bx, , bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
  }
  return best;
}
