# Damien's Cart Ride 🎢

A 3D cart-on-rails ride built with [Babylon.js](https://www.babylonjs.com/). Climb aboard
and ride a ~30‑minute railway through pine forest, red canyon, crystal cave, neon city,
snowfield and beach. Work the throttle over the hills — but **take a tight bend too fast and
you fly off the track**, back to the start you go.

## Controls
- **▲ / W** — roll forward
- **▼ / S** — brake / reverse
- **C** — toggle chase / first‑person camera
- **R** — restart from the beginning

The cart steers itself along the rail; your job is the throttle — and braking in time for
the corners. Watch the rail for **pads**: glowing cyan **boost** strips give you a speed
surge, and orange **jump** ramps launch you into the air (you can't fly off a bend while
airborne — land first). Corners are forgiving for a split second, so a quick brake tap
saves you; only a wild overspeed flies off instantly.

## Multiplayer (one shared world)
`server.cjs` is a zero‑dependency Node server that serves the page **and** runs a WebSocket
room. Everyone who connects rides the same procedurally‑generated line and sees each other's
carts in real time.

```bash
node server.cjs 8016      # then open http://localhost:8016
```

> **Note:** GitHub Pages can only host static files, so the Pages build plays as a **solo
> ride** (it gracefully falls back when no server is reachable). To ride *together*, run
> `node server.cjs` on a host you control and share that URL.

## Files
- `index.html` — page shell, HUD, start screen
- `js/track.js` — deterministic procedural railway (same seed = same world for everyone)
- `js/net.js` — WebSocket client (degrades to solo if offline)
- `js/main.js` — Babylon scene, cart physics, streamed track, other riders
- `server.cjs` — static file server + hand‑rolled WebSocket multiplayer room
