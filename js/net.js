/* =====================================================================
   NET — thin WebSocket client for the shared world.

   Connects back to whatever host served the page, so the same `node server.cjs`
   that delivers the game also runs the multiplayer room. If the socket can't
   open (e.g. the page is on static hosting with no server behind it), the game
   keeps running perfectly as a solo ride — multiplayer just stays empty.
   ===================================================================== */
const Net = (() => {
  let ws = null;
  let selfId = -1;
  let connected = false;
  const others = new Map(); // id -> { name, color, s, v, d, f, dispS }
  let myInfo = { name: "Rider", color: "#ffcf33" };

  function connect(info) {
    myInfo = info;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // already connecting/open
    let url;
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      // file:// or no host -> nothing to connect to; stay solo.
      if (!location.host) return;
      url = proto + "//" + location.host;
      ws = new WebSocket(url);
    } catch (e) {
      return;
    }
    ws.onopen = () => {
      connected = true;
      ws.send(JSON.stringify({ t: "join", name: info.name, color: info.color, k: info.k || "standard" }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === "welcome") {
        selfId = m.id;
      } else if (m.t === "world") {
        const seen = new Set();
        for (const p of m.ps) {
          if (p.id === selfId) continue;
          seen.add(p.id);
          let o = others.get(p.id);
          if (!o) { o = { dispS: p.s }; others.set(p.id, o); }
          o.name = p.n; o.color = p.c; o.s = p.s; o.v = p.v; o.d = p.d; o.f = p.f; o.k = p.k || "standard";
        }
        for (const id of [...others.keys()]) if (!seen.has(id)) others.delete(id);
      } else if (m.t === "left") {
        others.delete(m.id);
      }
    };
    ws.onclose = () => { connected = false; others.clear(); };
    ws.onerror = () => { /* swallow — solo fallback */ };
  }

  function sendState(s, v, d, f, k) {
    if (connected && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: "state", s, v, d: d ? 1 : 0, f: f ? 1 : 0, k }));
    }
  }
  function setCart(k) {
    if (connected && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "join", name: myInfo.name, color: myInfo.color, k }));
  }

  return {
    connect, sendState, setCart, others,
    get connected() { return connected; },
    get count() { return others.size + 1; },
  };
})();
