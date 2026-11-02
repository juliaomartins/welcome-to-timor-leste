import * as THREE from "three";

// A procedural twin-engine airliner in a Timor-Leste livery. Built from lathe
// and extruded profiles instead of primitives so it reads as one machined
// object. Forward is +Z, up is +Y, so the pilot's left wing sits on +X.

const FLAG_RED = "#dc241f";
const FLAG_YELLOW = "#ffc726";
const FLAG_BLACK = "#121212";

function fuselageProfile(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const R = 0.22;
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const y = -2 + (4 * i) / steps; // tail (-2) to nose (+2)
    let r: number;
    if (y > 1.35) {
      const t = (y - 1.35) / 0.65;
      r = R * Math.sqrt(Math.max(0, 1 - t * t * t));
    } else if (y < -0.85) {
      const t = (y + 2) / 1.15; // 0 at tail tip, 1 at taper start
      r = 0.045 + (R - 0.045) * Math.pow(Math.sin((t * Math.PI) / 2), 1.2);
    } else {
      r = R;
    }
    pts.push(new THREE.Vector2(Math.max(r, 0.0001), y));
  }
  return pts;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Lathe UVs: u wraps the circumference (0 = belly, 0.5 = crown), v runs tail -> nose.
function fuselageTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 512;
  const c = makeCanvas(W, H);
  const g = c.getContext("2d")!;
  // Canvas x = circumference, canvas y = length (top = nose because of flipY).
  const belly = g.createLinearGradient(0, 0, W, 0);
  belly.addColorStop(0, "#c9ccd1");
  belly.addColorStop(0.22, "#f4f5f7");
  belly.addColorStop(0.5, "#fbfbfc");
  belly.addColorStop(0.78, "#f4f5f7");
  belly.addColorStop(1, "#c9ccd1");
  g.fillStyle = belly;
  g.fillRect(0, 0, W, H);

  const lenToY = (v: number) => (1 - v) * H;
  for (const side of [0.3, 0.7]) {
    const dir = side < 0.5 ? -1 : 1;
    // Cheatline in flag colours, sitting just under the window row.
    const cx = side * W;
    g.fillStyle = FLAG_RED;
    g.fillRect(cx + dir * 34 - 9, lenToY(0.97), 18, lenToY(0.08) - lenToY(0.97));
    g.fillStyle = FLAG_YELLOW;
    g.fillRect(cx + dir * 56 - 4, lenToY(0.95), 8, lenToY(0.1) - lenToY(0.95));
    // Passenger windows.
    g.fillStyle = "#1b2430";
    for (let v = 0.24; v < 0.83; v += 0.0135) {
      const y = lenToY(v);
      g.beginPath();
      g.roundRect(cx - 5, y - 3, 10, 6, 3);
      g.fill();
    }
    // Doors.
    g.strokeStyle = "rgba(60,70,80,0.55)";
    g.lineWidth = 2;
    for (const v of [0.86, 0.2]) {
      g.strokeRect(cx - 16, lenToY(v) - 14, 32, 22);
    }
  }
  // Cockpit windscreen wraps the crown just behind the nose cone.
  g.fillStyle = "#121a24";
  g.beginPath();
  g.moveTo(0.36 * W, lenToY(0.925));
  g.lineTo(0.64 * W, lenToY(0.925));
  g.lineTo(0.6 * W, lenToY(0.9));
  g.lineTo(0.4 * W, lenToY(0.9));
  g.closePath();
  g.fill();

  // Subtle panel seams so the clearcoat has something to catch.
  g.strokeStyle = "rgba(90,100,110,0.18)";
  g.lineWidth = 1;
  for (let v = 0.1; v < 0.95; v += 0.07) {
    g.beginPath();
    g.moveTo(0, lenToY(v));
    g.lineTo(W, lenToY(v));
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// The tail carries the national flag: red field, yellow and black chevrons, white star.
function flagTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const c = makeCanvas(W, H);
  const g = c.getContext("2d")!;
  g.fillStyle = FLAG_RED;
  g.fillRect(0, 0, W, H);
  g.fillStyle = FLAG_YELLOW;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(W * 0.5, H / 2);
  g.lineTo(0, H);
  g.fill();
  g.fillStyle = FLAG_BLACK;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(W * 0.33, H / 2);
  g.lineTo(0, H);
  g.fill();
  // Five-pointed white star, tilted as on the flag.
  g.save();
  g.translate(W * 0.12, H / 2);
  g.rotate(-0.4);
  g.fillStyle = "#ffffff";
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? H * 0.13 : H * 0.052;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function planform(points: [number, number][], depth: number, bevel: number) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 4,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

export type Airliner = {
  group: THREE.Group;
  update: (time: number) => void;
  dispose: () => void;
};

export function createAirliner(): Airliner {
  const group = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(o: T) => {
    disposables.push(o);
    return o;
  };

  const paint = track(
    new THREE.MeshPhysicalMaterial({
      map: track(fuselageTexture()),
      roughness: 0.28,
      metalness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
    }),
  );
  const wingMetal = track(
    new THREE.MeshPhysicalMaterial({
      color: "#d9dde2",
      roughness: 0.38,
      metalness: 0.55,
      clearcoat: 0.4,
      clearcoatRoughness: 0.2,
    }),
  );
  const engineMetal = track(
    new THREE.MeshPhysicalMaterial({ color: "#eef0f2", roughness: 0.25, metalness: 0.35, clearcoat: 1 }),
  );
  const darkMetal = track(new THREE.MeshStandardMaterial({ color: "#2a2f35", roughness: 0.35, metalness: 0.9 }));
  const flagTex = track(flagTexture());
  const tailPaint = track(
    new THREE.MeshPhysicalMaterial({ map: flagTex, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }),
  );

  // Fuselage.
  const fuselageGeo = track(new THREE.LatheGeometry(fuselageProfile(), 64));
  fuselageGeo.rotateX(Math.PI / 2);
  const fuselage = new THREE.Mesh(fuselageGeo, paint);
  group.add(fuselage);

  // Main wings: swept planform, slight dihedral.
  const wingGeo = track(
    planform(
      [
        [0.12, 0.62],
        [2.15, -0.42],
        [2.18, -0.6],
        [0.12, -0.42],
      ],
      0.045,
      0.02,
    ),
  );
  wingGeo.rotateX(Math.PI / 2);
  for (const side of [1, -1]) {
    const wing = new THREE.Mesh(wingGeo, wingMetal);
    wing.position.set(0, -0.1, 0.05);
    wing.scale.x = side;
    wing.rotation.z = side * 0.07;
    group.add(wing);

    // Winglet.
    const wingletGeo = track(planform([[0, 0], [0.22, 0.32], [0.3, 0.32], [0.24, 0]], 0.02, 0.01));
    wingletGeo.rotateY(-Math.PI / 2);
    const winglet = new THREE.Mesh(wingletGeo, tailPaint);
    winglet.position.set(side * 2.16, 0.05, -0.42);
    winglet.rotation.z = -side * 0.12;
    winglet.scale.x = side;
    group.add(winglet);

    // Engine nacelle under each wing.
    const nacelleProfile = [
      new THREE.Vector2(0.0001, -0.32),
      new THREE.Vector2(0.07, -0.3),
      new THREE.Vector2(0.105, -0.12),
      new THREE.Vector2(0.125, 0.12),
      new THREE.Vector2(0.13, 0.27),
      new THREE.Vector2(0.115, 0.32),
    ];
    const nacelleGeo = track(new THREE.LatheGeometry(nacelleProfile, 40));
    nacelleGeo.rotateX(Math.PI / 2);
    const nacelle = new THREE.Mesh(nacelleGeo, engineMetal);
    nacelle.position.set(side * 0.78, -0.27, 0.42);
    group.add(nacelle);

    const fanGeo = track(new THREE.CircleGeometry(0.108, 32));
    const fan = new THREE.Mesh(fanGeo, darkMetal);
    fan.position.set(side * 0.78, -0.27, 0.735);
    group.add(fan);

    const spinnerGeo = track(new THREE.ConeGeometry(0.035, 0.07, 20));
    spinnerGeo.rotateX(Math.PI / 2);
    const spinner = new THREE.Mesh(spinnerGeo, engineMetal);
    spinner.position.set(side * 0.78, -0.27, 0.77);
    group.add(spinner);

    const pylonGeo = track(new THREE.BoxGeometry(0.03, 0.12, 0.4));
    const pylon = new THREE.Mesh(pylonGeo, wingMetal);
    pylon.position.set(side * 0.78, -0.16, 0.36);
    group.add(pylon);

    // Horizontal stabiliser.
    const stabGeo = track(
      planform(
        [
          [0.05, 0.25],
          [0.78, -0.12],
          [0.8, -0.26],
          [0.05, -0.12],
        ],
        0.028,
        0.012,
      ),
    );
    stabGeo.rotateX(Math.PI / 2);
    const stab = new THREE.Mesh(stabGeo, wingMetal);
    stab.position.set(0, 0.02, -1.72);
    stab.scale.x = side;
    stab.rotation.z = side * 0.1;
    group.add(stab);
  }

  // Vertical fin with the flag. ExtrudeGeometry UVs equal the shape coordinates,
  // so the texture is remapped to the fin's bounding box.
  const finPoints: [number, number][] = [
    [-2.02, 0.12],
    [-1.12, 0.12],
    [-1.72, 1.02],
    [-2.0, 1.02],
  ];
  const finGeo = track(planform(finPoints, 0.035, 0.012));
  finGeo.rotateY(-Math.PI / 2);
  flagTex.repeat.set(1 / 0.92, 1 / 0.92);
  flagTex.offset.set(2.04 / 0.92, -0.11 / 0.92);
  flagTex.wrapS = flagTex.wrapT = THREE.ClampToEdgeWrapping;
  // Flip horizontally so the hoist (black chevron) faces forward.
  flagTex.repeat.x *= -1;
  flagTex.offset.x = 1 - flagTex.offset.x + 0.0;
  const fin = new THREE.Mesh(finGeo, tailPaint);
  group.add(fin);

  // Navigation lights: red on the left (+X), green on the right, white strobe on the tail.
  const lightGeo = track(new THREE.SphereGeometry(0.03, 12, 12));
  const red = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(20, 1, 0.8) }));
  const green = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 18, 3) }));
  const strobeMat = track(new THREE.MeshBasicMaterial({ color: new THREE.Color(30, 30, 30) }));
  const navL = new THREE.Mesh(lightGeo, red);
  navL.position.set(2.18, 0.0, -0.5);
  const navR = new THREE.Mesh(lightGeo, green);
  navR.position.set(-2.18, 0.0, -0.5);
  const strobe = new THREE.Mesh(lightGeo, strobeMat);
  strobe.position.set(0, 1.04, -1.98);
  group.add(navL, navR, strobe);

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !((o as THREE.Mesh).material instanceof THREE.MeshBasicMaterial)) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return {
    group,
    update(time: number) {
      // Double flash every 1.2 s, like a real anti-collision strobe.
      const t = time % 1.2;
      strobe.visible = t < 0.05 || (t > 0.12 && t < 0.17);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
