/* =====================================================================
   TRACK — deterministic procedural rail line.

   Every client builds the EXACT same track from a fixed seed, so a cart's
   world position is fully described by one number: s, its distance along
   the rail (in metres). That is all multiplayer needs to send.

   The centreline is built by walking forward in fixed DS steps, turning by a
   per-metre yaw curvature kappa(s) and pitching up/down by theta(s) for hills.
   Because every step advances exactly DS along a unit direction, arc length is
   simply i*DS — sampling by distance is trivial and exact.
   ===================================================================== */
const Track = (() => {
  const DS = 8;                 // metres between centreline nodes
  const N = 3150;               // node count  ->  LENGTH = 25,200 m
  const LENGTH = N * DS;        // ~30 min at a cruising ~14 m/s
  const ROAD_W = 1.9;           // ballast-bed half-width (rails sit inside this)
  const BIOME_LEN = 3000;       // metres per scenery section

  // ---- seeded PRNG (mulberry32) — identical sequence on every machine ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const biomes = [
    { name: "Pine Forest", ground: [0.22, 0.46, 0.20], fog: [0.74, 0.86, 0.78], fogD: 0.0072, sky: [0.55, 0.74, 0.92], scenery: "tree" },
    { name: "Red Canyon",  ground: [0.70, 0.45, 0.24], fog: [0.93, 0.82, 0.62], fogD: 0.0060, sky: [0.86, 0.74, 0.55], scenery: "cactus" },
    { name: "Crystal Cave", ground: [0.13, 0.13, 0.17], fog: [0.04, 0.05, 0.09], fogD: 0.0150, sky: [0.03, 0.03, 0.06], scenery: "tunnel" },
    { name: "Neon City",   ground: [0.08, 0.07, 0.16], fog: [0.10, 0.06, 0.22], fogD: 0.0090, sky: [0.05, 0.03, 0.12], scenery: "neon" },
    { name: "Snowfield",   ground: [0.90, 0.93, 0.97], fog: [0.86, 0.91, 0.96], fogD: 0.0085, sky: [0.80, 0.87, 0.95], scenery: "pine" },
    { name: "Sunny Beach", ground: [0.91, 0.84, 0.62], fog: [0.78, 0.90, 0.98], fogD: 0.0060, sky: [0.50, 0.78, 0.95], scenery: "palm" },
  ];

  // flat typed arrays for cheap sampling / mesh building
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const tx = new Float32Array(N), ty = new Float32Array(N), tz = new Float32Array(N); // tangent
  const rx = new Float32Array(N), ry = new Float32Array(N), rz = new Float32Array(N); // banked right
  const ux = new Float32Array(N), uy = new Float32Array(N), uz = new Float32Array(N); // banked up
  const kap = new Float32Array(N);   // |horizontal curvature| (1/radius) for derail physics
  let built = false;

  // Corners are discrete features: gentle ones are safe, tight ones are the
  // "don't take it too fast" hazards. Curvature is constant across a corner so
  // the critical speed is well defined.
  function buildCorners(rng) {
    const corners = [];
    let s = 300;
    while (s < LENGTH - 400) {
      const tight = rng() < 0.55;
      const R = tight ? 15 + rng() * 16 : 40 + rng() * 55;   // radius (m) — eased so a boost into a bend is survivable
      const ang = (tight ? 0.7 + rng() * 1.1 : 0.5 + rng() * 0.95) * (rng() < 0.5 ? 1 : -1);
      const Lc = Math.abs(ang) * R;                          // arc length
      corners.push({ a: s, b: s + Lc, k: ang / Lc });        // signed curvature
      s += Lc + 150 + rng() * 360;                           // much shorter gaps -> lots of corners
    }
    return corners;
  }

  function build(seed) {
    if (built) return Track;
    const rng = mulberry32(seed >>> 0);
    const corners = buildCorners(rng);

    // smooth base wander so straights aren't dead straight (always safe radius)
    const baseYaw = (s) => 0.00055 * Math.sin(s * 0.00041) + 0.00085 * Math.sin(s * 0.00103 + 2.1);
    // steep roller-coaster hills, biased toward descents (more downhills)
    const pitch = (s) =>
      0.205 * Math.sin(s * 0.00060 + 0.5) +
      0.125 * Math.sin(s * 0.00150 + 2.2) +
      0.070 * Math.sin(s * 0.00340 + 4.0) -
      0.045;   // net downhill bias

    let x = 0, y = 0, z = 0, heading = 0;
    let ci = 0;
    for (let i = 0; i < N; i++) {
      const s = i * DS;
      // curvature from base wander + any corner covering this s
      let k = baseYaw(s);
      while (ci < corners.length && s > corners[ci].b) ci++;
      if (ci < corners.length && s >= corners[ci].a && s <= corners[ci].b) k += corners[ci].k;
      kap[i] = Math.abs(k);

      const th = pitch(s);
      px[i] = x; py[i] = y; pz[i] = z;

      const ct = Math.cos(th);
      const dx = Math.cos(heading) * ct;
      const dy = Math.sin(th);
      const dz = Math.sin(heading) * ct;
      tx[i] = dx; ty[i] = dy; tz[i] = dz;

      // frame: right = up x tangent (horizontal), then bank it into the turn
      let rX = dz, rY = 0, rZ = -dx;                         // cross((0,1,0), tangent)
      const rl = Math.hypot(rX, rY, rZ) || 1;
      rX /= rl; rZ /= rl;
      const bank = Math.max(-0.35, Math.min(0.35, k * 90));
      // rotate (right,up) about the tangent by the bank angle
      let uX = ty[i] * rZ - tz[i] * rY, uY = tz[i] * rX - tx[i] * rZ, uZ = tx[i] * rY - ty[i] * rX;
      const ul = Math.hypot(uX, uY, uZ) || 1; uX /= ul; uY /= ul; uZ /= ul;
      const cb = Math.cos(bank), sb = Math.sin(bank);
      rx[i] = rX * cb + uX * sb; ry[i] = rY * cb + uY * sb; rz[i] = rZ * cb + uZ * sb;
      ux[i] = uX * cb - rX * sb; uy[i] = uY * cb - rY * sb; uz[i] = uZ * cb - rZ * sb;

      x += dx * DS; y += dy * DS; z += dz * DS;
      heading += k * DS;
    }
    built = true;
    return Track;
  }

  // sample any distance s -> position + frame + curvature (linear interp)
  function sample(s, out) {
    out = out || {};
    if (s < 0) s = 0; else if (s > LENGTH - DS) s = LENGTH - DS;
    const fi = s / DS;
    let i = fi | 0; if (i >= N - 1) i = N - 2;
    const t = fi - i, j = i + 1;
    out.x = px[i] + (px[j] - px[i]) * t;
    out.y = py[i] + (py[j] - py[i]) * t;
    out.z = pz[i] + (pz[j] - pz[i]) * t;
    out.tx = tx[i] + (tx[j] - tx[i]) * t;
    out.ty = ty[i] + (ty[j] - ty[i]) * t;
    out.tz = tz[i] + (tz[j] - tz[i]) * t;
    const tl = Math.hypot(out.tx, out.ty, out.tz) || 1;
    out.tx /= tl; out.ty /= tl; out.tz /= tl;
    out.rx = rx[i] + (rx[j] - rx[i]) * t; out.ry = ry[i] + (ry[j] - ry[i]) * t; out.rz = rz[i] + (rz[j] - rz[i]) * t;
    out.uxp = ux[i] + (ux[j] - ux[i]) * t; out.uyp = uy[i] + (uy[j] - uy[i]) * t; out.uzp = uz[i] + (uz[j] - uz[i]) * t;
    out.kappa = kap[i] + (kap[j] - kap[i]) * t;
    return out;
  }

  function biomeAt(s) {
    const f = s / BIOME_LEN;
    const idx = Math.floor(f) % biomes.length;
    const frac = f - Math.floor(f);
    const blend = frac > 0.85 ? (frac - 0.85) / 0.15 : 0; // blend in last 15% toward next
    const nextIdx = (idx + 1) % biomes.length;
    return { idx, blend, def: biomes[idx], next: biomes[nextIdx], name: biomes[idx].name };
  }

  return {
    DS, N, LENGTH, ROAD_W, biomes,
    build, sample, biomeAt,
    // raw arrays (used by the chunk mesh builder)
    px, py, pz, rx, ry, rz, ux, uy, uz, tx, ty, tz, kap,
  };
})();
