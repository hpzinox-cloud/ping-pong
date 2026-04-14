const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// HTTP server to serve the HTML client
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const file = path.join(__dirname, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocket.Server({ server: httpServer });

// ─── State ────────────────────────────────────────────────────────────────────

const W = 900, H = 560;
const PAD_W = 12, PAD_H = 100, BALL_R = 8;
const PAD_SPEED = 7, BASE_SPEED = 6, MAX_SPEED = 14;
const WINNING_SCORE = 7;
const TICK_RATE = 1000 / 60;

let lobby = [];           // players waiting  [{ws, name}]
let rooms = new Map();    // roomId -> room
let roomCounter = 0;

function broadcast(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastLobby() {
  const names = lobby.map(p => p.name);
  // Send to lobby members
  lobby.forEach(p => broadcast(p.ws, { type: 'lobby', players: names }));
  // Send to all rooms too so spectators can see lobby
  rooms.forEach(room => {
    room.players.forEach(p => broadcast(p.ws, { type: 'lobby', players: names }));
  });
}

// ─── Room / Game ──────────────────────────────────────────────────────────────

function createRoom(p1, p2) {
  const id = ++roomCounter;
  const room = {
    id,
    players: [p1, p2],
    state: initGameState(),
    interval: null,
    keys: { 0: {}, 1: {} }
  };
  rooms.set(id, room);
  p1.roomId = id; p1.side = 0;
  p2.roomId = id; p2.side = 1;

  const info = { type: 'start', roomId: id, names: [p1.name, p2.name] };
  broadcast(p1.ws, info);
  broadcast(p2.ws, info);

  room.interval = setInterval(() => tickRoom(room), TICK_RATE);
  console.log(`Room ${id}: ${p1.name} vs ${p2.name}`);
  return room;
}

function initGameState() {
  return {
    ball: { x: W/2, y: H/2, vx: BASE_SPEED, vy: 2 },
    pads: [
      { x: 20, y: H/2 - PAD_H/2 },
      { x: W - 20 - PAD_W, y: H/2 - PAD_H/2 }
    ],
    score: [0, 0],
    running: true
  };
}

function resetBall(dirX) {
  const angle = (Math.random() * 0.6 - 0.3);
  return {
    x: W/2, y: H/2,
    vx: BASE_SPEED * dirX * Math.cos(angle),
    vy: BASE_SPEED * Math.sin(angle)
  };
}

function tickRoom(room) {
  const s = room.state;
  if (!s.running) return;

  // Move pads
  room.players.forEach((p, i) => {
    const k = room.keys[i];
    if (k.up)   s.pads[i].y -= PAD_SPEED;
    if (k.down) s.pads[i].y += PAD_SPEED;
    s.pads[i].y = Math.max(0, Math.min(H - PAD_H, s.pads[i].y));
  });

  // Move ball
  s.ball.x += s.ball.vx;
  s.ball.y += s.ball.vy;

  // Wall bounce
  if (s.ball.y - BALL_R < 0)  { s.ball.y = BALL_R;      s.ball.vy = Math.abs(s.ball.vy); }
  if (s.ball.y + BALL_R > H)  { s.ball.y = H - BALL_R;  s.ball.vy = -Math.abs(s.ball.vy); }

  // Pad collisions
  for (let i = 0; i < 2; i++) {
    const pad = s.pads[i];
    if (s.ball.x - BALL_R < pad.x + PAD_W &&
        s.ball.x + BALL_R > pad.x &&
        s.ball.y + BALL_R > pad.y &&
        s.ball.y - BALL_R < pad.y + PAD_H) {
      s.ball.vx = -s.ball.vx * 1.05;
      const rel = (s.ball.y - (pad.y + PAD_H/2)) / (PAD_H/2);
      s.ball.vy = rel * BASE_SPEED * 1.2;
      const spd = Math.hypot(s.ball.vx, s.ball.vy);
      if (spd > MAX_SPEED) { s.ball.vx = s.ball.vx/spd*MAX_SPEED; s.ball.vy = s.ball.vy/spd*MAX_SPEED; }
      s.ball.x = i === 0 ? pad.x + PAD_W + BALL_R + 1 : pad.x - BALL_R - 1;
    }
  }

  // Scoring
  if (s.ball.x < 0) {
    s.score[1]++;
    s.ball = resetBall(1);
    checkWin(room);
  }
  if (s.ball.x > W) {
    s.score[0]++;
    s.ball = resetBall(-1);
    checkWin(room);
  }

  // Broadcast state
  const msg = { type: 'state', ball: s.ball, pads: s.pads, score: s.score };
  room.players.forEach(p => broadcast(p.ws, msg));
}

function checkWin(room) {
  const s = room.state;
  const winner = s.score[0] >= WINNING_SCORE ? 0 : s.score[1] >= WINNING_SCORE ? 1 : -1;
  if (winner >= 0) {
    s.running = false;
    clearInterval(room.interval);
    const msg = { type: 'gameover', winner, names: room.players.map(p => p.name), score: s.score };
    room.players.forEach(p => broadcast(p.ws, msg));
    // Return players to lobby after 3s
    setTimeout(() => {
      room.players.forEach(p => {
        p.roomId = null; p.side = null;
        lobby.push(p);
      });
      rooms.delete(room.id);
      broadcastLobby();
    }, 3000);
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

wss.on('connection', ws => {
  const player = { ws, name: null, roomId: null, side: null };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      player.name = (msg.name || 'Anonyme').trim().slice(0, 20);
      lobby.push(player);
      console.log(`${player.name} joined the lobby`);
      broadcastLobby();

      // Match 2 players
      if (lobby.length >= 2) {
        const p1 = lobby.shift();
        const p2 = lobby.shift();
        createRoom(p1, p2);
        broadcastLobby();
      }
    }

    if (msg.type === 'key' && player.roomId !== null) {
      const room = rooms.get(player.roomId);
      if (room) room.keys[player.side] = msg.keys;
    }

    if (msg.type === 'rematch' && player.roomId === null) {
      // Already handled by timeout above, just wait
    }
  });

  ws.on('close', () => {
    // Remove from lobby
    const li = lobby.indexOf(player);
    if (li >= 0) { lobby.splice(li, 1); broadcastLobby(); }

    // Notify room partner
    if (player.roomId !== null) {
      const room = rooms.get(player.roomId);
      if (room) {
        clearInterval(room.interval);
        room.players.forEach(p => {
          if (p !== player) {
            broadcast(p.ws, { type: 'disconnect', name: player.name });
            p.roomId = null; p.side = null;
            lobby.push(p);
          }
        });
        rooms.delete(player.roomId);
        broadcastLobby();
      }
    }
    console.log(`${player.name || '?'} disconnected`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`✅ Pong server running → http://localhost:${PORT}`);
  console.log(`   Place index.html in the same folder as server.js`);
});
