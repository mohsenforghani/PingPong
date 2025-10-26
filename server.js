// server.js
import WebSocket, { WebSocketServer } from 'ws';
import {
  PORT, GAME_W, GAME_H, BASE_BALL_SPEED, MAX_SPEED, BALL_RADIUS,
  MAX_SCORE, TICK_HZ, HEARTBEAT_MS, MAX_MISSED_PONG,
  TOTAL_ROOMS, rooms, joinLobby, removePlayerFromLobby, getLobbySnapshot
} from './config.js';

console.log('Starting PingPong Server on port', PORT);

const wss = new WebSocketServer({ port: PORT });

// --- سرور state ---
let clients = new Map(); // clientId -> ws
let nextClientId = 1;

let games = {}; // roomId -> { state, interval }

// --- توابع کمکی ---
function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcastLobby() {
  const snapshot = getLobbySnapshot();
  clients.forEach(ws => send(ws, { type: 'lobbySnapshot', rooms: snapshot }));
}

// --- ایجاد توپ و ریست ---
function resetBall(state) {
  state.ball = {
    x: GAME_W / 2,
    y: GAME_H / 2,
    vx: BASE_BALL_SPEED * (Math.random() > 0.5 ? 1 : -1),
    vy: BASE_BALL_SPEED * (Math.random() > 0.5 ? 1 : -1),
    r: BALL_RADIUS
  };
}

function createGameState(room) {
  return {
    roomId: room.id,
    ball: { x: 0, y: 0, vx: 0, vy: 0, r: BALL_RADIUS },
    paddles: [
      { x: GAME_W / 2 - 50, y: 20, w: 100, h: 20 },             // player1
      { x: GAME_W / 2 - 50, y: GAME_H - 50, w: 100, h: 20 }     // player2
    ],
    scores: [0, 0]
  };
}

// --- بازیابی clientId از ws ---
function getClientId(ws) {
  for (let [id, sock] of clients.entries()) {
    if (sock === ws) return id;
  }
  return null;
}
// --- WebSocket connection ---
wss.on('connection', ws => {
  const clientId = nextClientId++;
  clients.set(clientId, ws);
  ws._meta = { missedPongs: 0, name: null, currentRoom: null };

  console.log(`Client ${clientId} connected`);
  send(ws, { type: 'assigned', clientId });

  // ارسال snapshot لابی
  broadcastLobby();

  ws.on('message', msgRaw => {
    let data;
    try { data = JSON.parse(msgRaw); } catch { return; }
    const t = data.type;

    switch(t) {
      case 'setName':
        ws._meta.name = data.name || `بازیکن${clientId}`;
        send(ws, { type: 'joined', name: ws._meta.name });
        broadcastLobby();
        break;

      case 'requestRoom':
        const roomId = data.roomId;
        joinLobby(roomId, ws._meta.name, clientId);
        ws._meta.currentRoom = roomId;
        send(ws, { type: 'roomRequested', roomId });
        broadcastLobby();
        startGameIfReady(roomId);
        break;

      case 'cancelRequest':
        if (ws._meta.currentRoom != null) {
          removePlayerFromLobby(ws._meta.currentRoom, clientId);
          ws._meta.currentRoom = null;
          send(ws, { type: 'requestCancelled' });
          broadcastLobby();
        }
        break;

      case 'paddle':
        handlePaddleMove(ws, data.x);
        break;

      case 'pong':
        ws._meta.missedPongs = 0;
        break;

      case 'rematch':
        handleRematch(ws);
        break;
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});
// --- شروع بازی اگر هر دو حاضر شدند ---
function startGameIfReady(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.status === 'playing' && !games[roomId]) {
    const state = createGameState(room);
    resetBall(state);
    games[roomId] = { state, interval: setInterval(()=> gameLoop(roomId), 1000/TICK_HZ) };
    // اطلاع به بازیکنان
    [room.player1, room.player2].forEach(p => {
      const ws = clients.get(p.id);
      if (ws) send(ws, { type: 'start', roomId, playerIndex: p === room.player1 ? 0 : 1 });
    });
  }
}

// --- حرکت توپ و برخورد ---
function gameLoop(roomId) {
  const g = games[roomId];
  if (!g) return;
  const state = g.state;
  const b = state.ball;

  b.x += b.vx;
  b.y += b.vy;

  // برخورد با دیوار
  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
  if (b.x + b.r > GAME_W) { b.x = GAME_W - b.r; b.vx = -Math.abs(b.vx); }

  // برخورد با پدل‌ها
  state.paddles.forEach((p, idx) => {
    if (b.y + b.r > p.y && b.y - b.r < p.y + p.h &&
        b.x + b.r > p.x && b.x - b.r < p.x + p.w) {
      const offset = (b.x - (p.x + p.w/2)) / (p.w/2);
      const speed = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
      b.vy = -b.vy;
      b.vx = offset * Math.max(1.2, speed);
      const cur = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
      if (cur > MAX_SPEED) { const f = MAX_SPEED / cur; b.vx *= f; b.vy *= f; }
      if (idx === 0) b.y = p.y + p.h + b.r + 0.1;
      else b.y = p.y - b.r - 0.1;
    }
  });

  // امتیازدهی
  if (b.y < 0) {
    state.scores[1]++;
    checkGameOver(roomId);
    resetBall(state);
  }
  if (b.y > GAME_H) {
    state.scores[0]++;
    checkGameOver(roomId);
    resetBall(state);
  }

  // ارسال state به بازیکنان
  sendGameState(roomId);
}

// --- ارسال state ---
function sendGameState(roomId) {
  const g = games[roomId];
  if (!g) return;
  const room = rooms[roomId];
  const payload = {
    type: 'state',
    state: g.state
  };
  [room.player1, room.player2].forEach(p => {
    const ws = clients.get(p.id);
    if (ws) send(ws, payload);
  });
}

// --- بررسی پایان بازی ---
function checkGameOver(roomId) {
  const g = games[roomId];
  const room = rooms[roomId];
  if (!g || !room) return;
  const scores = g.state.scores;
  if (scores[0] >= MAX_SCORE || scores[1] >= MAX_SCORE) {
    [room.player1, room.player2].forEach((p, idx) => {
      const ws = clients.get(p.id);
      if (ws) send(ws, { type: 'gameover', winner: scores[0]>=MAX_SCORE?0:1, scores });
    });
    clearInterval(g.interval);
    delete games[roomId];
    room.status = 'empty';
    room.player1 = null;
    room.player2 = null;
    broadcastLobby();
  }
}

// --- مدیریت paddle move ---
function handlePaddleMove(ws, x) {
  const roomId = ws._meta.currentRoom;
  if (roomId == null) return;
  const g = games[roomId];
  if (!g) return;
  const idx = (g.state.paddles[0].y < g.state.paddles[1].y) ? 0 : 1;
  g.state.paddles[idx].x = Math.max(0, Math.min(GAME_W - g.state.paddles[idx].w, x));
}
// --- heartbeat ---
setInterval(() => {
  clients.forEach((ws, clientId) => {
    ws._meta.missedPongs = (ws._meta.missedPongs || 0) + 1;
    if (ws._meta.missedPongs > MAX_MISSED_PONG) {
      handleDisconnect(ws);
      return;
    }
    send(ws, { type: 'ping', ts: Date.now() });
  });
}, HEARTBEAT_MS);

// --- مدیریت قطع اتصال ---
function handleDisconnect(ws) {
  const clientId = getClientId(ws);
  if (clientId != null) {
    const roomId = ws._meta.currentRoom;
    if (roomId != null) removePlayerFromLobby(roomId, clientId);
    clients.delete(clientId);

    // اگر در بازی بود، اعلام به حریف
    const g = games[roomId];
    if (g) {
      const room = rooms[roomId];
      [room.player1, room.player2].forEach(p => {
        if (p && p.id !== clientId) {
          const w = clients.get(p.id);
          if (w) send(w, { type: 'opponent_left' });
        }
      });
      clearInterval(g.interval);
      delete games[roomId];
      room.status = 'empty';
      room.player1 = null;
      room.player2 = null;
    }
    broadcastLobby();
  }
}

// --- مدیریت درخواست ری‌مچ ---
function handleRematch(ws) {
  const roomId = ws._meta.currentRoom;
  if (roomId == null) return;
  const room = rooms[roomId];
  if (!room) return;
  ws._meta.rematchRequested = true;

  const otherPlayer = (room.player1.id === getClientId(ws)) ? room.player2 : room.player1;
  const wsOther = clients.get(otherPlayer.id);
  if (wsOther) send(wsOther, { type: 'rematchRequested' });

  if (wsOther && wsOther._meta.rematchRequested) {
    // هر دو درخواست داده‌اند، شروع دوباره
    startGameIfReady(roomId);
    ws._meta.rematchRequested = false;
    wsOther._meta.rematchRequested = false;
    send(ws, { type: 'rematchAccepted' });
    send(wsOther, { type: 'rematchAccepted' });
  }
}
