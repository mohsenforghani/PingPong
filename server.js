// ======================= server.js ==========================
import { WebSocketServer } from "ws";

// ----------------------- CONFIG -----------------------------
const CONFIG = {
  PORT: process.env.PORT || 8080,
  ROOM_COUNT: 10,
  GAME_W: 450,
  GAME_H: 800,
  BASE_BALL_SPEED: 8,
  MAX_SPEED: 12,
  TICK_HZ: 50,
  TARGET_SCORE: 5,
  HEARTBEAT_MS: 10000,
  MAX_MISSED_PONGS: 3
};

const wss = new WebSocketServer({ port: CONFIG.PORT });
console.log(`✅ WebSocket server running on port ${CONFIG.PORT}`);

// ----------------------- STATE ------------------------------
let clients = new Map(); // ws -> {id,name,roomId,playerIndex,lastPaddleTs,missedPongs}
let nextClientId = 1;

// 10 rooms
let rooms = Array.from({ length: CONFIG.ROOM_COUNT }, (_, i) => ({
  id: i,
  status: "empty", // "empty" | "waiting" | "playing"
  players: [], // [ws1, ws2]
  names: ["", ""],
  scores: [0, 0],
  ball: { x: CONFIG.GAME_W / 2, y: CONFIG.GAME_H / 2, vx: 0, vy: 0, r: 15 },
  paddles: [
    { x: CONFIG.GAME_W / 2 - 50, y: 20, w: 100, h: 20 },
    { x: CONFIG.GAME_W / 2 - 50, y: CONFIG.GAME_H - 50, w: 100, h: 20 }
  ],
  loop: null
}));

// ----------------------- UTILS ------------------------------
function send(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcastLobby() {
  const snapshot = {
    type: "lobbySnapshot",
    rooms: rooms.map(r => ({
      id: r.id,
      status: r.status,
      players: r.names,
      scores: r.scores
    }))
  };
  const payload = JSON.stringify(snapshot);
  wss.clients.forEach(c => {
    if (c.readyState === c.OPEN) c.send(payload);
  });
}

function resetBall(room, towards = 1) {
  const b = room.ball;
  b.x = CONFIG.GAME_W / 2;
  b.y = CONFIG.GAME_H / 2;
  const ang = (Math.random() * Math.PI / 3) - (Math.PI / 6);
  const dir = towards > 0 ? 1 : -1;
  b.vx = CONFIG.BASE_BALL_SPEED * Math.sin(ang);
  b.vy = dir * CONFIG.BASE_BALL_SPEED * Math.cos(ang);
}
// ----------------------- GAME LOOP --------------------------
function startGame(room) {
  if (room.loop) clearInterval(room.loop);
  room.status = "playing";
  room.scores = [0, 0];
  resetBall(room, Math.random() < 0.5 ? 1 : -1);

  room.loop = setInterval(() => tick(room), 1000 / CONFIG.TICK_HZ);

  // notify both players
  room.players.forEach((p, idx) =>
    send(p, { type: "start", roomId: room.id, playerIndex: idx })
  );
  broadcastLobby();
}

function endGame(room, winnerIndex) {
  clearInterval(room.loop);
  room.loop = null;
  room.status = "waiting"; // stay for possible rematch
  room.players.forEach((p, idx) =>
    send(p, {
      type: "gameover",
      winner: winnerIndex,
      scores: room.scores
    })
  );
  broadcastLobby();
}

function tick(room) {
  const b = room.ball;
  const s = room.scores;

  // move ball
  b.x += b.vx;
  b.y += b.vy;

  // wall bounce
  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
  if (b.x + b.r > CONFIG.GAME_W) { b.x = CONFIG.GAME_W - b.r; b.vx = -Math.abs(b.vx); }

  // paddle collisions
  for (let i = 0; i < 2; i++) {
    const p = room.paddles[i];
    if (b.y + b.r > p.y && b.y - b.r < p.y + p.h &&
        b.x + b.r > p.x && b.x - b.r < p.x + p.w) {
      const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
      const speed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
      b.vy = -b.vy;
      b.vx = offset * Math.max(1.1, speed);
      const cur = Math.sqrt(b.vx ** 2 + b.vy ** 2);
      if (cur > CONFIG.MAX_SPEED) {
        const f = CONFIG.MAX_SPEED / cur;
        b.vx *= f; b.vy *= f;
      }
      if (i === 0) b.y = p.y + p.h + b.r + 0.1;
      else b.y = p.y - b.r - 0.1;
    }
  }

  // scoring
  const SAFE_MARGIN = 10;
  if (b.y < -SAFE_MARGIN) { s[1]++; resetBall(room, -1); }
  if (b.y > CONFIG.GAME_H + SAFE_MARGIN) { s[0]++; resetBall(room, 1); }

  // check game over
  if (s[0] >= CONFIG.TARGET_SCORE || s[1] >= CONFIG.TARGET_SCORE) {
    const winner = s[0] > s[1] ? 0 : 1;
    endGame(room, winner);
    return;
  }

  // broadcast game state
  const statePayload = {
    type: "state",
    state: {
      ball: { x: b.x, y: b.y, r: b.r },
      paddles: room.paddles.map(p => ({ x: p.x, y: p.y, w: p.w, h: p.h })),
      scores: s
    },
    meta: { ts: Date.now() }
  };
  room.players.forEach(p => send(p, statePayload));
}
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const PORT = 8080;
const MAX_ROOMS = 10;
const TICK_RATE = 1000 / 60;
const BALL_SPEED = 5;
const WIN_SCORE = 20;

const server = createServer();
const wss = new WebSocketServer({ server });

/* ========== ساختار داده‌ها ========== */
const clients = new Map(); // clientId → ws
let clientCounter = 0;

const rooms = Array.from({ length: MAX_ROOMS }, (_, i) => ({
  id: i,
  players: [], // {id, name, ws}
  scores: [0, 0],
  state: null,
  status: 'empty', // 'empty' | 'waiting' | 'playing'
  lastUpdate: Date.now()
}));

/* ========== ابزارهای کمکی ========== */
function broadcastAll(type, payload = {}) {
  const msg = JSON.stringify({ type, ...payload });
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type, ...payload }));
}

function sendToRoom(room, type, payload = {}) {
  for (const p of room.players)
    send(p.ws, type, payload);
}

function snapshotLobby() {
  const roomsData = rooms.map(r => ({
    id: r.id,
    status: r.status,
    names: r.players.map(p => p.name),
    scores: r.scores
  }));
  return { type: 'lobbySnapshot', rooms: roomsData };
}

/* ========== ایجاد شناسه یکتا برای هر کلاینت ========== */
wss.on('connection', (ws) => {
  const id = ++clientCounter;
  clients.set(id, ws);
  send(ws, 'assigned', { clientId: id });
  send(ws, 'lobbySnapshot', snapshotLobby());

  ws.on('message', (msg) => handleMessage(ws, id, msg));
  ws.on('close', () => handleDisconnect(id));
});

/* ========== مدیریت پیام‌های کلاینت ========== */
function handleMessage(ws, id, msg) {
  let data;
  try { data = JSON.parse(msg); } catch { return; }
  const t = data.type;

  switch (t) {
    case 'setName': {
      ws.playerName = data.name?.trim() || `بازیکن ${id}`;
      send(ws, 'joined', { name: ws.playerName });
      send(ws, 'lobbySnapshot', snapshotLobby());
      break;
    }

    case 'requestRoom': {
      const room = rooms[data.roomId];
      if (!room) return send(ws, 'error', { message: 'اتاق نامعتبر است' });

      if (room.status === 'empty') {
        room.players.push({ id, name: ws.playerName, ws });
        room.status = 'waiting';
        send(ws, 'roomRequested', { roomId: room.id });
      }
      else if (room.status === 'waiting') {
        room.players.push({ id, name: ws.playerName, ws });
        if (room.players.length === 2) startGame(room);
      }
      else send(ws, 'error', { message: 'این اتاق در حال بازی است' });

      broadcastAll('lobbySnapshot', snapshotLobby());
      break;
    }

    case 'cancelRequest': {
      for (const room of rooms) {
        const idx = room.players.findIndex(p => p.id === id);
        if (idx !== -1 && room.status === 'waiting') {
          room.players.splice(idx, 1);
          room.status = 'empty';
          send(ws, 'requestCancelled');
          broadcastAll('lobbySnapshot', snapshotLobby());
          return;
        }
      }
      break;
    }

    case 'move': {
      // فقط اگر در بازی است
      const room = rooms.find(r => r.players.some(p => p.id === id));
      if (room && room.state) {
        const playerIdx = room.players.findIndex(p => p.id === id);
        if (playerIdx !== -1)
          room.state.paddles[playerIdx].x = data.x;
      }
      break;
    }

    case 'rematchRequest': {
      const room = rooms.find(r => r.players.some(p => p.id === id));
      if (!room) return;
      if (!room.rematchRequests) room.rematchRequests = new Set();
      room.rematchRequests.add(id);
      sendToRoom(room, 'rematchRequested');

      if (room.rematchRequests.size === 2) startGame(room, true);
      break;
    }

    case 'pong': {
      ws.lastPong = Date.now();
      break;
    }

    default:
      send(ws, 'error', { message: `unknown message: ${t}` });
  }
}

/* ========== شروع بازی ========== */
function startGame(room, isRematch = false) {
  room.status = 'playing';
  room.scores = [0, 0];
  room.rematchRequests = new Set();

  // تنظیم حالت اولیه توپ و پدال‌ها
  room.state = {
    ball: { x: 250, y: 250, vx: BALL_SPEED, vy: BALL_SPEED, radius: 8 },
    paddles: [
      { x: 200, y: 20, w: 100, h: 10 },
      { x: 200, y: 480, w: 100, h: 10 }
    ]
  };

  room.lastUpdate = Date.now();

  room.players.forEach((p, i) => {
    send(p.ws, 'start', { roomId: room.id, playerIndex: i });
  });

  broadcastAll('lobbySnapshot', snapshotLobby());
}

/* ========== پردازش هر تیک بازی (فیزیک، امتیاز و غیره) ========== */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms) {
    if (room.status !== 'playing' || !room.state) continue;
    const s = room.state;
    s.ball.x += s.ball.vx;
    s.ball.y += s.ball.vy;

    // برخورد با دیواره‌ها
    if (s.ball.x < 0 || s.ball.x > 500) s.ball.vx *= -1;

    // بررسی برخورد با پدال بالا
    if (s.ball.y - s.ball.radius < s.paddles[0].y + s.paddles[0].h &&
        s.ball.x > s.paddles[0].x && s.ball.x < s.paddles[0].x + s.paddles[0].w) {
      s.ball.vy = Math.abs(s.ball.vy);
    }

    // برخورد با پدال پایین
    if (s.ball.y + s.ball.radius > s.paddles[1].y &&
        s.ball.x > s.paddles[1].x && s.ball.x < s.paddles[1].x + s.paddles[1].w) {
      s.ball.vy = -Math.abs(s.ball.vy);
    }

    // بررسی گل
    if (s.ball.y < 0) {
      room.scores[1]++;
      resetBall(s, -1);
    } else if (s.ball.y > 500) {
      room.scores[0]++;
      resetBall(s, 1);
    }

    // بررسی برنده
    const winnerIndex = room.scores.findIndex(sc => sc >= WIN_SCORE);
    if (winnerIndex !== -1) {
      sendToRoom(room, 'gameover', { winner: winnerIndex, scores: room.scores });
      room.status = 'waiting';
      broadcastAll('lobbySnapshot', snapshotLobby());
      continue;
    }

    // ارسال وضعیت جدید
    sendToRoom(room, 'state', { state: s, meta: { ts: now } });
  }
}, TICK_RATE);

function resetBall(state, dir) {
  state.ball.x = 250;
  state.ball.y = 250;
  state.ball.vx = (Math.random() > 0.5 ? 1 : -1) * BALL_SPEED;
  state.ball.vy = dir * BALL_SPEED;
}

/* ========== قطع ارتباط ========== */
function handleDisconnect(id) {
  clients.delete(id);
  for (const room of rooms) {
    const idx = room.players.findIndex(p => p.id === id);
    if (idx !== -1) {
      room.players.splice(idx, 1);
      if (room.status === 'playing')
        sendToRoom(room, 'opponent_left');
      room.status = room.players.length === 0 ? 'empty' : 'waiting';
    }
  }
  broadcastAll('lobbySnapshot', snapshotLobby());
}

/* ========== ارسال لابی برای همه هر ۱۰ ثانیه ========== */
setInterval(() => {
  broadcastAll('lobbySnapshot', snapshotLobby());
}, 10000);

/* ========== راه‌اندازی سرور ========== */
server.listen(PORT, () => {
  console.log(`✅ Server running on ws://localhost:${PORT}`);
});
