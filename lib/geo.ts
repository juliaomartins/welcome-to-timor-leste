// Geographic frames used by the intro. Every landmark is placed from real
// coordinates: Google Maps pins supplied by the site owner, OpenStreetMap
// geometry (ODbL) and Terrarium elevation tiles.

export type LonLat = { lon: number; lat: number };

/** Island-scale relief (public/data/timor-relief.png): same framing as the Wikimedia map. */
export const ISLAND_BOUNDS = { lonW: 122.49, latS: -11.13, lonE: 127.54, latN: -7.35 };

/** City-scale relief (public/data/dili-relief.png), 10 m cells. */
export const DILI_BOUNDS = { lonW: 125.48, latS: -8.61, lonE: 125.65, latN: -8.5 };

/** Wider, coarser ring around Dili (public/data/dili-far-relief.png). */
export const DILI_FAR_BOUNDS = { lonW: 125.2, latS: -8.95, lonE: 125.95, latN: -8.3 };

// Pins from the Google Maps links (place markers), and the Tasi Tolu coordinate given by the owner.
export const CRISTO_REI: LonLat = { lat: -8.5204833, lon: 125.6083883 };
export const GOVERNMENT_PALACE: LonLat = { lat: -8.5543251, lon: 125.5786272 };
export const TASI_TOLU: LonLat = { lat: -8.564036, lon: 125.5108 };

// Local metric frame for Dili: origin at the Government Palace, x east, z south (north is -z), metres.
const LAT0 = GOVERNMENT_PALACE.lat;
const LON0 = GOVERNMENT_PALACE.lon;
export const KX = Math.cos((LAT0 * Math.PI) / 180) * 111320;
export const KZ = 110574;

export function toDili({ lon, lat }: LonLat): [number, number] {
  return [(lon - LON0) * KX, (LAT0 - lat) * KZ];
}

export function diliBoundsXZ(b: { lonW: number; latS: number; lonE: number; latN: number }) {
  const [xW, zN] = toDili({ lon: b.lonW, lat: b.latN });
  const [xE, zS] = toDili({ lon: b.lonE, lat: b.latS });
  return { xW, xE, zN, zS };
}

/** Island map UV (0..1 from the top-left) for a coordinate. */
export function islandUV({ lon, lat }: LonLat): [number, number] {
  const b = ISLAND_BOUNDS;
  return [(lon - b.lonW) / (b.lonE - b.lonW), (b.latN - lat) / (b.latN - b.latS)];
}
