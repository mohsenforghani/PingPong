// server.js
'use strict';

/*
  PingPong authoritative server
  - 10 rooms (roomIds 0..9)
  - server-authoritative physics & collision
  - lobby snapshot broadcast (every 10s and on change)
  - rematch flow (both must accept)
  - per-game fixed timestep game loop
  - per-client identification and name registration
*/

const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// ------------------ CONFIG ------------------
const CONFIG = {
  GAME_W: 450,
  GAME_H: 800,
  TICK_HZ: 60,            // physics ticks per second
  SEND_RATE: 20,          // state messages per second to clients
  MAX_SPEED: 14,          // px per physics tick (clamped)
  BASE_BALL_SPEED: 6,     // initial ball speed magnitude (px / tick)
  HEARTBEAT_MS: 10000,
  MAX_MISSED_PONG: 3,
  PADDLE_THROTTLE_MS: 12, // server-side throttle for paddle inputs
  WIN_SCORE: 20,
  SAFE_MARGIN: 8,         // y margin before scoring
  LOBBY_BROADCAST_MS: 10000,
  ROOM_COUNT: 10
};

// ------------------ UTIL ------------------
let globalSeq = 0;
let clientCounter = 0;
function genId() { return (++clientCounter).toString(); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function now() { return Date.now(); }

// ------------------ SERVER STATE ------------------
// clients: Map of clientId -> ws
const clients = new Map();

// rooms: array of length ROOM_COUNT
// each room: { status: 'empty'|'waiting'|'playing', waitingClientId: null or id, gameId: null or id, players: [id,id] }
const rooms = Array.from({length: CONFIG.ROOM_COUNT}, () => ({
  status: 'empty',
  waitingClientId: null,
  gameId: null,
  players: []
}));

// games: map gameId -> game object
const games = {}; // gameId => { id, roomId, players: [wsA, wsB], state, loop, tickCount, sendCounter, rematchVotes }

// telemetry
const METRICS = { gamesCreated:0, gamesActive:0, broadcasts:0 };

// ------------------ SEND / HELPERS ------------------
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (!obj.meta) obj.meta = {};
  obj.meta.seq = ++globalSeq;
  obj.meta.ts = now();
  try {
    ws.send(JSON.stringify(obj));
    METRICS.broadcasts++;
    return true;
  } catch (e) {
    console.warn('send failed', e && e.message);
    return false;
  }
}

function sendToClientId(clientId, obj) {
  const ws = clients.get(clientId);
  if (ws) return safeSend(ws, obj);
  return false;
}

function broadcastLobbySnapshot(force=false) {
  // build rooms info
  const snapshot = rooms.map((r, idx) => {
    if (r.status === 'empty') {
      return { roomId: idx, status: 'empty', label: 'اتاق خالی' };
    } else if (r.status === 'waiting') {
      const name = r.waitingClientId ? (clients.get(r.waitingClientId)?.playerName || '...') : '...';
      return { roomId: idx, status: 'waiting', label: 'اتاق در انتظار بازیکن دوم', waitingName: name };
    } else if (r.status === 'playing') {
      const g = games[r.gameId];
      if (!g) return { roomId: idx, status: 'empty', label: 'اتاق خالی' };
      const p0 = g.state.players[0].name || '...';
      const p1 = g.state.players[1].name || '...';
      const s0 = g.state.scores[0];
      const s1 = g.state.scores[1];
      return { roomId: idx, status: 'playing', label: 'در حال بازی', players: [p0, p1], scores: [s0, s1] };
    }
  });

  const payload = { type: 'lobbySnapshot', rooms: snapshot, meta: { ts: now() } };
  // broadcast to all connected clients
  clients.forEach(ws => safeSend(ws, payload));
}

// ------------------ GAME CREATION / LIFECYCLE ------------------
function createGame(roomId, wsA, wsB) {
  const gameId = 'g' + Math.random().toString(36).substr(2,9);
  const state = {
    ball: { x: CONFIG.GAME_W/2, y: CONFIG.GAME_H/2, vx: CONFIG.BASE_BALL_SPEED, vy: CONFIG.BASE_BALL_SPEED, r: 12 },
    paddles: [
      { x: CONFIG.GAME_W/2 - 50, y: 20, w: 100, h: 20 },
      { x: CONFIG.GAME_W/2 - 50, y: CONFIG.GAME_H - 50, w: 100, h: 20 }
    ],
    scores: [0, 0],
    players: [
      { id: wsA.clientId, name: wsA.playerName || 'playerA' },
      { id: wsB.clientId, name: wsB.playerName || 'playerB' }
    ],
    running: true
  };
  const game = {
    id: gameId,
    roomId,
    players: [wsA, wsB],
    state,
    loop: null,
    tickCount: 0,
    sendCounter: 0,
    rematchVotes: {}
  };
  games[gameId] = game;
  // mark room
  rooms[roomId].status = 'playing';
  rooms[roomId].gameId = gameId;
  rooms[roomId].players = [wsA.clientId, wsB.clientId];
  // attach references to ws
  wsA.gameId = gameId; wsB.gameId = gameId;
  wsA.roomId = roomId; wsB.roomId = roomId;
  wsA.playerIndex = 0; wsB.playerIndex = 1;

  METRICS.gamesCreated++;
  METRICS.gamesActive++;

  // notify players start
  safeSend(wsA, { type: 'start', playerIndex: 0, roomId, meta: { ts: now() } });
  safeSend(wsB, { type: 'start', playerIndex: 1, roomId, meta: { ts: now() } });

  // send initial full state
  broadcastGameState(game);

  // start game loop
  const intervalMs = Math.round(1000 / CONFIG.TICK_HZ);
  game.loop = setInterval(() => gameTick(game), intervalMs);
  return game;
}

function stopGame(game, reason='stopped') {
  if (!game) return;
  if (game.loop) { clearInterval(game.loop); game.loop = null; }
  game.state.running = false;
  METRICS.gamesActive = Math.max(0, METRICS.gamesActive - 1);

  // notify players
  game.players.forEach(ws => {
    safeSend(ws, { type: 'stopped', reason, scores: game.state.scores });
    // cleanup ws metadata
    if (ws) { delete ws.gameId; delete ws.roomId; delete ws.playerIndex; }
  });

  // cleanup room
  const room = rooms[game.roomId];
  if (room) {
    room.status = 'empty';
    room.waitingClientId = null;
    room.gameId = null;
    room.players = [];
  }

  delete games[game.id];
  // broadcast lobby update
  broadcastLobbySnapshot(true);
}

// ------------------ BROADCAST GAME STATE ------------------
function broadcastGameState(game) {
  if (!game) return;
  const s = game.state;
  const payload = {
    type: 'state',
    state: {
      ball: { x: +s.ball.x.toFixed(2), y: +s.ball.y.toFixed(2), r: s.ball.r },
      paddles: s.paddles.map(p => ({ x: +p.x.toFixed(2), y: p.y, w: p.w, h: p.h })),
      scores: s.scores,
      players: s.players.map(p => ({ id: p.id, name: p.name }))
    },
    meta: { ts: now(), tick: game.tickCount }
  };
  game.players.forEach(ws => safeSend(ws, payload));
}

// ------------------ PHYSICS: gameTick + collision detection ------------------
function resetBall(state, towardsPlayer = 1) {
  state.ball.x = CONFIG.GAME_W / 2;
  state.ball.y = CONFIG.GAME_H / 2;
  const ang = (Math.random() * Math.PI / 3) - (Math.PI / 6);
  const dir = (towardsPlayer === 1) ? 1 : -1;
  state.ball.vx = CONFIG.BASE_BALL_SPEED * Math.sin(ang);
  state.ball.vy = dir * CONFIG.BASE_BALL_SPEED * Math.cos(ang);
}

// helper for collision: segment (prev->next) vs rectangle (paddle)
function checkPaddleCollisionSegment(bx, by, nx, ny, r, paddle) {
  // fast plane test then corner quadratic
  const left = paddle.x, right = paddle.x + paddle.w;
  const top = paddle.y, bottom = paddle.y + paddle.h;
  const dy = ny - by;

  // plane tests for top/bottom of paddle
  if (Math.abs(dy) > 1e-9) {
    const candidates = [ top - r, bottom + r ];
    for (const yc of candidates) {
      const t = (yc - by) / dy;
      if (t >= 0 && t <= 1) {
        const cx = bx + (nx - bx) * t;
        if (cx + r > left && cx - r < right) {
          // ensure direction is towards the paddle
          if ((yc === top - r && dy > 0) || (yc === bottom + r && dy < 0)) {
            return { hit: true, t, cx, cy: yc };
          }
        }
      }
    }
  }

  // corner checks (solve quadratic)
  const dx = nx - bx, dy2 = ny - by;
  const corners = [[left, top],[right, top],[left, bottom],[right, bottom]];
  for (const c of corners) {
    const cx = c[0], cy = c[1];
    const ox = bx - cx, oy = by - cy;
    const A = dx*dx + dy2*dy2;
    const B = 2*(ox*dx + oy*dy2);
    const C = ox*ox + oy*oy - r*r;
    if (Math.abs(A) < 1e-9) continue;
    const disc = B*B - 4*A*C;
    if (disc < 0) continue;
    const sqrtD = Math.sqrt(disc);
    const t1 = (-B - sqrtD) / (2*A);
    const t2 = (-B + sqrtD) / (2*A);
    const t = (t1 >= 0 && t1 <= 1) ? t1 : (t2 >= 0 && t2 <= 1) ? t2 : null;
    if (t !== null) {
      const hx = bx + dx*t, hy = by + dy2*t;
      return { hit: true, t, cx: hx, cy: hy };
    }
  }

  return { hit: false };
}

function gameTick(game) {
  const s = game.state;
  const b = s.ball;
  // store prev position
  const prevX = b.x, prevY = b.y;
  let nx = prevX + b.vx;
  let ny = prevY + b.vy;

  // wall X collisions (instant)
  if (nx - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); nx = b.x; }
  else if (nx + b.r > CONFIG.GAME_W) { b.x = CONFIG.GAME_W - b.r; b.vx = -Math.abs(b.vx); nx = b.x; }
  else b.x = nx;

  // paddle collisions with CCD
  let collided = false;
  for (let i = 0; i < 2; i++) {
    const p = s.paddles[i];
    const hit = checkPaddleCollisionSegment(prevX, prevY, nx, ny, b.r, p);
    if (hit.hit) {
      collided = true;
      // compute offset from paddle center
      const paddleCenterX = p.x + p.w/2;
      const offset = clamp((hit.cx - paddleCenterX) / (p.w/2), -1, 1);
      const incomingSpeed = Math.hypot(b.vx, b.vy) || CONFIG.BASE_BALL_SPEED;
      // reflect vertical velocity
      b.vy = -b.vy;
      // horizontal velocity depends on offset and speed
      b.vx = offset * Math.max(1.2, incomingSpeed);
      // small speed boost
      const boosted = Math.min(incomingSpeed * 1.03, CONFIG.MAX_SPEED);
      const factor = boosted / Math.max(1e-6, incomingSpeed);
      b.vx *= factor; b.vy *= factor;
      // push ball outside paddle to avoid re-collision
      if (i === 0) b.y = p.y + p.h + b.r + 0.01; else b.y = p.y - b.r - 0.01;
      break;
    }
  }
  if (!collided) b.y = ny;

  // clamp speed
  const sp = Math.hypot(b.vx, b.vy);
  if (sp > CONFIG.MAX_SPEED) {
    const f = CONFIG.MAX_SPEED / sp;
    b.vx *= f; b.vy *= f;
  }

  // scoring
  if (b.y < -CONFIG.SAFE_MARGIN) {
    s.scores[1]++;
    // check win
    if (s.scores[1] >= CONFIG.WIN_SCORE) {
      // game over
      gameOver(game, 1);
      return;
    } else resetBall(s, 0);
  }
  if (b.y > CONFIG.GAME_H + CONFIG.SAFE_MARGIN) {
    s.scores[0]++;
    if (s.scores[0] >= CONFIG.WIN_SCORE) {
      gameOver(game, 0);
      return;
    } else resetBall(s, 1);
  }

  // tick counters & send at SEND_RATE
  game.tickCount++;
  const sendEvery = Math.max(1, Math.round(CONFIG.TICK_HZ / CONFIG.SEND_RATE));
  if (game.tickCount % sendEvery === 0) broadcastGameState(game);
}

// ------------------ GAMEOVER / REMATCH ------------------
function gameOver(game, winnerIndex) {
  // stop loop (but keep game object for rematch)
  if (game.loop) { clearInterval(game.loop); game.loop = null; }
  game.state.running = false;
  // notify players
  game.players.forEach((ws, idx) => {
    safeSend(ws, { type: 'gameover', winner: winnerIndex, scores: game.state.scores });
  });
  // broadcast lobby (room still shows playing until cleared by stopGame or restart)
  broadcastLobbySnapshot(true);
}

function requestRematch(game, requesterId) {
  if (!game) return;
  game.rematchVotes[requesterId] = true;
  // inform opponent
  const opponentWs = game.players.find(w => w.clientId !== requesterId);
  safeSend(opponentWs, { type: 'rematchRequested', from: requesterId });
  // if both voted true -> restart
  const both = game.players.every(w => game.rematchVotes[w.clientId]);
  if (both) {
    // reset scores and ball, restart loop
    game.state.scores = [0,0];
    resetBall(game.state, 1);
    game.state.running = true;
    game.rematchVotes = {};
    // restart loop
    const intervalMs = Math.round(1000 / CONFIG.TICK_HZ);
    game.tickCount = 0;
    game.loop = setInterval(() => gameTick(game), intervalMs);
    // notify
    game.players.forEach(ws => safeSend(ws, { type: 'rematchAccepted', meta: { ts: now() } }));
    broadcastGameState(game);
  }
}

// ------------------ LOBBY BROADCAST TIMER ------------------
setInterval(() => broadcastLobbySnapshot(true), CONFIG.LOBBY_BROADCAST_MS);

// ------------------ HEARTBEAT ------------------
setInterval(() => {
  clients.forEach(ws => {
    try {
      ws._meta = ws._meta || { missedPongs: 0 };
      ws._meta.missedPongs++;
      if (ws._meta.missedPongs > CONFIG.MAX_MISSED_PONG) {
        // treat as disconnected
        console.warn('client missed pongs, terminating', ws.clientId);
        try { ws.terminate(); } catch (e) {}
        clients.delete(ws.clientId);
        handleDisconnectCleanup(ws);
        return;
      }
      safeSend(ws, { type: 'ping', ts: now() });
    } catch (e) {}
  });
}, CONFIG.HEARTBEAT_MS);

// ------------------ CLEANUP ON DISCONNECT ------------------
function handleDisconnectCleanup(ws) {
  if (!ws) return;
  // if waiting in a room -> clear it
  const roomId = ws.roomId;
  if (typeof roomId === 'number' && rooms[roomId]) {
    const room = rooms[roomId];
    if (room.status === 'waiting' && room.waitingClientId === ws.clientId) {
      room.status = 'empty';
      room.waitingClientId = null;
      room.players = [];
      broadcastLobbySnapshot(true);
    } else if (room.status === 'playing' && room.gameId) {
      // stop the game and notify opponent
      const game = games[room.gameId];
      if (game) {
        // notify opponent
        game.players.forEach(pws => {
          if (pws !== ws) safeSend(pws, { type: 'opponent_left' });
        });
        stopGame(game, 'opponent_left');
      } else {
        // fallback
        room.status = 'empty';
        room.waitingClientId = null;
        room.gameId = null;
        room.players = [];
        broadcastLobbySnapshot(true);
      }
    }
  }
}

// ------------------ WEBSOCKET HANDLERS ------------------
wss.on('connection', ws => {
  // assign clientId
  ws.clientId = genId();
  ws._meta = { missedPongs: 0, lastPaddleTs: 0 };
  clients.set(ws.clientId, ws);
  console.log('client connected', ws.clientId);

  // send welcome + current lobby snapshot
  safeSend(ws, { type: 'assigned', clientId: ws.clientId });
  broadcastLobbySnapshot();

  ws.on('message', msgRaw => {
    let data;
    try { data = JSON.parse(msgRaw); } catch { return; }
    if (!data.type) return;

    switch (data.type) {
      case 'pong':
        ws._meta.missedPongs = 0;
        break;

      case 'join': // { type:'join', name: 'Ali' }
        ws.playerName = (typeof data.name === 'string' && data.name.trim()) ? data.name.trim() : ('P' + ws.clientId);
        safeSend(ws, { type: 'joined', clientId: ws.clientId, name: ws.playerName });
        broadcastLobbySnapshot(true);
        break;

      case 'requestRoom': // { roomId: 0 }
        {
          const roomId = Number(data.roomId);
          if (!Number.isFinite(roomId) || roomId < 0 || roomId >= CONFIG.ROOM_COUNT) {
            safeSend(ws, { type: 'error', message: 'invalid roomId' });
            break;
          }
          const room = rooms[roomId];
          if (room.status === 'empty') {
            // become waiting
            room.status = 'waiting';
            room.waitingClientId = ws.clientId;
            room.players = [ws.clientId];
            ws.roomId = roomId;
            safeSend(ws, { type: 'roomRequested', roomId });
            broadcastLobbySnapshot(true);
          } else if (room.status === 'waiting' && room.waitingClientId !== ws.clientId) {
            // another player joins waiting -> start game
            const otherId = room.waitingClientId;
            const otherWs = clients.get(otherId);
            if (!otherWs) {
              // waiting client disconnected, treat as empty
              room.status = 'empty'; room.waitingClientId = null; room.players = [];
              broadcastLobbySnapshot(true);
              break;
            }
            // create game between otherWs and ws
            createGame(roomId, otherWs, ws);
            broadcastLobbySnapshot(true);
          } else {
            // cannot join playing room or duplicate request
            safeSend(ws, { type: 'error', message: 'room not available' });
          }
        }
        break;

      case 'cancelRequest':
        {
          const roomId = ws.roomId;
          if (typeof roomId === 'number') {
            const room = rooms[roomId];
            if (room && room.status === 'waiting' && room.waitingClientId === ws.clientId) {
              room.status = 'empty';
              room.waitingClientId = null;
              room.players = [];
              delete ws.roomId;
              safeSend(ws, { type: 'requestCancelled', roomId });
              broadcastLobbySnapshot(true);
            }
          }
        }
        break;

      case 'paddle': // { x: 123.45 }
        {
          const nowTs = now();
          if (nowTs - ws._meta.lastPaddleTs < CONFIG.PADDLE_THROTTLE_MS) break;
          ws._meta.lastPaddleTs = nowTs;
          if (!ws.gameId) break;
          const game = games[ws.gameId];
          if (!game || !game.state) break;
          const idx = game.players.indexOf(ws);
          if (idx === -1) break;
          const x = Number(data.x);
          if (!Number.isFinite(x)) break;
          game.state.paddles[idx].x = clamp(x, 0, CONFIG.GAME_W - game.state.paddles[idx].w);
        }
        break;

      case 'rematchRequest':
        {
          if (!ws.gameId) break;
          const game = games[ws.gameId];
          if (!game) break;
          requestRematch(game, ws.clientId);
        }
        break;

      case 'leave':
        // explicit leave: if in waiting -> cancel, if in game -> stop and notify other
        {
          const rid = ws.roomId;
          if (typeof rid === 'number') {
            const room = rooms[rid];
            if (!room) break;
            if (room.status === 'waiting' && room.waitingClientId === ws.clientId) {
              room.status = 'empty'; room.waitingClientId = null; room.players = [];
              delete ws.roomId;
              broadcastLobbySnapshot(true);
            } else if (room.status === 'playing' && room.gameId) {
              const g = games[room.gameId];
              if (g) {
                g.players.forEach(pws => { if (pws.clientId !== ws.clientId) safeSend(pws, { type: 'opponent_left' }); });
                stopGame(g, 'left');
              }
            }
          }
        }
        break;

      default:
        safeSend(ws, { type: 'error', message: 'unknown message type' });
    }
  });

  ws.on('close', () => {
    clients.delete(ws.clientId);
    console.log('client disconnected', ws.clientId);
    handleDisconnectCleanup(ws);
  });

  ws.on('error', (e) => {
    console.warn('ws error', e && e.message);
    clients.delete(ws.clientId);
    handleDisconnectCleanup(ws);
  });
});

console.log('PingPong server running on port', PORT);
