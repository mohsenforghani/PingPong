// server.js
'use strict';

/**
 * PingPong authoritative server
 * - 10 rooms (index 0..9)
 * - Lobby snapshot push
 * - Full server-side physics & authoritative state
 * - Rematch flow, request/cancel, join room, heartbeat
 *
 * Protocol (incoming messages from client):
 * - {type:'join', name: string}               -- player sets their name after connect
 * - {type:'requestRoom', roomId: number}      -- request to occupy empty room (become waiting)
 * - {type:'cancelRequest', roomId: number}    -- cancel waiting
 * - {type:'joinRoom', roomId: number}         -- join a waiting room (become player 2)
 * - {type:'paddle', x: number}                -- paddle position (logical x)
 * - {type:'rematchRequest', roomId: number}   -- ask opponent for rematch
 * - {type:'rematchAccept', roomId: number}    -- accept rematch
 * - {type:'leave', roomId: number}            -- leave room / quit
 * - {type:'check'} or {type:'requestLobby'}   -- optional lobby request
 * - ping/pong handled for heartbeat
 *
 * Outgoing server messages (examples):
 * - assign, joined, lobbySnapshot, roomRequested, requestCancelled, start, state,
 *   gameover, rematchRequested, rematchAccepted, opponent_left, stopped, error, ping
 *
 * Usage: node server.js
 */

/* ---------- CONFIG (separate section) ---------- */
const CONFIG = {
  PORT: process.env.PORT || 8080,
  GAME_W: 450,
  GAME_H: 800,
  TICK_HZ: 60,            // physics ticks per second
  SEND_RATE: 20,          // updates per second sent to clients
  WIN_SCORE: 20,          // score to win (game over)
  HEARTBEAT_MS: 10000,
  MAX_MISSED_PONG: 3,
  MAX_ROOMS: 10,
  MAX_STATE_BUFFER: 20,   // client-side use if needed
  PADDLE_THROTTLE_MS: 20, // server-side throttle on updates from a client
  MAX_SPEED: 12,          // cap ball speed (logical units per tick)
  BASE_BALL_SPEED: 8,
  SAFE_MARGIN: 12,        // margin before considering a score
  ROOM_BROADCAST_INTERVAL: 10000 // send lobby snapshot every 10s
};

/* ---------- LIBS & SERVER SETUP ---------- */
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: CONFIG.PORT });
console.log(`PingPong server listening on port ${CONFIG.PORT}`);

/* ---------- STATE ---------- */
let seq = 0; // global sequence for meta
let nextClientId = 1;

/**
 * rooms: array length MAX_ROOMS
 * each room:
 * {
 *   id: number,
 *   status: 'empty' | 'waiting' | 'playing',
 *   waitingPlayer: ws|null,    // if waiting
 *   players: [ws|null, ws|null],
 *   names: [string|null, string|null],
 *   scores: [0,0],
 *   state: { ball: {...}, paddles: [...], scores: [...] }  // authoritative during playing
 *   loop: intervalRef|null
 *   rematchRequests: Set of clientIds that requested rematch
 * }
 */
const rooms = new Array(CONFIG.MAX_ROOMS).fill(null).map((_, i) => ({
  id: i,
  status: 'empty',
  waitingPlayer: null,
  players: [null, null],
  names: [null, null],
  scores: [0, 0],
  state: null,
  loop: null,
  sendCounter: 0,
  rematchRequests: new Set()
}));

/* ---------- HELPERS ---------- */
function now() { return Date.now(); }

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!obj.meta) obj.meta = {};
  obj.meta.seq = ++seq;
  obj.meta.ts = now();
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

function broadcastAll(obj) {
  wss.clients.forEach(c => safeSend(c, obj));
}

function roomSnapshot(room) {
  // produce minimal info for lobby view
  if (!room) return null;
  if (room.status === 'empty') return { roomId: room.id, status: 'empty' };
  if (room.status === 'waiting') return {
    roomId: room.id,
    status: 'waiting',
    waitingName: (room.waitingPlayer && room.waitingPlayer.playerName) ? room.waitingPlayer.playerName : null
  };
  // playing
  return {
    roomId: room.id,
    status: 'playing',
    players: [
      { name: room.names[0] || null, score: room.scores[0] },
      { name: room.names[1] || null, score: room.scores[1] }
    ]
  };
}

function broadcastLobbySnapshot() {
  const snap = rooms.map(r => roomSnapshot(r));
  broadcastAll({ type: 'lobbySnapshot', rooms: snap });
}

/* ---------- BALL / GAME UTIL ---------- */
function makeInitialState() {
  const ang = (Math.random() * Math.PI / 3) - (Math.PI / 6);
  const dir = Math.random() < 0.5 ? 1 : -1;
  const vx = CONFIG.BASE_BALL_SPEED * Math.sin(ang);
  const vy = dir * CONFIG.BASE_BALL_SPEED * Math.cos(ang);
  return {
    ball: { x: CONFIG.GAME_W / 2, y: CONFIG.GAME_H / 2, vx, vy, r: 12 },
    paddles: [
      { x: CONFIG.GAME_W / 2 - 50, y: 20, w: 100, h: 20 },
      { x: CONFIG.GAME_W / 2 - 50, y: CONFIG.GAME_H - 50, w: 100, h: 20 }
    ],
    scores: [0, 0]
  };
}

function resetBall(state, towardsPlayer = 1) {
  state.ball.x = CONFIG.GAME_W / 2;
  state.ball.y = CONFIG.GAME_H / 2;
  const ang = (Math.random() * Math.PI / 3) - (Math.PI / 6);
  const dir = (towardsPlayer === 1) ? 1 : -1;
  state.ball.vx = CONFIG.BASE_BALL_SPEED * Math.sin(ang);
  state.ball.vy = dir * CONFIG.BASE_BALL_SPEED * Math.cos(ang);
}

/* ---------- GAME LOOP (authoritative) ---------- */
function startRoomGame(room) {
  if (!room) return;
  if (room.loop) clearInterval(room.loop);

  // ensure state exists
  room.state = room.state || makeInitialState();
  room.sendCounter = 0;
  room.rematchRequests.clear();

  // ticks at TICK_HZ
  room.loop = setInterval(() => {
    const s = room.state;
    const b = s.ball;

    // move ball
    b.x += b.vx;
    b.y += b.vy;

    // wall collisions
    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
    if (b.x + b.r > CONFIG.GAME_W) { b.x = CONFIG.GAME_W - b.r; b.vx = -Math.abs(b.vx); }

    // paddle collisions (both players)
    for (let i = 0; i < 2; i++) {
      const p = s.paddles[i];
      // robust AABB+circle check
      const hit = (b.y + b.r > p.y) && (b.y - b.r < p.y + p.h) &&
                  (b.x + b.r > p.x) && (b.x - b.r < p.x + p.w);
      if (hit) {
        // angle by offset
        const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
        const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || CONFIG.BASE_BALL_SPEED;
        // flip vertical
        b.vy = -b.vy;
        b.vx = offset * Math.max(1.2, speed * 0.9);
        // clamp
        let cur = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (cur > CONFIG.MAX_SPEED) {
          const f = CONFIG.MAX_SPEED / cur;
          b.vx *= f; b.vy *= f;
        }
        // nudge out of paddle to avoid stuck
        if (i === 0) b.y = p.y + p.h + b.r + 0.01;
        else b.y = p.y - b.r - 0.01;
      }
    }

    // scoring
    if (b.y < -CONFIG.SAFE_MARGIN) {
      // bottom player scores
      room.scores[1] += 1;
      room.state.scores = [...room.scores];
      // check game over
      if (room.scores[1] >= CONFIG.WIN_SCORE) {
        endRoomGame(room, 1);
        return;
      } else {
        resetBall(room.state, 0);
      }
    } else if (b.y > CONFIG.GAME_H + CONFIG.SAFE_MARGIN) {
      room.scores[0] += 1;
      room.state.scores = [...room.scores];
      if (room.scores[0] >= CONFIG.WIN_SCORE) {
        endRoomGame(room, 0);
        return;
      } else {
        resetBall(room.state, 1);
      }
    }

    // send updates at SEND_RATE frequency
    room.sendCounter++;
    const SEND_EVERY = Math.max(1, Math.round(CONFIG.TICK_HZ / CONFIG.SEND_RATE));
    if (room.sendCounter % SEND_EVERY === 0) {
      const payload = {
        type: 'state',
        state: {
          ball: { x: +s.ball.x.toFixed(2), y: +s.ball.y.toFixed(2), r: s.ball.r },
          paddles: s.paddles.map(p => ({ x: +p.x.toFixed(2), y: p.y, w: p.w, h: p.h })),
          scores: room.scores
        }
      };
      // send to both players
      room.players.forEach(ws => safeSend(ws, payload));
    }
  }, 1000 / CONFIG.TICK_HZ);
}

function endRoomGame(room, winnerIndex) {
  // stop loop
  if (room.loop) { clearInterval(room.loop); room.loop = null; }
  // status -> playing ended but keep room as occupied (we'll await rematch or leave)
  room.status = 'playing'; // still playing state — UI will interpret if loop stopped maybe show finished
  // send gameover to both
  const payload = { type: 'gameover', winner: winnerIndex, scores: room.scores };
  room.players.forEach(ws => safeSend(ws, payload));
  // mark game state still present so rematch can restart without rejoin
}

/* ---------- LOBBY / ROOM MANAGEMENT ---------- */
function handleRequestRoom(ws, data) {
  const roomId = Number(data.roomId);
  if (!Number.isInteger(roomId) || roomId < 0 || roomId >= CONFIG.MAX_ROOMS) {
    safeSend(ws, { type: 'error', message: 'roomId invalid' });
    return;
  }
  const room = rooms[roomId];
  // only allow request if empty
  if (room.status !== 'empty') {
    safeSend(ws, { type: 'error', message: 'room not empty' });
    return;
  }
  // set waiting
  room.status = 'waiting';
  room.waitingPlayer = ws;
  room.names[0] = ws.playerName || `Player${ws.clientId}`;
  room.players[0] = ws; // reserve slot 0 for waiting
  safeSend(ws, { type: 'roomRequested', roomId });
  broadcastLobbySnapshot();
}

function handleCancelRequest(ws, data) {
  const roomId = Number(data.roomId);
  if (!Number.isInteger(roomId) || roomId < 0 || roomId >= CONFIG.MAX_ROOMS) return;
  const room = rooms[roomId];
  if (room.status === 'waiting' && room.waitingPlayer === ws) {
    room.status = 'empty';
    room.waitingPlayer = null;
    room.players[0] = null;
    room.names[0] = null;
    safeSend(ws, { type: 'requestCancelled', roomId });
    broadcastLobbySnapshot();
  } else {
    safeSend(ws, { type: 'error', message: 'cannot cancel request' });
  }
}

function handleJoinRoom(ws, data) {
  const roomId = Number(data.roomId);
  if (!Number.isInteger(roomId) || roomId < 0 || roomId >= CONFIG.MAX_ROOMS) {
    safeSend(ws, { type: 'error', message: 'roomId invalid' });
    return;
  }
  const room = rooms[roomId];
  if (room.status !== 'waiting' || !room.waitingPlayer) {
    safeSend(ws, { type: 'error', message: 'room not waiting' });
    return;
  }
  // assign as player 1 (index 1)
  room.players[1] = ws;
  room.names[1] = ws.playerName || `Player${ws.clientId}`;
  room.status = 'playing';
  room.scores = [0, 0];
  // initial state
  room.state = makeInitialState();
  room.state.paddles[0].x = room.players[0] ? room.players[0].lastPaddleX || room.state.paddles[0].x : room.state.paddles[0].x;
  room.state.paddles[1].x = room.players[1] ? room.players[1].lastPaddleX || room.state.paddles[1].x : room.state.paddles[1].x;

  // mark player indices on ws for message handling
  room.players.forEach((pws, idx) => { if (pws) { pws.currentRoom = roomId; pws.playerIndex = idx; } });

  // start game loop
  startRoomGame(room);

  // notify both players
  safeSend(room.players[0], { type: 'start', playerIndex: 0, roomId });
  safeSend(room.players[1], { type: 'start', playerIndex: 1, roomId });

  broadcastLobbySnapshot();
}

function handleLeave(ws, data) {
  const roomId = Number(data.roomId);
  if (!Number.isInteger(roomId) || roomId < 0 || roomId >= CONFIG.MAX_ROOMS) return;
  const room = rooms[roomId];
  // if playing, notify opponent and stop game
  if (room.players.includes(ws)) {
    // mark opponent
    const opponentIdx = room.players.indexOf(ws) === 0 ? 1 : 0;
    const opp = room.players[opponentIdx];
    if (opp) safeSend(opp, { type: 'opponent_left' });
    // cleanup
    if (room.loop) { clearInterval(room.loop); room.loop = null; }
    room.status = 'empty';
    room.players = [null, null];
    room.names = [null, null];
    room.scores = [0, 0];
    room.state = null;
    room.waitingPlayer = null;
    room.rematchRequests.clear();
    broadcastLobbySnapshot();
  } else if (room.waitingPlayer === ws) {
    // cancel waiting
    room.status = 'empty';
    room.waitingPlayer = null;
    room.players[0] = null;
    room.names[0] = null;
    safeSend(ws, { type: 'requestCancelled', roomId });
    broadcastLobbySnapshot();
  }
}

/* ---------- REMATCH FLOW ---------- */
function handleRematchRequest(ws, data) {
  const roomId = Number(data.roomId);
  if (!Number.isInteger(roomId) || roomId < 0 || roomId >= CONFIG.MAX_ROOMS) return;
  const room = rooms[roomId];
  if (!room) return;
  // only players in room can request
  const idx = room.players.indexOf(ws);
  if (idx === -1) { safeSend(ws, { type: 'error', message: 'not in room' }); return; }
  // notify opponent
  const oppIdx = idx === 0 ? 1 : 0;
  const opp = room.players[oppIdx];
  if (!opp) { safeSend(ws, { type: 'error', message: 'no opponent' }); return; }
  room.rematchRequests.add(ws.clientId);
  safeSend(opp, { type: 'rematchRequested' });
  safeSend(ws, { type: 'rematchRequested' }); // ack to requester
}

function handleRematchAccept(ws, data) {
  const roomId = Number(data.roomId);
  if (!Number.isInteger(roomId) || roomId < 0 || roomId >= CONFIG.MAX_ROOMS) return;
  const room = rooms[roomId];
  if (!room) return;
  const idx = room.players.indexOf(ws);
  if (idx === -1) { safeSend(ws, { type: 'error', message: 'not in room' }); return; }
  room.rematchRequests.add(ws.clientId);
  // if both requested -> restart game
  const bothRequested = room.players.every(p => p && room.rematchRequests.has(p.clientId));
  if (bothRequested) {
    room.rematchRequests.clear();
    // reset scores and state and start again
    room.scores = [0, 0];
    room.state = makeInitialState();
    // start loop
    startRoomGame(room);
    // notify both
    room.players.forEach((p, idx) => safeSend(p, { type: 'rematchAccepted' }));
    // let them know game started
    room.players.forEach((p, idx) => safeSend(p, { type: 'start', playerIndex: idx, roomId }));
    broadcastLobbySnapshot();
  } else {
    // notify opponent that this player accepted (so they can accept)
    const opp = room.players[idx === 0 ? 1 : 0];
    if (opp) safeSend(opp, { type: 'rematchRequested' });
  }
}

/* ---------- CONNECTION HANDLING ---------- */
function onConnection(ws) {
  ws.clientId = nextClientId++;
  ws.playerName = null;
  ws.lastPaddleTs = 0;
  ws.lastPaddleX = null;
  ws.currentRoom = null;
  ws.playerIndex = null;
  ws._meta = { missedPongs: 0 };

  safeSend(ws, { type: 'assign', clientId: ws.clientId });

  // send initial lobby snapshot
  safeSend(ws, { type: 'lobbySnapshot', rooms: rooms.map(r => roomSnapshot(r)) });

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) {
      safeSend(ws, { type: 'error', message: 'invalid json' });
      return;
    }
    if (!data || typeof data.type !== 'string') {
      safeSend(ws, { type: 'error', message: 'missing type' });
      return;
    }
    const t = data.type;

    switch (t) {
      case 'pong':
        ws._meta.missedPongs = 0;
        break;

      case 'join':
        // save player name
        const name = (typeof data.name === 'string' && data.name.trim()) ? data.name.trim().slice(0,24) : `P${ws.clientId}`;
        ws.playerName = name;
        safeSend(ws, { type: 'joined', name });
        // broadcast lobby snapshot to include new player's name possibly
        broadcastLobbySnapshot();
        break;

      case 'requestRoom':
      case 'waitForPlayer':
        handleRequestRoom(ws, data);
        break;

      case 'cancelRequest':
      case 'cancelWait':
        handleCancelRequest(ws, data);
        break;

      case 'joinRoom':
      case 'acceptMatch':
        handleJoinRoom(ws, data);
        break;

      case 'leave':
        handleLeave(ws, data);
        break;

      case 'paddle':
        // validate paddle x and throttle
        const nowTs = now();
        if (nowTs - ws.lastPaddleTs < CONFIG.PADDLE_THROTTLE_MS) return;
        ws.lastPaddleTs = nowTs;
        const px = Number(data.x);
        if (!Number.isFinite(px)) return;
        ws.lastPaddleX = Math.max(0, Math.min(CONFIG.GAME_W - 100, px));
        // update server authoritative paddle for player's room if playing
        if (typeof ws.currentRoom === 'number') {
          const r = rooms[ws.currentRoom];
          const idx = ws.playerIndex;
          if (r && r.state && idx !== null && idx !== -1) {
            r.state.paddles[idx].x = ws.lastPaddleX;
            // also clamp
            r.state.paddles[idx].x = Math.max(0, Math.min(CONFIG.GAME_W - r.state.paddles[idx].w, r.state.paddles[idx].x));
          }
        }
        break;

      case 'rematchRequest':
      case 'requestRematch':
        handleRematchRequest(ws, data);
        break;

      case 'rematchAccept':
      case 'rematchAcceptAck':
      case 'rematchAccept':
        handleRematchAccept(ws, data);
        break;

      case 'check':
      case 'requestLobby':
        safeSend(ws, { type: 'lobbySnapshot', rooms: rooms.map(r => roomSnapshot(r)) });
        break;

      default:
        safeSend(ws, { type: 'error', message: `unknown message: ${t}` });
    }
  });

  ws.on('close', () => {
    // clean up: if in a room remove them
    // remove from any rooms waiting or playing
    rooms.forEach(room => {
      if (room.waitingPlayer === ws) {
        room.waitingPlayer = null;
        room.status = 'empty';
        room.players[0] = null;
        room.names[0] = null;
      }
      if (room.players.includes(ws)) {
        const idx = room.players.indexOf(ws);
        const oppIdx = idx === 0 ? 1 : 0;
        const opp = room.players[oppIdx];
        // notify opponent
        if (opp) safeSend(opp, { type: 'opponent_left' });
        // stop game loop and clear room
        if (room.loop) { clearInterval(room.loop); room.loop = null; }
        room.status = 'empty';
        room.players = [null, null];
        room.names = [null, null];
        room.scores = [0,0];
        room.state = null;
        room.waitingPlayer = null;
        room.rematchRequests.clear();
      }
    });
    broadcastLobbySnapshot();
  });

  ws.on('error', () => {
    // ignore (client errors handled by 'close')
  });

  // send periodic ping to client via heartbeat loop (global)
}

/* ---------- HEARTBEAT (global) ---------- */
setInterval(() => {
  wss.clients.forEach((c) => {
    try {
      c._meta.missedPongs = (c._meta.missedPongs || 0) + 1;
      if (c._meta.missedPongs > CONFIG.MAX_MISSED_PONG) {
        c.terminate();
        return;
      }
      safeSend(c, { type: 'ping', ts: now() });
    } catch (e) {}
  });
}, CONFIG.HEARTBEAT_MS);

/* ---------- PERIODIC LOBBY SNAPSHOT BROADCAST ---------- */
setInterval(() => {
  broadcastLobbySnapshot();
}, CONFIG.ROOM_BROADCAST_INTERVAL);

/* ---------- START LISTENING ---------- */
wss.on('connection', onConnection);
