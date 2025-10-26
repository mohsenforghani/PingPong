// server.js
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import config from './config.js';

const {
  SERVER_PORT: PORT,
  MAX_ROOMS,
  LOGICAL_W,
  LOGICAL_H,
  BALL_SPEED,
  BALL_RADIUS,
  PADDLE_W,
  PADDLE_H,
  WIN_SCORE,
  TICK_RATE,
  LOBBY_REFRESH
} = config;

// ------------------ ساخت سرور HTTP و WebSocket ------------------
const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

let nextClientId = 1;
const clients = new Map();
const rooms = Array.from({ length: MAX_ROOMS }, () => ({
  id: 0,
  status: 'empty', // empty | waiting | playing
  players: [],
  scores: [0, 0],
  ball: { x: LOGICAL_W / 2, y: LOGICAL_H / 2, vx: 0, vy: 0 },
}));

// ------------------ ابزارهای کمکی ------------------
function broadcastAll(type, payload) {
  const msg = JSON.stringify({ type, ...payload });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

function send(ws, type, payload = {}) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload }));
}

function snapshotLobby() {
  return rooms.map((r, i) => ({
    id: i,
    status: r.status,
    names: r.players.map(p => p.name),
    scores: r.scores
  }));
}

// ------------------ مدیریت لابی ------------------
function updateLobbyAll() {
  broadcastAll('lobbySnapshot', { rooms: snapshotLobby() });
}

// ------------------ فیزیک بازی ------------------
function resetBall(room) {
  const dir = Math.random() < 0.5 ? 1 : -1;
  room.ball = {
    x: LOGICAL_W / 2,
    y: LOGICAL_H / 2,
    vx: BALL_SPEED * (Math.random() * 0.5 + 0.8) * dir,
    vy: BALL_SPEED * (Math.random() * 0.5 + 0.8) * (Math.random() < 0.5 ? 1 : -1)
  };
}

function tickRoom(room) {
  if (room.status !== 'playing') return;
  const b = room.ball;
  b.x += b.vx;
  b.y += b.vy;

  // دیواره‌ها
  if (b.x < BALL_RADIUS || b.x > LOGICAL_W - BALL_RADIUS) b.vx *= -1;

  // برخورد با پدل
  room.players.forEach((p, idx) => {
    const py = idx === 0 ? 30 : LOGICAL_H - 40;
    if (
      b.y + BALL_RADIUS > py &&
      b.y - BALL_RADIUS < py + PADDLE_H &&
      b.x > p.paddleX &&
      b.x < p.paddleX + PADDLE_W
    ) {
      b.vy *= -1;
      b.y += b.vy > 0 ? 5 : -5;
    }
  });

  // گل شدن توپ
  if (b.y < 0) {
    room.scores[1]++;
    if (room.scores[1] >= WIN_SCORE) endGame(room, 1);
    else resetBall(room);
  } else if (b.y > LOGICAL_H) {
    room.scores[0]++;
    if (room.scores[0] >= WIN_SCORE) endGame(room, 0);
    else resetBall(room);
  }
}

function endGame(room, winnerIdx) {
  room.status = 'waiting_rematch';
  broadcastRoom(room, 'gameover', { winner: winnerIdx, scores: room.scores });
}

// ------------------ پخش وضعیت بازی ------------------
function broadcastRoom(room, type, payload = {}) {
  room.players.forEach(p => send(p.ws, type, payload));
}

// ------------------ Game Loop ------------------
setInterval(() => {
  for (const room of rooms) {
    tickRoom(room);
    if (room.status === 'playing') {
      broadcastRoom(room, 'state', {
        state: {
          ball: { ...room.ball, r: BALL_RADIUS },
          paddles: room.players.map((p, i) => ({
            x: p.paddleX,
            y: i === 0 ? 20 : LOGICAL_H - 40,
            w: PADDLE_W,
            h: PADDLE_H
          })),
          scores: room.scores
        },
        meta: { ts: Date.now() }
      });
    }
  }
}, TICK_RATE);

// ------------------ WebSocket Connection ------------------
wss.on('connection', ws => {
  const clientId = nextClientId++;
  const client = { id: clientId, name: `بازیکن ${clientId}`, room: null, ws, paddleX: LOGICAL_W / 2 - PADDLE_W / 2 };
  clients.set(clientId, client);

  send(ws, 'assigned', { clientId });
  updateLobbyAll();

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }
    const t = data.type;

    // تغییر نام بازیکن
    if (t === 'setName') {
      client.name = data.name?.slice(0, 20) || client.name;
      updateLobbyAll();
      return;
    }

    // درخواست لابی
    if (t === 'requestLobby') {
      send(ws, 'lobbySnapshot', { rooms: snapshotLobby() });
      return;
    }

    // درخواست پیوستن به روم
    if (t === 'joinRoom') {
      const r = rooms[data.roomId];
      if (!r) return;
      if (r.status === 'empty') {
        r.status = 'waiting';
        r.players.push(client);
        client.room = r;
        send(ws, 'roomRequested', { roomId: data.roomId });
        updateLobbyAll();
      } else if (r.status === 'waiting') {
        r.players.push(client);
        client.room = r;
        r.status = 'playing';
        r.scores = [0, 0];
        resetBall(r);
        r.players.forEach((p, i) => send(p.ws, 'start', { roomId: data.roomId, playerIndex: i }));
        updateLobbyAll();
      }
      return;
    }

    // حرکت پدل
    if (t === 'paddle' && client.room) {
      client.paddleX = Math.max(0, Math.min(LOGICAL_W - PADDLE_W, data.x));
      return;
    }

    // ری‌مچ
    if (t === 'rematch' && client.room) {
      const r = client.room;
      if (r.status === 'waiting_rematch') {
        client.rematch = true;
        if (r.players.every(p => p.rematch)) {
          r.scores = [0, 0];
          resetBall(r);
          r.players.forEach(p => (p.rematch = false));
          r.status = 'playing';
          r.players.forEach((p, i) => send(p.ws, 'start', { roomId: r.id, playerIndex: i }));
        } else {
          const opp = r.players.find(p => p !== client);
          send(opp.ws, 'rematchRequested');
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    if (client.room) {
      const r = client.room;
      r.players = r.players.filter(p => p !== client);
      if (r.players.length === 0) r.status = 'empty';
      else {
        r.status = 'waiting';
        r.scores = [0, 0];
        broadcastRoom(r, 'opponent_left');
      }
    }
    updateLobbyAll();
  });
});

// ------------------ لابی خودکار ------------------
setInterval(updateLobbyAll, LOBBY_REFRESH);

httpServer.listen(PORT, () => console.log(`✅ Server running on ws://localhost:${PORT}`));
