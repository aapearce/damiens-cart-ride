/* =====================================================================
   MAIN — Babylon scene, cart physics, streamed track, multiplayer carts.
   ===================================================================== */
(() => {
  const V = BABYLON.Vector3, C3 = BABYLON.Color3, Q = BABYLON.Quaternion;
  const SEED = 73331;            // shared world seed — same line for everyone
  const DS = Track.DS, N = Track.N, W = Track.ROAD_W;
  const GAUGE = 0.7;                     // half-distance between the two rails
  const SKIRT = 15;                      // half-width of the ground that follows the rail
  const CHUNK_NODES = 12;
  const NUM_CHUNKS = Math.ceil(N / CHUNK_NODES);

  // physics
  const A_ENG = 16, A_BRAKE = 34, A_REV = 7;
  const V_MAX = 72.2, V_REV_MAX = -8;   // m/s  (72.2 ≈ 260 km/h top speed)
  const G = 15;                          // strong gravity — steep hills really pull
  const A_LAT_MAX = 7.6;                 // base lateral grip; scaled by cart stability
  const V_MAX_BOOST = 95;                // temporary speed cap while a boost is active (m/s)
  const BOOST_ADD = 19, BOOST_TIME = 1.2; // surge added on a boost pad + how long the higher cap holds
  const JUMP_V0 = 7.5, G_AIR = 23;       // launch speed off a jump pad + airborne gravity
  const DERAIL_GRACE = 0.32;             // seconds you can exceed lateral grip before flying off

  Track.build(SEED);

  function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

  // ---------------------------------------------------------------- engine
  const canvas = document.getElementById("renderCanvas");
  const engine = new BABYLON.Engine(canvas, true, { stencil: false, preserveDrawingBuffer: false });
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.55, 0.74, 0.92, 1);
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogColor = new C3(0.74, 0.86, 0.78);
  scene.fogDensity = 0.0072;
  scene.skipPointerMovePicking = true;

  // gradient sky as a non-fogged background layer (a real skydome would be
  // swallowed by the exp² fog at this density)
  const skyTex = new BABYLON.DynamicTexture("skytex", { width: 8, height: 256 }, scene, false);
  skyTex.wrapU = skyTex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
  const skyCtx = skyTex.getContext();
  const skyLayer = new BABYLON.Layer("sky", null, scene, true);
  skyLayer.texture = skyTex;
  const rgbOf = (c) => "rgb(" + (c[0] * 255 | 0) + "," + (c[1] * 255 | 0) + "," + (c[2] * 255 | 0) + ")";
  function paintSky(top, hor) {
    const g = skyCtx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, rgbOf(top));
    g.addColorStop(0.6, rgbOf([(top[0] + hor[0]) / 2, (top[1] + hor[1]) / 2, (top[2] + hor[2]) / 2]));
    g.addColorStop(1, rgbOf(hor));
    skyCtx.fillStyle = g; skyCtx.fillRect(0, 0, 8, 256); skyTex.update();
  }
  paintSky([0.55, 0.74, 0.92], [0.74, 0.86, 0.78]);
  scene.autoClearDepthAndStencil = true;

  const hemi = new BABYLON.HemisphericLight("h", new V(0.2, 1, 0.15), scene);
  hemi.intensity = 0.95;
  hemi.groundColor = new C3(0.4, 0.4, 0.45);
  const sun = new BABYLON.DirectionalLight("s", new V(-0.4, -0.8, 0.35), scene);
  sun.intensity = 0.85;

  const camera = new BABYLON.UniversalCamera("cam", new V(0, 6, -12), scene);
  camera.fov = 1.05;
  camera.minZ = 0.3; camera.maxZ = 1600;
  let camTarget = new V(0, 0, 0);

  // ---------------------------------------------------------------- materials
  const mat = (name, r, g, b, em) => { const m = new BABYLON.StandardMaterial(name, scene); m.diffuseColor = new C3(r, g, b); m.specularColor = new C3(0.05, 0.05, 0.05); if (em) m.emissiveColor = new C3(em[0], em[1], em[2]); return m; };
  const matBallast = mat("ballast", 0.27, 0.26, 0.25); matBallast.specularColor = new C3(0, 0, 0);
  const matSleeper = mat("sleeper", 0.30, 0.20, 0.12);
  const matRail = mat("rail", 0.66, 0.68, 0.74); matRail.specularColor = new C3(0.6, 0.6, 0.65); matRail.emissiveColor = new C3(0.10, 0.11, 0.13);
  const matTrunk = mat("trunk", 0.36, 0.24, 0.13);
  const matLeaf = mat("leaf", 0.13, 0.45, 0.16);
  const matPine = mat("pineL", 0.12, 0.38, 0.22);
  const matSnowTip = mat("snow", 0.92, 0.95, 0.98);
  const matCactus = mat("cac", 0.20, 0.50, 0.26);
  const matRock = mat("rock", 0.45, 0.43, 0.42);
  const matPalmL = mat("palm", 0.18, 0.52, 0.22);
  const matRing = mat("ring", 0.12, 0.16, 0.28, [0.10, 0.22, 0.45]);
  // cart parts (shared across all carts; the tub colour is per-cart)
  const matChassis = mat("chassis", 0.17, 0.17, 0.20); matChassis.specularColor = new C3(0.45, 0.45, 0.5);
  const matRim = mat("crim", 0.56, 0.58, 0.63); matRim.specularColor = new C3(0.65, 0.65, 0.7);
  const matWheel = mat("cwheel", 0.06, 0.06, 0.07);
  const matCartIn = mat("cartin", 0.11, 0.11, 0.13);
  const matLight = mat("clight", 0.95, 0.9, 0.55, [1.0, 0.92, 0.55]);
  const matSkin = mat("cskin", 0.85, 0.66, 0.5);
  const matSkirt = mat("skirt", 1, 1, 1); matSkirt.specularColor = new C3(0, 0, 0); matSkirt.backFaceCulling = false; // colour comes from per-vertex data
  const neonMats = [[1.0, 0.18, 0.5], [0.2, 0.9, 1.0], [0.7, 0.3, 1.0], [1.0, 0.8, 0.2]].map((c, i) => mat("neon" + i, c[0] * 0.3, c[1] * 0.3, c[2] * 0.3, c));

  // ---------------------------------------------------------------- prototypes
  // multiMultiMaterials:true keeps each part's own colour (trunk vs leaves, etc.)
  function merge(list, m) { const mesh = BABYLON.Mesh.MergeMeshes(list, true, true, undefined, false, !m); if (m) mesh.material = m; mesh.setEnabled(false); mesh.isPickable = false; return mesh; }
  function cyl(name, dT, dB, h, y, m) { const c = BABYLON.MeshBuilder.CreateCylinder(name, { diameterTop: dT, diameterBottom: dB, height: h, tessellation: 7 }, scene); c.position.y = y; c.material = m; return c; }

  function makeTree() { const t = cyl("tt", 0.4, 0.5, 2.2, 1.1, matTrunk); const f = BABYLON.MeshBuilder.CreateSphere("tf", { diameter: 3, segments: 6 }, scene); f.position.y = 3; f.scaling.y = 1.2; f.material = matLeaf; return merge([t, f]); }
  function makePine() { const t = cyl("pt", 0.3, 0.45, 1.6, 0.8, matTrunk); const a = cyl("p1", 0, 2.6, 2, 2.4, matPine); const b = cyl("p2", 0, 2.0, 1.7, 3.4, matPine); const c = cyl("p3", 0, 1.3, 1.3, 4.3, matSnowTip); return merge([t, a, b, c]); }
  function makeCactus() { const b = cyl("cb", 0.9, 1.0, 3, 1.5, matCactus); const l = cyl("cl", 0.45, 0.45, 1.4, 2.2, matCactus); l.position.x = 0.8; l.rotation.z = -0.5; const r = cyl("cr", 0.45, 0.45, 1.2, 1.8, matCactus); r.position.x = -0.75; r.rotation.z = 0.5; return merge([b, l, r]); }
  function makePalm() { const t = cyl("plt", 0.32, 0.5, 4.2, 2.1, matTrunk); t.rotation.z = 0.12; const f = BABYLON.MeshBuilder.CreateSphere("plf", { diameter: 3.2, segments: 5 }, scene); f.position.set(0.4, 4.3, 0); f.scaling.set(1.2, 0.32, 1.2); f.material = matPalmL; return merge([t, f]); }
  function makeRock() { const r = BABYLON.MeshBuilder.CreatePolyhedron("rk", { type: 1, size: 1 }, scene); r.scaling.set(1.4, 0.9, 1.2); r.position.y = 0.6; r.material = matRock; return merge([r], matRock); }
  function makeNeon(i) { const p = BABYLON.MeshBuilder.CreateBox("nb", { width: 0.35, depth: 0.35, height: 5.5 }, scene); p.position.y = 2.75; p.material = neonMats[i % neonMats.length]; const top = BABYLON.MeshBuilder.CreateSphere("nt", { diameter: 1.1, segments: 6 }, scene); top.position.y = 5.6; top.material = neonMats[i % neonMats.length]; return merge([p, top], neonMats[i % neonMats.length]); }
  function makeRing() { const r = BABYLON.MeshBuilder.CreateTorus("rg", { diameter: 8, thickness: 0.55, tessellation: 14 }, scene); r.material = matRing; return merge([r], matRing); }

  const protoTree = makeTree(), protoPine = makePine(), protoCactus = makeCactus(),
        protoPalm = makePalm(), protoRock = makeRock(), protoRing = makeRing();
  const protoNeon = [makeNeon(0), makeNeon(1), makeNeon(2), makeNeon(3)];
  function protoFor(kind, r) {
    switch (kind) {
      case "tree": return protoTree; case "pine": return protoPine;
      case "cactus": return protoCactus; case "palm": return protoPalm;
      case "neon": return protoNeon[(r * 4) | 0]; case "tunnel": return protoRock;
      default: return protoTree;
    }
  }

  // ---------------------------------------------------------------- orient helpers
  const _r = new V(), _u = new V(), _f = new V();
  function orientFwd(mesh, fx, fy, fz, ux, uy, uz) {
    _f.set(fx, fy, fz); _u.set(ux, uy, uz);
    V.CrossToRef(_u, _f, _r); _r.normalize();        // right = up x fwd
    V.CrossToRef(_f, _r, _u); _u.normalize();        // re-orthogonalise up
    if (!mesh.rotationQuaternion) mesh.rotationQuaternion = new Q();
    Q.RotationQuaternionFromAxisToRef(_r, _u, _f, mesh.rotationQuaternion);
  }
  function orientRing(mesh, tx, ty, tz) {            // torus axis (local Y) -> tangent
    _f.set(tx, ty, tz);
    _r.set(0, 1, 0); V.CrossToRef(_r, _f, _r); if (_r.lengthSquared() < 1e-4) _r.set(1, 0, 0); _r.normalize();
    V.CrossToRef(_f, _r, _u); _u.normalize();
    if (!mesh.rotationQuaternion) mesh.rotationQuaternion = new Q();
    Q.RotationQuaternionFromAxisToRef(_r, _f, _u, mesh.rotationQuaternion);
  }

  // ---------------------------------------------------------------- chunks
  const chunks = new Map();
  function buildChunk(ci) {
    if (chunks.has(ci)) return;
    const c0 = ci * CHUNK_NODES, c1 = Math.min(c0 + CHUNK_NODES, N - 1);
    if (c1 <= c0) { chunks.set(ci, { meshes: [], scenery: [] }); return; }
    const bl = [], br = [], railL = [], railR = [], skL = [], skC = [], skR = [];
    for (let i = c0; i <= c1; i++) {
      const ax = Track.px[i], ay = Track.py[i], az = Track.pz[i];
      const Rx = Track.rx[i], Ry = Track.ry[i], Rz = Track.rz[i];
      const Ux = Track.ux[i], Uy = Track.uy[i], Uz = Track.uz[i];
      bl.push(new V(ax + Rx * W + Ux * 0.04, ay + Ry * W + Uy * 0.04, az + Rz * W + Uz * 0.04));
      br.push(new V(ax - Rx * W + Ux * 0.04, ay - Ry * W + Uy * 0.04, az - Rz * W + Uz * 0.04));
      railL.push(new V(ax + Rx * GAUGE + Ux * 0.24, ay + Ry * GAUGE + Uy * 0.24, az + Rz * GAUGE + Uz * 0.24));
      railR.push(new V(ax - Rx * GAUGE + Ux * 0.24, ay - Ry * GAUGE + Uy * 0.24, az - Rz * GAUGE + Uz * 0.24));
      // terrain skirt: flat horizontal cross-section following the rail's height.
      // Taper width in tight corners so the inner edge never folds past centre.
      const hx = Track.tz[i], hz = -Track.tx[i], hl = Math.hypot(hx, hz) || 1;
      const wgt = Math.min(SKIRT, 0.85 / Math.max(Track.kap[i], 1e-4));
      const gy = ay - 0.4;
      skC.push(new V(ax, gy, az));
      skL.push(new V(ax + (hx / hl) * wgt, gy, az + (hz / hl) * wgt));
      skR.push(new V(ax - (hx / hl) * wgt, gy, az - (hz / hl) * wgt));
    }
    // terrain skirt — centre uses the biome ground colour, edges fade to the
    // fog/horizon colour (per-vertex) so there's no hard edge against the sky
    const skirt = BABYLON.MeshBuilder.CreateRibbon("sk" + ci, { pathArray: [skL, skC, skR] }, scene);
    skirt.material = matSkirt; skirt.isPickable = false;
    { const bdef = Track.biomeAt(((c0 + c1) / 2) * DS).def, g = bdef.ground, f = bdef.fog, vc = skC.length, cols = [];
      const push = (c) => cols.push(c[0], c[1], c[2], 1);
      for (let k = 0; k < vc; k++) push(f); for (let k = 0; k < vc; k++) push(g); for (let k = 0; k < vc; k++) push(f);
      skirt.setVerticesData(BABYLON.VertexBuffer.ColorKind, cols); }
    skirt.freezeWorldMatrix();
    // gravel ballast bed
    const ballast = BABYLON.MeshBuilder.CreateRibbon("bl" + ci, { pathArray: [bl, br], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    ballast.material = matBallast; ballast.isPickable = false; ballast.freezeWorldMatrix();
    // two steel rails
    const tl = BABYLON.MeshBuilder.CreateTube("tl" + ci, { path: railL, radius: 0.085, tessellation: 6, cap: BABYLON.Mesh.NO_CAP }, scene);
    const tr = BABYLON.MeshBuilder.CreateTube("tr" + ci, { path: railR, radius: 0.085, tessellation: 6, cap: BABYLON.Mesh.NO_CAP }, scene);
    const rail = BABYLON.Mesh.MergeMeshes([tl, tr], true) || tl;
    rail.material = matRail; rail.isPickable = false; rail.freezeWorldMatrix();
    // wooden sleepers (3 per node gap, merged into one mesh for cheap drawing)
    const sleepers = [];
    for (let i = c0; i < c1; i++) for (let k = 0; k < 3; k++) {
      Track.sample((i + k / 3) * DS, tmp);
      const b = BABYLON.MeshBuilder.CreateBox("sp", { width: GAUGE * 2 + 0.7, height: 0.16, depth: 0.5 }, scene);
      b.position.set(tmp.x + tmp.uxp * 0.1, tmp.y + tmp.uyp * 0.1, tmp.z + tmp.uzp * 0.1);
      orientFwd(b, tmp.tx, tmp.ty, tmp.tz, tmp.uxp, tmp.uyp, tmp.uzp);
      sleepers.push(b);
    }
    let sleeperMesh = null;
    if (sleepers.length) { sleeperMesh = BABYLON.Mesh.MergeMeshes(sleepers, true) || sleepers[0]; sleeperMesh.material = matSleeper; sleeperMesh.isPickable = false; sleeperMesh.freezeWorldMatrix(); }
    chunks.set(ci, { meshes: [skirt, ballast, rail, sleeperMesh].filter(Boolean), scenery: buildScenery(ci, c0, c1), coins: buildCoins(c0, c1), pads: buildPads(c0, c1) });
  }
  function buildScenery(ci, c0, c1) {
    const out = [], rng = mulberry32(ci * 9176 + SEED);
    for (let i = c0; i <= c1; i += 2) {
      const def = Track.biomeAt(i * DS).def, kind = def.scenery;
      const ax = Track.px[i], ay = Track.py[i], az = Track.pz[i];
      if (kind === "tunnel" && i % 4 === 0) {
        const ring = protoRing.createInstance("rg" + ci + "_" + i);
        ring.position.set(ax, ay + 0.3, az);
        orientRing(ring, Track.tx[i], Track.ty[i], Track.tz[i]);
        ring.freezeWorldMatrix(); ring.isPickable = false; out.push(ring);
      }
      for (const side of [1, -1]) {
        if (rng() > 0.5) continue;
        const off = W + 1.6 + rng() * 13;
        const Rx = Track.rx[i] * side, Rz = Track.rz[i] * side;
        const proto = protoFor(kind, rng());
        const m = proto.createInstance("sc" + ci + "_" + i + "_" + side);
        m.position.set(ax + Rx * off, ay - 0.3, az + Rz * off);
        const sc = 0.8 + rng() * 0.9; m.scaling.set(sc, sc, sc);
        m.rotation.y = rng() * 6.28;
        m.freezeWorldMatrix(); m.isPickable = false; out.push(m);
      }
    }
    return out;
  }
  function disposeChunk(ci) {
    const c = chunks.get(ci); if (!c) return;
    for (const m of c.meshes) m.dispose();
    for (const s of c.scenery) s.dispose();
    if (c.coins) for (const cn of c.coins) { coinMeshes.delete(cn.id); cn.mesh.dispose(); }
    if (c.pads) for (const p of c.pads) { padMeshes.delete(p.id); p.mesh.dispose(); }
    chunks.delete(ci);
  }
  function streamChunks(limit) {
    const cn = Math.floor((s / DS) / CHUNK_NODES);
    const lo = Math.max(0, cn - 2), hi = Math.min(NUM_CHUNKS - 1, cn + 13);
    let built = 0;
    for (let ci = lo; ci <= hi; ci++) if (!chunks.has(ci)) { buildChunk(ci); if (++built >= limit) break; }
    for (const ci of [...chunks.keys()]) if (ci < lo - 1 || ci > hi + 1) disposeChunk(ci);
  }

  // (ground is now per-chunk terrain skirt that follows the rail's elevation)

  // ---------------------------------------------------------------- carts
  // body colours (shared)
  const matStd = mat("std", 0.85, 0.2, 0.25); matStd.emissiveColor = new C3(0.16, 0.04, 0.05);
  const matSpeed = mat("spd", 0.15, 0.7, 0.95); matSpeed.emissiveColor = new C3(0.03, 0.12, 0.16); matSpeed.specularColor = new C3(0.5, 0.5, 0.55);
  const matDeck = mat("dck", 0.13, 0.55, 0.42); matDeck.emissiveColor = new C3(0.02, 0.1, 0.08);
  const matRocket = mat("rkt", 0.93, 0.94, 0.96);
  const matRocketFin = mat("rktf", 0.9, 0.18, 0.2); matRocketFin.emissiveColor = new C3(0.18, 0.03, 0.03);
  const matGold = mat("gld", 0.92, 0.74, 0.16); matGold.emissiveColor = new C3(0.34, 0.25, 0.04); matGold.specularColor = new C3(0.8, 0.7, 0.3);
  const matBanana = mat("bnna", 0.96, 0.82, 0.13); matBanana.emissiveColor = new C3(0.22, 0.17, 0.0);
  const matBananaTip = mat("bntip", 0.34, 0.22, 0.10);
  const matToilet = mat("tlt", 0.95, 0.96, 0.98); matToilet.specularColor = new C3(0.45, 0.45, 0.5);
  const matToiletSeat = mat("tseat", 0.82, 0.84, 0.87);
  const matWater = mat("twtr", 0.25, 0.55, 0.92); matWater.emissiveColor = new C3(0.04, 0.12, 0.22);

  const vbox = (root, w, h, d, x, y, z, m, rx) => { const b = BABYLON.MeshBuilder.CreateBox("p", { width: w, height: h, depth: d }, scene); b.position.set(x, y, z); if (rx) b.rotation.x = rx; b.material = m; b.parent = root; b.isPickable = false; return b; };
  const vsph = (root, dia, x, y, z, m) => { const b = BABYLON.MeshBuilder.CreateSphere("p", { diameter: dia, segments: 8 }, scene); b.position.set(x, y, z); b.material = m; b.parent = root; b.isPickable = false; return b; };
  const vwheel = (root, dia, x, y, z, m) => { const w = BABYLON.MeshBuilder.CreateCylinder("p", { diameter: dia, height: 0.2, tessellation: 10 }, scene); w.rotation.z = Math.PI / 2; w.position.set(x, y, z); w.material = m; w.parent = root; w.isPickable = false; return w; };
  const vcone = (root, dt, db, h, x, y, z, m, rx) => { const c = BABYLON.MeshBuilder.CreateCylinder("p", { diameterTop: dt, diameterBottom: db, height: h, tessellation: 12 }, scene); c.position.set(x, y, z); if (rx) c.rotation.x = rx; c.material = m; c.parent = root; c.isPickable = false; return c; };
  function addWheels(root, len) {
    vbox(root, 1.66, 0.1, 0.1, 0, 0.32, len, matChassis); vbox(root, 1.66, 0.1, 0.1, 0, 0.32, -len, matChassis);
    for (const [dx, dz] of [[0.78, len], [-0.78, len], [0.78, -len], [-0.78, -len]]) { vwheel(root, 0.56, dx, 0.32, dz, matWheel); vwheel(root, 0.24, dx, 0.32, dz, matRim); }
  }
  function buildStandard(root, opts) {
    opts = opts || {}; const bm = opts.mat || matStd;
    vbox(root, 1.5, 0.26, 2.5, 0, 0.42, 0, matChassis);
    vbox(root, 0.12, 0.2, 2.5, 0.74, 0.5, 0, matChassis); vbox(root, 0.12, 0.2, 2.5, -0.74, 0.5, 0, matChassis);
    vbox(root, 1.42, 0.85, 2.0, 0, 0.98, -0.12, bm);
    vbox(root, 1.42, 0.85, 0.72, 0, 1.0, 1.05, bm, -0.6);
    vbox(root, 1.12, 0.7, 1.62, 0, 1.16, -0.12, matCartIn);
    vbox(root, 1.54, 0.12, 2.14, 0, 1.43, -0.12, matRim);
    vsph(root, 0.3, 0, 1.0, 1.42, matLight);
    if (opts.rider !== false) { vbox(root, 0.55, 0.62, 0.5, 0, 1.52, -0.38, bm); vsph(root, 0.42, 0, 1.95, -0.38, matSkin); }
    addWheels(root, 0.82);
  }
  function buildSpeedster(root) {
    vbox(root, 1.4, 0.2, 2.9, 0, 0.4, 0, matChassis);
    const hull = vcone(root, 1.18, 1.18, 2.6, 0, 0.74, -0.05, matSpeed, Math.PI / 2); hull.scaling.x = 1.14; // rounded tub
    vcone(root, 0, 1.18, 1.35, 0, 0.74, 1.8, matSpeed, -Math.PI / 2);  // pointed nose cone
    vbox(root, 0.78, 0.36, 0.86, 0, 1.16, -0.45, matCartIn); vsph(root, 0.4, 0, 1.42, -0.45, matSkin); // cockpit + driver
    vcone(root, 0, 0.46, 0.42, 0, 1.32, -0.95, matSpeed);            // streamlined headrest fin behind the driver
    vbox(root, 1.5, 0.08, 0.32, 0, 1.12, -1.35, matChassis); vbox(root, 0.12, 0.42, 0.3, 0.55, 0.92, -1.35, matChassis); vbox(root, 0.12, 0.42, 0.3, -0.55, 0.92, -1.35, matChassis); // rear wing
    addWheels(root, 0.98);
  }
  function buildDecker(root) {
    vbox(root, 1.62, 0.26, 2.6, 0, 0.42, 0, matChassis);
    vbox(root, 1.5, 1.78, 2.46, 0, 1.42, 0, matDeck);          // one tall continuous body (both decks)
    vbox(root, 1.54, 0.34, 2.5, 0, 1.12, 0, matCartIn);        // lower window band
    vbox(root, 1.54, 0.34, 2.5, 0, 1.86, 0, matCartIn);        // upper window band
    const roof = vcone(root, 1.5, 1.5, 2.46, 0, 2.3, 0, matDeck, Math.PI / 2); roof.scaling.y = 0.46; // rounded roof
    const nose = vcone(root, 1.5, 1.5, 1.5, 0, 1.34, 0.62, matDeck); nose.rotation.z = Math.PI / 2; nose.scaling.z = 0.7; // gently rounded front
    vbox(root, 1.42, 1.5, 0.16, 0, 1.45, 1.24, matCartIn);     // windscreen / front windows
    vbox(root, 1.66, 0.1, 2.0, 0, 1.5, 0, matRim);             // mid trim line between decks
    vsph(root, 0.26, 0, 0.84, 1.46, matLight);
    addWheels(root, 0.92);
  }
  function buildRocket(root) {
    vbox(root, 1.2, 0.24, 2.4, 0, 0.42, 0, matChassis);
    vcone(root, 1.18, 1.18, 2.2, 0, 1.02, 0, matRocket, Math.PI / 2);  // cylindrical fuselage
    vcone(root, 0, 1.22, 1.25, 0, 1.02, 1.6, matRocketFin, -Math.PI / 2); // nose cone
    vbox(root, 0.1, 0.7, 0.7, 0.74, 0.8, -0.95, matRocketFin); vbox(root, 0.1, 0.7, 0.7, -0.74, 0.8, -0.95, matRocketFin); vbox(root, 0.7, 0.7, 0.1, 0, 1.55, -0.95, matRocketFin); // fins
    vsph(root, 0.5, 0, 1.4, 0.4, matCartIn);                   // cockpit bubble
    vcone(root, 0, 0.95, 1.0, 0, 1.02, -1.7, matLight, Math.PI / 2); // exhaust flame
    addWheels(root, 0.85);
  }
  function buildGold(root) {
    vbox(root, 1.62, 0.28, 2.7, 0, 0.42, 0, matChassis);
    vbox(root, 1.5, 0.85, 2.4, 0, 0.92, 0, matGold);           // body
    vbox(root, 1.42, 0.8, 0.62, 0, 0.98, 1.18, matGold, -0.6); // angled front (like the standard cart)
    vbox(root, 1.66, 0.12, 2.5, 0, 1.3, 0, matRim);            // trim band
    const roof = vcone(root, 1.42, 1.42, 1.55, 0, 1.58, 0.45, matGold, Math.PI / 2); roof.scaling.y = 0.62; // domed cabin roof
    vbox(root, 1.2, 0.5, 1.3, 0, 1.5, 0.45, matCartIn);        // cabin windows under the dome
    vcone(root, 0, 0.42, 0.5, 0, 2.02, 0.45, matGold);         // crown finial
    vsph(root, 0.42, 0, 1.62, -0.66, matSkin);                 // royal rider peeking out the back
    vsph(root, 0.28, 0, 0.98, 1.46, matLight);
    addWheels(root, 0.92);
  }
  function buildBanana(root) {
    vbox(root, 1.3, 0.24, 2.6, 0, 0.42, 0, matChassis);
    const body = vsph(root, 1.2, 0, 0.95, 0, matBanana); body.scaling.set(1.0, 0.85, 2.3);     // long ellipsoid
    const front = vsph(root, 0.85, 0, 1.25, 1.45, matBanana); front.scaling.set(0.8, 0.8, 1.0); // raised front tip
    const back = vsph(root, 0.85, 0, 1.25, -1.45, matBanana); back.scaling.set(0.8, 0.8, 1.0);  // raised back tip
    vsph(root, 0.34, 0, 1.5, 1.85, matBananaTip);             // brown nose tip
    vbox(root, 0.22, 0.45, 0.22, 0, 1.7, -1.78, matBananaTip); // brown stem at the back
    vbox(root, 0.66, 0.4, 1.0, 0, 1.45, -0.15, matCartIn);    // seat hollow
    vsph(root, 0.4, 0, 1.85, -0.35, matSkin);                 // rider head
    vsph(root, 0.26, 0, 1.0, 1.5, matLight);                  // headlight
    addWheels(root, 0.85);
  }
  function buildToilet(root) {
    vbox(root, 1.4, 0.26, 2.4, 0, 0.42, 0, matChassis);
    vcone(root, 0.95, 1.25, 0.8, 0, 0.92, 0.1, matToilet);    // pedestal base
    vcone(root, 1.25, 0.95, 0.5, 0, 1.45, 0.12, matToilet);   // bowl (wider at the rim)
    const seat = BABYLON.MeshBuilder.CreateTorus("p", { diameter: 1.2, thickness: 0.2, tessellation: 16 }, scene);
    seat.position.set(0, 1.66, 0.12); seat.material = matToiletSeat; seat.parent = root; seat.isPickable = false;
    const water = vsph(root, 0.85, 0, 1.6, 0.12, matWater); water.scaling.set(1, 0.3, 1); // blue water
    vbox(root, 1.3, 1.05, 0.5, 0, 1.6, -0.95, matToilet);     // cistern / tank
    vbox(root, 1.4, 0.16, 0.64, 0, 2.16, -0.95, matToilet);   // tank lid
    vbox(root, 0.18, 0.12, 0.18, 0.55, 2.0, -0.66, matRim);   // chrome flush handle
    vsph(root, 0.42, 0, 2.15, 0.12, matSkin);                 // rider on the throne
    addWheels(root, 0.88);
  }

  const CARTS = [
    { id: "standard", name: "Standard Cart", emoji: "🛒", rarity: "Common", price: 0, moneyMult: 1.0, stability: 1.0, segs: 1, build: (r) => buildStandard(r) },
    { id: "speedster", name: "Speedster", emoji: "🏎️", rarity: "Rare", price: 1500, moneyMult: 1.3, stability: 1.25, segs: 1, build: (r) => buildSpeedster(r) },
    { id: "banana", name: "Banana Split", emoji: "🍌", rarity: "Rare", price: 2000, moneyMult: 1.4, stability: 0.78, segs: 1, build: (r) => buildBanana(r) },
    { id: "decker", name: "Double-Decker", emoji: "🚌", rarity: "Rare", price: 4000, moneyMult: 1.6, stability: 0.72, segs: 1, build: (r) => buildDecker(r) },
    { id: "toilet", name: "Royal Flush", emoji: "🚽", rarity: "Epic", price: 6000, moneyMult: 1.9, stability: 1.08, segs: 1, build: (r) => buildToilet(r) },
    { id: "train", name: "The Caterpillar", emoji: "🚂", rarity: "Epic", price: 8000, moneyMult: 2.2, stability: 0.85, segs: 5, gap: 3.5, build: (r) => buildStandard(r) },
    { id: "rocket", name: "Rocket Cart", emoji: "🚀", rarity: "Epic", price: 15000, moneyMult: 2.5, stability: 0.68, segs: 1, build: (r) => buildRocket(r) },
    { id: "gold", name: "Gold Express", emoji: "👑", rarity: "Legendary", price: 30000, moneyMult: 3.4, stability: 0.95, segs: 1, build: (r) => buildGold(r) },
  ];
  const cartById = (id) => CARTS.find((c) => c.id === id) || CARTS[0];

  // multi-segment vehicle (most carts = 1 body; the train = 5 carriages + wires)
  let vehicle = null;
  function disposeVehicle() { if (!vehicle) return; vehicle.segs.forEach((r) => r.dispose(false, true)); vehicle.wires.forEach((w) => w.dispose()); vehicle = null; }
  function spawnVehicle(def) {
    disposeVehicle();
    const segs = [], wires = [];
    for (let i = 0; i < def.segs; i++) { const r = new BABYLON.TransformNode("seg" + i, scene); r.rotationQuaternion = new Q(); def.build(r, i); segs.push(r); }
    for (let i = 0; i < def.segs - 1; i++) { const w = BABYLON.MeshBuilder.CreateCylinder("wire", { diameter: 0.1, height: 1, tessellation: 6 }, scene); w.material = matChassis; w.isPickable = false; w.rotationQuaternion = new Q(); wires.push(w); }
    vehicle = { def, segs, wires, gap: def.gap || 3.2 };
    return segs[0];
  }
  function makeOtherCart(id) { const def = cartById(id); const r = new BABYLON.TransformNode("oc", scene); r.rotationQuaternion = new Q(); def.build(r, 0); return r; }

  // ---------------------------------------------------------------- economy
  const SAVE_KEY = "cartride_save_v2";   // v2: everyone starts fresh on the standard cart
  let coins = 0, coinPop = 0, owned = new Set(["standard"]), selectedId = "standard", curCart = CARTS[0];
  // localStorage is shared by every tab on this origin, so it is the single source of truth
  // for the wallet. Coins are applied as read-modify-write deltas and a "storage" listener
  // keeps all open tabs in sync — otherwise a second tab would clobber the save (and a buy
  // could land on a stale balance, snapping coins to 0). See addCoins / saveProgress / sync.
  function readStore() { try { return JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { return null; } }
  function loadSave() { const j = readStore(); if (j) { coins = j.coins || 0; owned = new Set(j.owned || ["standard"]); selectedId = j.selected || "standard"; } owned.add("standard"); if (!owned.has(selectedId)) selectedId = "standard"; curCart = cartById(selectedId); }
  function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify({ coins, owned: [...owned], selected: selectedId })); } catch (e) {} }
  function saveProgress() {               // persist ownership/selection WITHOUT overwriting the shared coin total
    const j = readStore() || {}; j.owned = [...new Set([...(j.owned || []), ...owned])]; j.selected = selectedId; if (j.coins == null) j.coins = coins;
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(j)); } catch (e) {}
  }
  function addCoins(n) {                   // earn n coins against the shared wallet (sums across tabs, never clobbers)
    const j = readStore(); coins = (j ? (j.coins || 0) : coins) + n; save();
  }
  function syncFromStore() {               // another tab changed the wallet — adopt its coins + ownership
    const j = readStore(); if (!j) return;
    coins = j.coins || 0; owned = new Set([...(j.owned || []), ...owned]); owned.add("standard");
    if (state === "ready") renderShop(); else updateHUD();
  }
  addEventListener("storage", (e) => { if (e.key === SAVE_KEY) syncFromStore(); });

  // ---------------------------------------------------------------- coins on the track
  const COIN_STEP = 40, COIN_VALUE = 1;        // one coin every 40 m, worth 1 × the cart's bonus
  const collectedCoins = new Set();            // coin ids already grabbed this run
  const coinMeshes = new Map();                // id -> mesh currently in the world
  const matCoin = mat("coin", 1.0, 0.83, 0.2); matCoin.emissiveColor = new C3(0.6, 0.46, 0.06); matCoin.specularColor = new C3(0.6, 0.5, 0.2);
  const protoCoin = (() => { const c = BABYLON.MeshBuilder.CreateCylinder("coinP", { diameter: 0.85, height: 0.1, tessellation: 18 }, scene); c.rotation.x = Math.PI / 2; c.bakeCurrentTransformIntoVertices(); c.material = matCoin; c.isPickable = false; c.setEnabled(false); return c; })();
  function buildCoins(c0, c1) {                 // coins whose position lands inside this chunk
    const out = [];
    const idLo = Math.max(1, Math.ceil((c0 * DS) / COIN_STEP)), idHi = Math.floor((c1 * DS) / COIN_STEP);
    for (let id = idLo; id <= idHi; id++) {
      if (collectedCoins.has(id)) continue;
      Track.sample(id * COIN_STEP, tmp);
      const m = protoCoin.createInstance("c" + id);
      m.position.set(tmp.x + tmp.uxp * 0.95, tmp.y + tmp.uyp * 0.95, tmp.z + tmp.uzp * 0.95);
      m.rotation.y = (id * 1.7) % 6.28; m.isPickable = false;
      coinMeshes.set(id, m); out.push({ id, mesh: m });
    }
    return out;
  }
  function collectCoins(sa, sb) {               // grab every coin between last frame and now
    if (sb <= sa) return;
    const from = Math.floor(sa / COIN_STEP) + 1, to = Math.floor(sb / COIN_STEP);
    let earned = 0;
    for (let id = from; id <= to; id++) {
      if (id < 1 || collectedCoins.has(id)) continue;
      collectedCoins.add(id); earned += COIN_VALUE * curCart.moneyMult; coinPop = 1;
      const m = coinMeshes.get(id); if (m) m.setEnabled(false);
    }
    if (earned > 0) addCoins(earned);                          // persist to the shared wallet immediately
  }
  function spinCoins(dt) { for (const m of coinMeshes.values()) if (m.isEnabled()) m.rotation.y += dt * 5; }
  function resetCoins() { collectedCoins.clear(); for (const m of coinMeshes.values()) m.setEnabled(true); }

  // ---------------------------------------------------------------- boost & jump pads
  // Placed deterministically from the world seed (so every client agrees on where
  // they are), then triggered when the cart rides across one. Boost = speed surge;
  // jump = launch into a short airborne hop (immune to derail while flying).
  const PADS = (() => {
    const out = [], rng = mulberry32(SEED ^ 0x9e3779b9);
    let sp = 260;
    while (sp < Track.LENGTH - 220) {
      out.push({ s: sp, type: rng() < 0.5 ? "boost" : "jump", idx: out.length });
      sp += 300 + rng() * 340;                 // ~300–640 m apart
    }
    return out;
  })();
  const matPadBase = mat("padbase", 0.05, 0.05, 0.07); matPadBase.specularColor = new C3(0, 0, 0);
  const matBoost = mat("boostpad", 0.08, 0.5, 0.62, [0.12, 0.85, 1.0]); matBoost.specularColor = new C3(0, 0, 0);
  const matJump = mat("jumppad", 0.6, 0.34, 0.05, [1.0, 0.55, 0.12]); matJump.specularColor = new C3(0, 0, 0);
  const PAD_W = GAUGE * 2 + 1.1;
  function makeBoostPad() {
    const base = BABYLON.MeshBuilder.CreateBox("bpb", { width: PAD_W, height: 0.08, depth: 3.4 }, scene); base.position.y = 0.04; base.material = matPadBase;
    const parts = [base];
    for (let i = 0; i < 3; i++) for (const sgn of [1, -1]) {       // three forward-pointing chevrons
      const ch = BABYLON.MeshBuilder.CreateBox("bpc", { width: 0.3, height: 0.16, depth: 1.5 }, scene);
      ch.position.set(sgn * 0.62, 0.12, -0.95 + i * 0.95); ch.rotation.y = sgn * 0.62; ch.material = matBoost;
      parts.push(ch);
    }
    return merge(parts);
  }
  function makeJumpPad() {
    const base = BABYLON.MeshBuilder.CreateBox("jpb", { width: PAD_W, height: 0.06, depth: 3.2 }, scene); base.position.y = 0.03; base.material = matPadBase;
    const ramp = BABYLON.MeshBuilder.CreateBox("jpr", { width: PAD_W, height: 0.14, depth: 3.2 }, scene);
    ramp.rotation.x = -0.30; ramp.position.y = 0.42; ramp.material = matJump; ramp.bakeCurrentTransformIntoVertices();
    const lip = BABYLON.MeshBuilder.CreateBox("jpl", { width: PAD_W, height: 0.3, depth: 0.22 }, scene);
    lip.position.set(0, 0.8, 1.5); lip.material = matJump;
    return merge([base, ramp, lip]);
  }
  const protoBoostPad = makeBoostPad(), protoJumpPad = makeJumpPad();
  const padMeshes = new Map();                  // idx -> instance currently in the world
  function buildPads(c0, c1) {                  // pad instances whose position lands in this chunk
    const out = [], sLo = c0 * DS, sHi = c1 * DS;
    for (const p of PADS) {
      if (p.s < sLo || p.s > sHi) continue;
      Track.sample(p.s, tmp);
      const m = (p.type === "boost" ? protoBoostPad : protoJumpPad).createInstance("pad" + p.idx);
      m.position.set(tmp.x + tmp.uxp * 0.16, tmp.y + tmp.uyp * 0.16, tmp.z + tmp.uzp * 0.16);
      orientFwd(m, tmp.tx, tmp.ty, tmp.tz, tmp.uxp, tmp.uyp, tmp.uzp);
      m.freezeWorldMatrix(); m.isPickable = false;
      padMeshes.set(p.idx, m); out.push({ id: p.idx, mesh: m });
    }
    return out;
  }
  let padPulse = 0;
  function pulsePads(dt) {                      // gentle emissive throb so pads read as "live"
    padPulse += dt * 4;
    const g = 0.6 + 0.4 * Math.sin(padPulse);
    matBoost.emissiveColor.set(0.12 * g, 0.85 * g, 1.0 * g);
    matJump.emissiveColor.set(1.0 * g, 0.55 * g, 0.12 * g);
  }
  function crossPads(sa, sb) {                  // fire any pad the cart rode over this frame
    if (sb <= sa) return;
    for (const p of PADS) if (p.s > sa && p.s <= sb) { p.type === "boost" ? triggerBoost() : triggerJump(); }
  }
  function triggerBoost() {
    v = Math.min(V_MAX_BOOST, Math.max(v, 0) + BOOST_ADD);
    boostT = BOOST_TIME;
  }
  function triggerJump() {
    if (airborne) return;
    airborne = true; airH = 0.02;
    airV = JUMP_V0 + Math.min(6.5, Math.abs(v) * 0.13);   // faster in → bigger air
  }

  function makeLabel(name, hex) {
    const dt = new BABYLON.DynamicTexture("lt", { width: 256, height: 64 }, scene, false);
    dt.hasAlpha = true;
    dt.drawText(name, null, 46, "bold 36px Trebuchet MS", "#ffffff", "transparent", true);
    const pl = BABYLON.MeshBuilder.CreatePlane("lp", { width: 4, height: 1 }, scene);
    const m = new BABYLON.StandardMaterial("lm", scene); m.diffuseTexture = dt; m.emissiveColor = new C3(1, 1, 1); m.opacityTexture = dt; m.specularColor = new C3(0, 0, 0); m.backFaceCulling = false;
    pl.material = m; pl.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL; pl.isPickable = false;
    return pl;
  }

  let myName = "Rider";
  let cart = null;               // lead carriage (camera + derail follow this)
  const others = new Map(); // id -> { node, label, name, k }
  const tmp = {};

  // ---------------------------------------------------------------- state
  let state = "ready";           // ready | riding | derail | finished
  let s = 0, v = 0;
  let frame = Track.sample(0, {});
  let startTime = 0, elapsed = 0, finishTime = 0;
  let derailT = 0; const dvel = new V();
  let warnRatio = 0;
  let boostT = 0, overLimitT = 0;          // active-boost timer + how long we've been over lateral grip
  let airborne = false, airH = 0, airV = 0; // jump-pad hop: height above the rail + vertical velocity
  let camMode = "third";
  let netT = 0, hudT = 0, saveT = 0, frameCount = 0;

  const _segFrames = [];
  function positionSeg(seg, fr) {
    seg.position.set(fr.x + fr.uxp * 0.34, fr.y + fr.uyp * 0.34, fr.z + fr.uzp * 0.34);
    orientFwd(seg, fr.tx, fr.ty, fr.tz, fr.uxp, fr.uyp, fr.uzp);
  }
  function orientY(mesh, vx, vy, vz) {        // map mesh local +Y onto vector
    _f.set(vx, vy, vz); _f.normalize();
    _r.set(0, 0, 1); V.CrossToRef(_f, _r, _r); if (_r.lengthSquared() < 1e-4) _r.set(1, 0, 0); _r.normalize();
    V.CrossToRef(_r, _f, _u); _u.normalize();
    Q.RotationQuaternionFromAxisToRef(_r, _f, _u, mesh.rotationQuaternion);
  }
  function linkWire(w, pa, pb) {               // short coupling rod between two carriages
    const dx = pa.x - pb.x, dy = pa.y - pb.y, dz = pa.z - pb.z, l = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / l, uy = dy / l, uz = dz / l;
    const ax = pa.x - ux * 1.25, ay = pa.y - uy * 1.25 + 0.25, az = pa.z - uz * 1.25;
    const bx = pb.x + ux * 1.25, by = pb.y + uy * 1.25 + 0.25, bz = pb.z + uz * 1.25;
    const sx = ax - bx, sy = ay - by, sz = az - bz, sl = Math.hypot(sx, sy, sz) || 0.01;
    w.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2); w.scaling.set(1, sl, 1); orientY(w, sx, sy, sz);
  }
  function placeCart() {       // positions the whole vehicle (1 or many carriages)
    if (!vehicle) return;
    const hop = airH > 0.001;
    positionSeg(vehicle.segs[0], frame);
    if (hop) {                 // launched off a jump pad: lift + pitch the nose along the arc
      vehicle.segs[0].position.y += airH;
      const tilt = Math.max(-0.45, Math.min(0.45, airV * 0.045));
      orientFwd(vehicle.segs[0], frame.tx, frame.ty + tilt, frame.tz, frame.uxp, frame.uyp, frame.uzp);
    }
    vehicle.segs[0].setEnabled(true);
    for (let i = 1; i < vehicle.segs.length; i++) {
      let f = _segFrames[i]; if (!f) { f = {}; _segFrames[i] = f; }
      Track.sample(Math.max(0, s - i * vehicle.gap), f);
      positionSeg(vehicle.segs[i], f); if (hop) vehicle.segs[i].position.y += airH; vehicle.segs[i].setEnabled(true);
    }
    for (let i = 0; i < vehicle.wires.length; i++) { vehicle.wires[i].setEnabled(true); linkWire(vehicle.wires[i], vehicle.segs[i].position, vehicle.segs[i + 1].position); }
  }

  function derail() {
    state = "derail"; derailT = 1.4;
    for (let i = 1; i < vehicle.segs.length; i++) vehicle.segs[i].setEnabled(false);
    vehicle.wires.forEach((w) => w.setEnabled(false));
    // fling outward: sign of the turn from tangent rotation
    Track.sample(s + 6, tmp);
    const cross = frame.tx * tmp.tz - frame.tz * tmp.tx;     // y-component of t x tAhead
    const side = cross > 0 ? -1 : 1;
    dvel.set(frame.rx * side * 10 + frame.tx * v * 0.3, 7.5, frame.rz * side * 10 + frame.tz * v * 0.3);
    v = 0;
    toast("WHOA — you flew off!", "Tight bends: ease off ▼");
    Net.sendState(s, 0, 1, 0, selectedId);
  }
  function respawn() { s = 0; v = 0; airborne = false; airH = 0; boostT = 0; overLimitT = 0; resetCoins(); Track.sample(0, frame); state = "riding"; placeCart(); snapCamera(); }
  function finish() {
    state = "finished"; v = 0; finishTime = elapsed;
    addCoins(10000);
    toast("Ride complete! 🎉 +10,000 coins!", "Time " + fmtTime(elapsed) + " · press R to ride again");
  }
  function restart() { s = 0; v = 0; airborne = false; airH = 0; boostT = 0; overLimitT = 0; resetCoins(); Track.sample(0, frame); state = "riding"; startTime = performance.now(); placeCart(); snapCamera(); }

  // ---------------------------------------------------------------- input
  const keys = {};
  let touchFwd = false, touchBack = false;
  addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    keys[k] = true;
    if (k === "c") camMode = camMode === "third" ? "first" : "third";
    if (k === "r" && state !== "ready") restart();
  });
  addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
  const bind = (el, set) => { const on = (e) => { e.preventDefault(); set(true); }; const off = (e) => { e.preventDefault(); set(false); }; el.addEventListener("touchstart", on); el.addEventListener("touchend", off); el.addEventListener("mousedown", on); el.addEventListener("mouseup", off); el.addEventListener("mouseleave", off); };
  bind(document.getElementById("tForward"), (b) => touchFwd = b);
  bind(document.getElementById("tBack"), (b) => touchBack = b);
  function throttle() {
    const fwd = keys["arrowup"] || keys["w"] || touchFwd;
    const back = keys["arrowdown"] || keys["s"] || touchBack;
    return fwd ? 1 : back ? -1 : 0;
  }

  // ---------------------------------------------------------------- biome blend
  function lerpC(out, a, b, t) { out.r = a[0] + (b[0] - a[0]) * t; out.g = a[1] + (b[1] - a[1]) * t; out.b = a[2] + (b[2] - a[2]) * t; return out; }
  const _sky = {}, _hor = {};
  function updateBiome(dt) {
    const bi = Track.biomeAt(s), d = bi.def, nx = bi.next, t = bi.blend;
    const fg = lerpC({}, d.fog, nx.fog, t); scene.fogColor.set(fg.r, fg.g, fg.b);
    scene.fogDensity += ((d.fogD + (nx.fogD - d.fogD) * t) - scene.fogDensity) * Math.min(1, dt * 2);
    // gradient sky blended toward the next biome; horizon matches fog so geometry melts in
    lerpC(_sky, d.sky, nx.sky, t); lerpC(_hor, d.fog, nx.fog, t);
    paintSky([_sky.r, _sky.g, _sky.b], [_hor.r, _hor.g, _hor.b]);
    hemi.intensity += (((d.scenery === "tunnel") ? 0.4 : 0.95) - hemi.intensity) * Math.min(1, dt * 2);
  }

  // ---------------------------------------------------------------- camera
  function camDist() { const L = vehicle ? (vehicle.segs.length - 1) * vehicle.gap : 0; return { back: 9 + L, up: 4 + L * 0.22 }; }
  function snapCamera() {
    const cp = cart.position, cb = camDist();
    camera.position.set(cp.x - frame.tx * cb.back + frame.uxp * cb.up, cp.y - frame.ty * cb.back + frame.uyp * cb.up, cp.z - frame.tz * cb.back + frame.uzp * cb.up);
    camTarget.set(cp.x + frame.tx * 10, cp.y + frame.ty * 10 + 1.2, cp.z + frame.tz * 10);
    camera.setTarget(camTarget);
  }
  function updateCamera(dt) {
    const cp = cart.position;
    const k = 1 - Math.exp(-dt * 7);
    let dx, dy, dz, tgx, tgy, tgz;
    if (camMode === "third") {
      const cb = camDist();
      dx = cp.x - frame.tx * cb.back + frame.uxp * cb.up; dy = cp.y - frame.ty * cb.back + frame.uyp * cb.up; dz = cp.z - frame.tz * cb.back + frame.uzp * cb.up;
      tgx = cp.x + frame.tx * 10; tgy = cp.y + frame.ty * 10 + 1.2; tgz = cp.z + frame.tz * 10;
    } else {
      dx = cp.x + frame.uxp * 1.5 + frame.tx * 0.3; dy = cp.y + frame.uyp * 1.5 + frame.ty * 0.3; dz = cp.z + frame.uzp * 1.5 + frame.tz * 0.3;
      tgx = cp.x + frame.tx * 14; tgy = cp.y + frame.ty * 14 + 0.6; tgz = cp.z + frame.tz * 14;
    }
    camera.position.x += (dx - camera.position.x) * k; camera.position.y += (dy - camera.position.y) * k; camera.position.z += (dz - camera.position.z) * k;
    camTarget.x += (tgx - camTarget.x) * k; camTarget.y += (tgy - camTarget.y) * k; camTarget.z += (tgz - camTarget.z) * k;
    camera.setTarget(camTarget);
    const targetFov = 1.05 + (boostT > 0 ? 0.16 : 0);          // widen the lens during a boost for the "whoosh"
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
  }

  // ---------------------------------------------------------------- others
  function updateOthers(dt) {
    for (const [id, o] of Net.others) {
      let e = others.get(id);
      if (!e || e.k !== o.k) {
        if (e) { e.node.dispose(false, true); e.label.dispose(); }
        const node = makeOtherCart(o.k || "standard");
        e = { node, label: makeLabel(o.name || "Rider", o.color), dispS: o.s, k: o.k };
        e.label.parent = node; e.label.position.y = 2.4; others.set(id, e);
      }
      e.dispS += (o.s - e.dispS) * (1 - Math.exp(-dt * 9));
      Track.sample(e.dispS, tmp);
      e.node.position.set(tmp.x + tmp.uxp * 0.34, tmp.y + tmp.uyp * 0.34, tmp.z + tmp.uzp * 0.34);
      orientFwd(e.node, tmp.tx, tmp.ty, tmp.tz, tmp.uxp, tmp.uyp, tmp.uzp);
    }
    for (const id of [...others.keys()]) if (!Net.others.has(id)) { const e = others.get(id); e.node.dispose(false, true); e.label.dispose(); others.delete(id); }
  }

  // ---------------------------------------------------------------- HUD
  const $ = (id) => document.getElementById(id);
  function fmtTime(t) { const m = Math.floor(t / 60), sec = Math.floor(t % 60); return m + ":" + String(sec).padStart(2, "0"); }
  function updateHUD() {
    $("kmh").textContent = Math.round(Math.abs(v) * 3.6);
    const hm = $("hudmoney"); hm.textContent = "🪙 " + Math.floor(coins);
    if (coinPop > 0) { hm.style.transform = "scale(" + (1 + 0.3 * coinPop) + ")"; coinPop = Math.max(0, coinPop - 0.2); } else hm.style.transform = "";
    $("biome").textContent = Track.biomeAt(s).name;
    $("dist").textContent = (s / 1000).toFixed(2);
    $("time").textContent = fmtTime(state === "finished" ? finishTime : elapsed);
    const pct = Math.min(100, (s / Track.LENGTH) * 100);
    $("pct").textContent = Math.floor(pct); $("prog").style.width = pct + "%";
    if (Net.connected) { $("netdot").className = "dot on"; $("ridercount").textContent = Net.count + (Net.count === 1 ? " rider" : " riders") + " online"; }
    else { $("netdot").className = "dot off"; $("ridercount").textContent = "Solo ride"; }
    const warn = $("warn");
    if (warnRatio > 0.7 && state === "riding") { warn.style.opacity = Math.min(1, (warnRatio - 0.7) / 0.3); warn.style.boxShadow = "inset 0 0 150px 40px rgba(255,50,50," + (0.25 + 0.35 * Math.min(1, warnRatio)) + ")"; }
    else warn.style.opacity = 0;
  }
  let toastTimer = 0;
  function toast(h1, p) { $("toastH1").textContent = h1; $("toastP").textContent = p || ""; const t = $("toast"); t.classList.remove("show"); void t.offsetWidth; t.classList.add("show"); toastTimer = 2.6; }

  // ---------------------------------------------------------------- main update
  function update(dt) {
    frameCount++;
    if (state === "riding") {
      if (airborne) {                                            // flying off a jump pad — air drag + the hop only
        v -= (0.5 * Math.sign(v) + 0.0026 * v * Math.abs(v)) * dt;
        airV -= G_AIR * dt; airH += airV * dt;
        if (airH <= 0) { airH = 0; airborne = false; }
      } else {
        const thr = throttle();
        if (thr > 0) v += A_ENG * dt;
        else if (thr < 0) { if (v > 0.3) v -= A_BRAKE * dt; else v -= A_REV * dt; }
        v -= G * frame.ty * dt;                                  // hill gravity (ty = sin slope)
        v -= (0.5 * Math.sign(v) + 0.0026 * v * Math.abs(v)) * dt; // resistance + drag (terminal ~72 m/s)
      }
      const cap = boostT > 0 ? V_MAX_BOOST : V_MAX;
      if (v > cap) v = cap; if (v < V_REV_MAX) v = V_REV_MAX;
      if (boostT > 0) boostT -= dt;
      const sBefore = s;
      s += v * dt;
      if (s < 0) { s = 0; if (v < 0) v = 0; }
      collectCoins(sBefore, s);                                  // grab coins you ride over
      crossPads(sBefore, s);                                     // hit boost / jump pads
      Track.sample(s, frame);
      if (!airborne) {
        const aLat = v * v * frame.kappa;
        const latMax = A_LAT_MAX * curCart.stability;          // stabler carts corner faster
        warnRatio = aLat / latMax;
        // brief grace: a quick brake tap saves you; wild overspeed still flies off at once
        if (aLat > latMax && Math.abs(v) > 4) { overLimitT += dt; if (overLimitT > DERAIL_GRACE || aLat > latMax * 1.6) derail(); }
        else overLimitT = Math.max(0, overLimitT - dt * 2);
      } else { warnRatio = 0; overLimitT = 0; }
      if (state === "riding") { if (s >= Track.LENGTH - DS - 2) finish(); else placeCart(); }
      elapsed = (performance.now() - startTime) / 1000;
    } else if (state === "derail") {
      derailT -= dt; dvel.y -= 22 * dt;
      cart.position.addInPlace(dvel.scale(dt));
      cart.rotate(BABYLON.Axis.X, 7 * dt, BABYLON.Space.LOCAL);
      cart.rotate(BABYLON.Axis.Z, 4 * dt, BABYLON.Space.LOCAL);
      warnRatio = 0;
      if (derailT <= 0) respawn();
    }

    if (state !== "ready") {
      updateCamera(dt); updateBiome(dt); streamChunks(2); updateOthers(dt); spinCoins(dt); pulsePads(dt);
      netT += dt; if (netT > 0.08) { netT = 0; Net.sendState(s, v, state === "derail", state === "finished", selectedId); }
      hudT += dt; if (hudT > 0.1) { hudT = 0; updateHUD(); }
      saveT += dt; if (saveT > 4) { saveT = 0; saveProgress(); }
    }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $("toast").classList.remove("show"); }
  }

  scene.onBeforeRenderObservable.add(() => { update(Math.min(0.05, engine.getDeltaTime() / 1000)); });

  // ---------------------------------------------------------------- boot
  loadSave();
  cart = spawnVehicle(curCart);
  // pre-build the opening stretch so the first frame isn't empty
  for (let ci = 0; ci <= 13; ci++) buildChunk(ci);
  Track.sample(0, frame); placeCart();
  camera.position.set(frame.x - frame.tx * 12 + 5, frame.y + 6, frame.z - frame.tz * 12);
  camTarget.set(frame.x, frame.y + 1, frame.z);
  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());

  // ---------------------------------------------------------------- shop / garage
  const RARITY_ORDER = { Common: 0, Rare: 1, Epic: 2, Legendary: 3 };
  function stabLabel(s) { return s >= 1.15 ? "High grip 🎯🎯🎯" : s >= 0.95 ? "Stable 🎯🎯" : s >= 0.8 ? "Twitchy 🎯" : "Tippy ⚠"; }
  function renderShop() {
    $("wallet").textContent = "🪙 " + Math.floor(coins);
    const grid = $("shop"); grid.innerHTML = "";
    for (const c of CARTS) {
      const isOwned = owned.has(c.id), isSel = c.id === selectedId, afford = coins >= c.price;
      const card = document.createElement("div");
      card.className = "cartcard r-" + c.rarity.toLowerCase() + (isSel ? " sel" : "");
      let btn = isSel ? '<div class="cbtn on">✓ Equipped</div>'
        : isOwned ? '<div class="cbtn sel-btn">Equip</div>'
        : afford ? '<div class="cbtn buy">Unlock 🪙' + c.price + '</div>'
        : '<div class="cbtn lock">🔒 🪙' + c.price + '</div>';
      card.innerHTML = '<div class="cemoji">' + c.emoji + '</div><div class="cname">' + c.name + '</div>'
        + '<div class="crar r-' + c.rarity.toLowerCase() + '">' + c.rarity + (c.segs > 1 ? ' · ' + c.segs + '×' : '') + '</div>'
        + '<div class="cstats">🪙 ×' + c.moneyMult + ' coins<br>' + stabLabel(c.stability) + '</div>' + btn;
      card.onclick = () => onCartClick(c);
      grid.appendChild(card);
    }
  }
  function onCartClick(c) {
    const j = readStore(); if (j) { coins = j.coins || 0; owned = new Set([...(j.owned || []), ...owned]); owned.add("standard"); } // buy against the true shared balance, not a stale one
    if (owned.has(c.id)) { selectedId = c.id; }
    else if (coins >= c.price) { coins -= c.price; owned.add(c.id); selectedId = c.id; }
    else { const grid = $("shop"); grid.classList.remove("nope"); void grid.offsetWidth; grid.classList.add("nope"); return; }
    curCart = cartById(selectedId); save(); renderShop();
  }
  function openGarage() {
    if (state === "ready") return;
    state = "ready"; saveProgress();
    document.getElementById("hud").classList.remove("show");
    document.getElementById("start").classList.remove("hide");
    renderShop();
  }
  $("name").value = "Rider" + (100 + (Math.random() * 900 | 0));
  $("loading").textContent = "Line ready · " + (Track.LENGTH / 1000).toFixed(1) + " km · 🪙 grab coins as you ride, unlock carts here";

  function startRide() {
    myName = ($("name").value || "Rider").slice(0, 14);
    curCart = cartById(selectedId);
    cart = spawnVehicle(curCart);
    document.getElementById("start").classList.add("hide");
    document.getElementById("hud").classList.add("show");
    if (matchMedia("(pointer: coarse)").matches) { $("tForward").classList.add("show"); $("tBack").classList.add("show"); }
    state = "riding"; s = 0; v = 0; airborne = false; airH = 0; boostT = 0; overLimitT = 0; resetCoins(); startTime = performance.now(); Track.sample(0, frame); placeCart(); snapCamera();
    Net.connect({ name: myName, k: selectedId });
    Net.setCart && Net.setCart(selectedId);
    toast("Off you go!", curCart.name + " · reach the end for 10,000 coins! 🪙");
  }
  $("go").onclick = startRide;
  $("name").addEventListener("keydown", (e) => { if (e.key === "Enter") startRide(); });
  $("garage").onclick = openGarage;
  addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "g" && state !== "ready") openGarage(); });
  renderShop();

  window.CART = {
    get s() { return s; }, set s(x) { s = x; Track.sample(s, frame); if (state !== "ready") { placeCart(); snapCamera(); } },
    get v() { return v; }, set v(x) { v = x; }, get state() { return state; },
    start: startRide, garage: openGarage, tick: (steps, dt) => { dt = dt || 1 / 60; for (let i = 0; i < steps; i++) update(dt); },
    give: (n) => { addCoins(n); renderShop(); }, select: (id) => onCartClick(cartById(id)),
    boost: triggerBoost, jump: triggerJump, pads: () => PADS.length,
    info: () => ({ s, v, state, biome: Track.biomeAt(s).name, riders: Net.count, others: others.size, chunks: chunks.size, coins: Math.floor(coins), cart: selectedId, segs: vehicle ? vehicle.segs.length : 0, boosting: boostT > 0, airborne, owned: [...owned] }),
  };
})();
