// Damien's Cart Ride — static file server + shared-world multiplayer.
// Pure Node, zero dependencies. Run: node server.cjs [port]
//
// One process = one shared world ("1 server"). Every browser that connects
// joins the SAME ride and sees everyone else's cart in real time. The HTTP
// server and the WebSocket server share a single port, so there is one URL.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8016;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------- static files
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

// ----------------------------------------------------- minimal RFC6455 server
// We implement just enough of the WebSocket protocol to relay tiny JSON
// messages: handshake, masked text frames in, unmasked text frames out,
// ping/pong and close. Messages are small (a few dozen bytes) so they always
// fit in a single frame.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function makeFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.from([0x81, 126, (len >> 8) & 255, len & 255]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

let nextId = 1;
const clients = new Map(); // id -> { socket, name, color, s, v, d, f, alive }

function broadcast(buf, exceptId) {
  for (const [id, c] of clients) {
    if (id === exceptId) continue;
    if (c.socket.writable) c.socket.write(buf);
  }
}

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  socket.setNoDelay(true);

  const id = nextId++;
  const client = { socket, name: "Rider", color: "#ffcf33", k: "standard", s: 0, v: 0, d: 0, f: 0, lastSeen: Date.now() };
  clients.set(id, client);

  // Tell the new client its id.
  socket.write(makeFrame(JSON.stringify({ t: "welcome", id })));

  let buf = Buffer.alloc(0);

  function handleMessage(str) {
    let m;
    try {
      m = JSON.parse(str);
    } catch {
      return;
    }
    client.lastSeen = Date.now();
    if (m.t === "join") {
      client.name = String(m.name || "Rider").slice(0, 14);
      client.color = String(m.color || "#ffcf33").slice(0, 9);
      if (m.k) client.k = String(m.k).slice(0, 16);
    } else if (m.t === "state") {
      client.s = +m.s || 0;
      client.v = +m.v || 0;
      client.d = m.d ? 1 : 0;
      client.f = m.f ? 1 : 0;
      if (m.k) client.k = String(m.k).slice(0, 16);
    }
  }

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Parse as many complete frames as are buffered.
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      let mask;
      if (masked) {
        if (buf.length < offset + 4) break;
        mask = buf.slice(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) break; // wait for the rest of the frame
      let payload = buf.slice(offset, offset + len);
      if (masked) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.slice(offset + len);

      if (opcode === 0x8) {
        // close
        socket.end();
        return;
      } else if (opcode === 0x9) {
        // ping -> pong (echo payload)
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length & 0x7f]), payload]);
        if (socket.writable) socket.write(pong);
      } else if (opcode === 0x1) {
        handleMessage(payload.toString("utf8"));
      }
      // opcode 0xA (pong) and others: ignore
    }
  });

  function cleanup() {
    if (!clients.has(id)) return;
    clients.delete(id);
    broadcast(makeFrame(JSON.stringify({ t: "left", id })));
  }
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

// World snapshot to everyone ~15x/sec. Only the moving bits; the track itself
// is generated identically on every client from a shared seed.
setInterval(() => {
  // cull dead/ghost connections (no message in 12s) — clients send state ~12x/sec
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.lastSeen > 12000) {
      try { c.socket.destroy(); } catch {}
      clients.delete(id);
      broadcast(makeFrame(JSON.stringify({ t: "left", id })));
    }
  }
  if (clients.size === 0) return;
  const ps = [];
  for (const [id, c] of clients) {
    ps.push({ id, n: c.name, c: c.color, k: c.k, s: Math.round(c.s * 100) / 100, v: Math.round(c.v * 10) / 10, d: c.d, f: c.f });
  }
  const frame = makeFrame(JSON.stringify({ t: "world", ps }));
  broadcast(frame);
}, 66);

server.listen(PORT, () =>
  console.log("Cart Ride server (web + multiplayer) on http://localhost:" + PORT)
);
