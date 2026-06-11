/* =====================================================================
   MAIN — Babylon scene, cart physics, streamed track, multiplayer carts.
   ===================================================================== */
(() => {
  const V = BABYLON.Vector3, C3 = BABYLON.Color3, Q = BABYLON.Quaternion;
  const SEED = 73331;            // shared world seed — same line for everyone
  const DS = Track.DS, N = Track.N, W = Track.ROAD_W;
  const GAUGE = 0.7;                     // half-distance between the two rails
  const CHUNK_NODES = 12;
  const NUM_CHUNKS = Math.ceil(N / CHUNK_NODES);

  // physics
  const A_ENG = 14, A_BRAKE = 24, A_REV = 6;
  const V_MAX = 50, V_REV_MAX = -7;     // m/s  (50 = 180 km/h top speed)
  const G = 14;                          // strong gravity — steep hills really pull
  const A_LAT_MAX = 6.0;                 // low: take a bend too fast and you're gone

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
  const matGround = mat("grnd", 0.22, 0.46, 0.20); matGround.specularColor = new C3(0, 0, 0);
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
    const bl = [], br = [], railL = [], railR = [];
    for (let i = c0; i <= c1; i++) {
      const ax = Track.px[i], ay = Track.py[i], az = Track.pz[i];
      const Rx = Track.rx[i], Ry = Track.ry[i], Rz = Track.rz[i];
      const Ux = Track.ux[i], Uy = Track.uy[i], Uz = Track.uz[i];
      bl.push(new V(ax + Rx * W + Ux * 0.04, ay + Ry * W + Uy * 0.04, az + Rz * W + Uz * 0.04));
      br.push(new V(ax - Rx * W + Ux * 0.04, ay - Ry * W + Uy * 0.04, az - Rz * W + Uz * 0.04));
      railL.push(new V(ax + Rx * GAUGE + Ux * 0.24, ay + Ry * GAUGE + Uy * 0.24, az + Rz * GAUGE + Uz * 0.24));
      railR.push(new V(ax - Rx * GAUGE + Ux * 0.24, ay - Ry * GAUGE + Uy * 0.24, az - Rz * GAUGE + Uz * 0.24));
    }
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
    chunks.set(ci, { meshes: [ballast, rail, sleeperMesh].filter(Boolean), scenery: buildScenery(ci, c0, c1) });
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
    chunks.delete(ci);
  }
  function streamChunks(limit) {
    const cn = Math.floor((s / DS) / CHUNK_NODES);
    const lo = Math.max(0, cn - 2), hi = Math.min(NUM_CHUNKS - 1, cn + 13);
    let built = 0;
    for (let ci = lo; ci <= hi; ci++) if (!chunks.has(ci)) { buildChunk(ci); if (++built >= limit) break; }
    for (const ci of [...chunks.keys()]) if (ci < lo - 1 || ci > hi + 1) disposeChunk(ci);
  }

  // ---------------------------------------------------------------- ground
  const ground = BABYLON.MeshBuilder.CreateGround("g", { width: 1500, height: 1500, subdivisions: 1 }, scene);
  ground.material = matGround; ground.isPickable = false;

  // ---------------------------------------------------------------- carts
  let cartUID = 0;
  function makeCart(hex) {
    const safe = (hex && hex.length === 7) ? hex : "#ffcf33";
    const col = C3.FromHexString(safe);
    const bodyM = new BABYLON.StandardMaterial("cb" + (cartUID++), scene);
    bodyM.diffuseColor = col; bodyM.specularColor = new C3(0.35, 0.35, 0.38); bodyM.emissiveColor = col.scale(0.14);
    const root = new BABYLON.TransformNode("cart", scene);
    const box = (w, h, d, x, y, z, m, rx) => { const b = BABYLON.MeshBuilder.CreateBox("p", { width: w, height: h, depth: d }, scene); b.position.set(x, y, z); if (rx) b.rotation.x = rx; b.material = m; b.parent = root; b.isPickable = false; return b; };
    const sph = (dia, x, y, z, m) => { const b = BABYLON.MeshBuilder.CreateSphere("p", { diameter: dia, segments: 8 }, scene); b.position.set(x, y, z); b.material = m; b.parent = root; b.isPickable = false; return b; };
    const wheel = (dia, x, y, z, m) => { const w = BABYLON.MeshBuilder.CreateCylinder("p", { diameter: dia, height: 0.2, tessellation: 10 }, scene); w.rotation.z = Math.PI / 2; w.position.set(x, y, z); w.material = m; w.parent = root; w.isPickable = false; return w; };
    // chassis + side frame bars
    box(1.5, 0.26, 2.5, 0, 0.42, 0, matChassis);
    box(0.12, 0.2, 2.5, 0.74, 0.5, 0, matChassis);
    box(0.12, 0.2, 2.5, -0.74, 0.5, 0, matChassis);
    // colour tub + slanted prow + open dark interior + metal rim lip
    box(1.42, 0.85, 2.0, 0, 0.98, -0.12, bodyM);
    box(1.42, 0.85, 0.72, 0, 1.0, 1.05, bodyM, -0.6);
    box(1.12, 0.7, 1.62, 0, 1.16, -0.12, matCartIn);
    box(1.54, 0.12, 2.14, 0, 1.43, -0.12, matRim);
    // headlight up front
    sph(0.3, 0, 1.0, 1.42, matLight);
    // rider: torso (jacket matches cart) + head
    box(0.55, 0.62, 0.5, 0, 1.52, -0.38, bodyM);
    sph(0.42, 0, 1.95, -0.38, matSkin);
    // axles + wheels with shiny hubs
    box(1.66, 0.1, 0.1, 0, 0.32, 0.82, matChassis);
    box(1.66, 0.1, 0.1, 0, 0.32, -0.82, matChassis);
    for (const [dx, dz] of [[0.78, 0.82], [-0.78, 0.82], [0.78, -0.82], [-0.78, -0.82]]) {
      wheel(0.56, dx, 0.32, dz, matWheel);
      wheel(0.24, dx, 0.32, dz, matRim);
    }
    root.rotationQuaternion = new Q();
    return root;
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

  let myColor = "#ffcf33", myName = "Rider";
  const cart = makeCart(myColor);
  const others = new Map(); // id -> { node, label, name, color }
  const tmp = {};

  // ---------------------------------------------------------------- state
  let state = "ready";           // ready | riding | derail | finished
  let s = 0, v = 0;
  let frame = Track.sample(0, {});
  let startTime = 0, elapsed = 0, finishTime = 0;
  let derailT = 0; const dvel = new V();
  let warnRatio = 0;
  let camMode = "third";
  let netT = 0, hudT = 0, frameCount = 0;

  function placeCart() {
    cart.position.set(frame.x + frame.uxp * 0.34, frame.y + frame.uyp * 0.34, frame.z + frame.uzp * 0.34);
    orientFwd(cart, frame.tx, frame.ty, frame.tz, frame.uxp, frame.uyp, frame.uzp);
  }

  function derail() {
    state = "derail"; derailT = 1.4;
    // fling outward: sign of the turn from tangent rotation
    Track.sample(s + 6, tmp);
    const cross = frame.tx * tmp.tz - frame.tz * tmp.tx;     // y-component of t x tAhead
    const side = cross > 0 ? -1 : 1;
    dvel.set(frame.rx * side * 10 + frame.tx * v * 0.3, 7.5, frame.rz * side * 10 + frame.tz * v * 0.3);
    v = 0;
    toast("WHOA — you flew off!", "Tight bends: ease off ▼");
    Net.sendState(s, 0, 1, 0);
  }
  function respawn() { s = 0; v = 0; Track.sample(0, frame); state = "riding"; placeCart(); snapCamera(); }
  function finish() {
    state = "finished"; v = 0; finishTime = elapsed;
    toast("Ride complete! 🎉", "Time " + fmtTime(elapsed) + " · press R to ride again");
  }
  function restart() { s = 0; v = 0; Track.sample(0, frame); state = "riding"; startTime = performance.now(); placeCart(); snapCamera(); }

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
  function updateBiome(dt) {
    const bi = Track.biomeAt(s), d = bi.def, nx = bi.next, t = bi.blend;
    lerpC(matGround.diffuseColor, d.ground, nx.ground, t);
    const fg = lerpC({}, d.fog, nx.fog, t); scene.fogColor.set(fg.r, fg.g, fg.b);
    scene.fogDensity += ((d.fogD + (nx.fogD - d.fogD) * t) - scene.fogDensity) * Math.min(1, dt * 2);
    const sk = lerpC({}, d.sky, nx.sky, t); scene.clearColor.r += (sk.r - scene.clearColor.r) * Math.min(1, dt * 2); scene.clearColor.g += (sk.g - scene.clearColor.g) * Math.min(1, dt * 2); scene.clearColor.b += (sk.b - scene.clearColor.b) * Math.min(1, dt * 2);
    hemi.intensity += (((d.scenery === "tunnel") ? 0.4 : 0.95) - hemi.intensity) * Math.min(1, dt * 2);
  }

  // ---------------------------------------------------------------- camera
  function snapCamera() {
    const cp = cart.position;
    camera.position.set(cp.x - frame.tx * 9 + frame.uxp * 4, cp.y - frame.ty * 9 + frame.uyp * 4, cp.z - frame.tz * 9 + frame.uzp * 4);
    camTarget.set(cp.x + frame.tx * 10, cp.y + frame.ty * 10 + 1.2, cp.z + frame.tz * 10);
    camera.setTarget(camTarget);
  }
  function updateCamera(dt) {
    const cp = cart.position;
    const k = 1 - Math.exp(-dt * 7);
    let dx, dy, dz, tgx, tgy, tgz;
    if (camMode === "third") {
      dx = cp.x - frame.tx * 9 + frame.uxp * 4.0; dy = cp.y - frame.ty * 9 + frame.uyp * 4.0; dz = cp.z - frame.tz * 9 + frame.uzp * 4.0;
      tgx = cp.x + frame.tx * 10; tgy = cp.y + frame.ty * 10 + 1.2; tgz = cp.z + frame.tz * 10;
    } else {
      dx = cp.x + frame.uxp * 1.5 + frame.tx * 0.3; dy = cp.y + frame.uyp * 1.5 + frame.ty * 0.3; dz = cp.z + frame.uzp * 1.5 + frame.tz * 0.3;
      tgx = cp.x + frame.tx * 14; tgy = cp.y + frame.ty * 14 + 0.6; tgz = cp.z + frame.tz * 14;
    }
    camera.position.x += (dx - camera.position.x) * k; camera.position.y += (dy - camera.position.y) * k; camera.position.z += (dz - camera.position.z) * k;
    camTarget.x += (tgx - camTarget.x) * k; camTarget.y += (tgy - camTarget.y) * k; camTarget.z += (tgz - camTarget.z) * k;
    camera.setTarget(camTarget);
    ground.position.set(cp.x, cp.y - 5, cp.z);
  }

  // ---------------------------------------------------------------- others
  function updateOthers(dt) {
    for (const [id, o] of Net.others) {
      let e = others.get(id);
      if (!e) { e = { node: makeCart(o.color || "#58f5ff"), label: makeLabel(o.name || "Rider", o.color), dispS: o.s }; e.label.parent = e.node; e.label.position.y = 2.2; others.set(id, e); }
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
    $("biome").textContent = Track.biomeAt(s).name;
    $("dist").textContent = (s / 1000).toFixed(2);
    $("time").textContent = fmtTime(state === "finished" ? finishTime : elapsed);
    const pct = Math.min(100, (s / Track.LENGTH) * 100);
    $("pct").textContent = Math.floor(pct); $("prog").style.width = pct + "%";
    if (Net.connected) { $("netdot").className = "dot on"; $("ridercount").textContent = Net.count + (Net.count === 1 ? " rider" : " riders") + " online"; }
    else { $("netdot").className = "dot off"; $("ridercount").textContent = "Solo ride"; }
    const warn = $("warn");
    if (warnRatio > 0.78 && state === "riding") { warn.style.opacity = Math.min(1, (warnRatio - 0.78) / 0.22); warn.style.boxShadow = "inset 0 0 150px 40px rgba(255,50,50," + (0.25 + 0.35 * Math.min(1, warnRatio)) + ")"; }
    else warn.style.opacity = 0;
  }
  let toastTimer = 0;
  function toast(h1, p) { $("toastH1").textContent = h1; $("toastP").textContent = p || ""; const t = $("toast"); t.classList.remove("show"); void t.offsetWidth; t.classList.add("show"); toastTimer = 2.6; }

  // ---------------------------------------------------------------- main update
  function update(dt) {
    frameCount++;
    if (state === "riding") {
      const thr = throttle();
      if (thr > 0) v += A_ENG * dt;
      else if (thr < 0) { if (v > 0.3) v -= A_BRAKE * dt; else v -= A_REV * dt; }
      v -= G * frame.ty * dt;                                   // hill gravity (ty = sin slope)
      v -= (0.5 * Math.sign(v) + 0.0052 * v * Math.abs(v)) * dt; // resistance + drag (terminal ~50 m/s)
      if (v > V_MAX) v = V_MAX; if (v < V_REV_MAX) v = V_REV_MAX;
      s += v * dt;
      if (s < 0) { s = 0; if (v < 0) v = 0; }
      Track.sample(s, frame);
      const aLat = v * v * frame.kappa;
      warnRatio = aLat / A_LAT_MAX;
      if (aLat > A_LAT_MAX && Math.abs(v) > 4) derail();
      else if (s >= Track.LENGTH - DS - 2) finish();
      else placeCart();
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
      updateCamera(dt); updateBiome(dt); streamChunks(2); updateOthers(dt);
      netT += dt; if (netT > 0.08) { netT = 0; Net.sendState(s, v, state === "derail", state === "finished"); }
      hudT += dt; if (hudT > 0.1) { hudT = 0; updateHUD(); }
    }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) $("toast").classList.remove("show"); }
  }

  scene.onBeforeRenderObservable.add(() => { update(Math.min(0.05, engine.getDeltaTime() / 1000)); });

  // ---------------------------------------------------------------- boot
  // pre-build the opening stretch so the first frame isn't empty
  for (let ci = 0; ci <= 13; ci++) buildChunk(ci);
  Track.sample(0, frame); placeCart();
  camera.position.set(frame.x - frame.tx * 12 + 5, frame.y + 6, frame.z - frame.tz * 12);
  camTarget.set(frame.x, frame.y + 1, frame.z);
  engine.runRenderLoop(() => scene.render());
  addEventListener("resize", () => engine.resize());

  // ---------------------------------------------------------------- start UI
  const SWATCHES = ["#ffcf33", "#ff2a4d", "#2a9fff", "#2ecc71", "#a23cff", "#ff8a3c", "#58f5ff", "#ff5fa2"];
  const swWrap = $("swatches");
  myColor = SWATCHES[(Math.random() * SWATCHES.length) | 0];
  SWATCHES.forEach((c) => { const d = document.createElement("div"); d.className = "sw" + (c === myColor ? " sel" : ""); d.style.background = c; d.onclick = () => { myColor = c; [...swWrap.children].forEach((x) => x.classList.remove("sel")); d.classList.add("sel"); }; swWrap.appendChild(d); });
  $("name").value = "Rider" + (100 + (Math.random() * 900 | 0));
  $("loading").textContent = "Line ready · " + (Track.LENGTH / 1000).toFixed(1) + " km ahead";

  function startRide() {
    myName = ($("name").value || "Rider").slice(0, 14);
    // recolour player cart to the chosen colour
    const col = C3.FromHexString(myColor);
    cart.getChildMeshes().forEach((m) => { if (m.material && m.material.name.startsWith("cb")) { m.material.diffuseColor = col; m.material.emissiveColor = col.scale(0.18); } });
    document.getElementById("start").classList.add("hide");
    document.getElementById("hud").classList.add("show");
    if (matchMedia("(pointer: coarse)").matches) { $("tForward").classList.add("show"); $("tBack").classList.add("show"); }
    state = "riding"; s = 0; v = 0; startTime = performance.now(); Track.sample(0, frame); placeCart(); snapCamera();
    Net.connect({ name: myName, color: myColor });
    toast("Off you go!", "Hold ▲ to roll · mind the tight bends");
  }
  $("go").onclick = startRide;
  $("name").addEventListener("keydown", (e) => { if (e.key === "Enter") startRide(); });

  window.CART = { get s() { return s; }, set s(x) { s = x; Track.sample(s, frame); if (state !== "ready") { placeCart(); snapCamera(); } }, get v() { return v; }, set v(x) { v = x; }, get state() { return state; }, start: startRide, tick: (steps, dt) => { dt = dt || 1 / 60; for (let i = 0; i < steps; i++) update(dt); }, info: () => ({ s, v, state, biome: Track.biomeAt(s).name, riders: Net.count, others: others.size, chunks: chunks.size }) };
})();
