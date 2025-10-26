// server.js
'use strict';

const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const GAME_W = 450;
const GAME_H = 800;
const TICK_HZ = 50;
const MAX_SPEED = 10;
const BASE_BALL_SPEED = 8;
const HEARTBEAT_MS = 10000;
const MAX_MISSED_PONG = 3;

console.log('WebSocket server running on port', PORT);

// server state
let players = [null, null]; // max 2 players for now
let waitingPlayerId = null;
let seq = 0;

// store multiple games
let games = {}; // gameId -> { players: [ws1, ws2], state, loop }

// --- helper functions ---
function generateGameId() {
  return Math.random().toString(36).substr(2, 9);
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!obj.meta) obj.meta = {};
  obj.meta.seq = ++seq;
  obj.meta.ts = Date.now();
  ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const payload = JSON.stringify(Object.assign({}, obj, { meta: { seq: ++seq, ts: Date.now() } }));
  players.forEach(p => { if (p && p.readyState === WebSocket.OPEN) p.send(payload); });
}

// create a new game
function createGame(player1, player2) {
  const gameId = generateGameId();
  const state = {
    ball: { x: GAME_W / 2, y: GAME_H / 2, vx: BASE_BALL_SPEED, vy: BASE_BALL_SPEED, r: 15 },
    paddles: [
      { x: GAME_W / 2 - 50, y: 20, w: 100, h: 20 },
      { x: GAME_W / 2 - 50, y: GAME_H - 50, w: 100, h: 20 }
    ],
    scores: [0, 0]
  };
  games[gameId] = { players: [player1, player2], state, loop: null };
  return gameId;
}

// reset ball
function resetBall(state, towardsPlayer = 1) {
  state.ball.x = GAME_W / 2;
  state.ball.y = GAME_H / 2;
  const ang = (Math.random() * Math.PI / 3) - (Math.PI / 6);
  const dir = (towardsPlayer === 1) ? 1 : -1;
  state.ball.vx = BASE_BALL_SPEED * Math.sin(ang);
  state.ball.vy = dir * BASE_BALL_SPEED * Math.cos(ang);
}

// broadcast game state
function broadcastGameState(game) {
  const state = game.state;
  const payload = {
    type: 'state',
    state: {
      ball: { x: +state.ball.x.toFixed(2), y: +state.ball.y.toFixed(2), r: state.ball.r },
      paddles: state.paddles.map(p => ({ x: +p.x.toFixed(2), y: p.y, w: p.w, h: p.h })),
      scores: state.scores
    },
    meta: { ts: Date.now() }
  };
  game.players.forEach(ws => send(ws, payload));
}

// game loop per game
function gameLoop(game) {
  const state = game.state;
  const b = state.ball;

  // move ball
  b.x += b.vx;
  b.y += b.vy;

  // wall collisions
  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
  if (b.x + b.r > GAME_W) { b.x = GAME_W - b.r; b.vx = -Math.abs(b.vx); }

  // paddle collisions
  for (let i = 0; i < 2; i++) {
    const p = state.paddles[i];
    if (b.y + b.r > p.y && b.y - b.r < p.y + p.h &&
        b.x + b.r > p.x && b.x - b.r < p.x + p.w) {
      const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
      const speed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
      b.vy = -b.vy;
      b.vx = offset * Math.max(1.2, speed);

      const cur = Math.sqrt(b.vx ** 2 + b.vy ** 2);
      if (cur > MAX_SPEED) { const f = MAX_SPEED / cur; b.vx *= f; b.vy *= f; }

      if (i === 0) b.y = p.y + p.h + b.r + 0.1;
      else b.y = p.y - b.r - 0.1;
    }
  }

  // scoring
  const SAFE_MARGIN = 10;
  if (b.y < -SAFE_MARGIN) { 
    state.scores[1]++; 
    resetBall(state, 0);
  }
  if (b.y > GAME_H + SAFE_MARGIN) { 
    state.scores[0]++; 
    resetBall(state, 1);
  }

  broadcastGameState(game);
}

// heartbeat
setInterval(() => {
  players.forEach((p, idx) => {
    if (!p) return;
    try {
      p._meta.missedPongs = (p._meta.missedPongs || 0) + 1;
      if (p._meta.missedPongs > MAX_MISSED_PONG) {
        p.terminate();
        players[idx] = null;
        if (waitingPlayerId === idx) waitingPlayerId = null;
        // remove any game the player is in
        for (const gid in games) {
          const g = games[gid];
          if (g.players.includes(p)) {
            clearInterval(g.loop);
            g.players.forEach(ws => { if (ws !== p) send(ws, { type: 'declined' }); });
            delete games[gid];
          }
        }
        return;
      }
      p.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch(e) {}
  });
}, HEARTBEAT_MS);

// handle connections
wss.on('connection', ws => {
  const slot = players.findIndex(p => p === null);
  if (slot === -1) { ws.send(JSON.stringify({ type: 'full' })); ws.close(); return; }

  ws.playerId = slot;
  ws._meta = { missedPongs: 0, lastPaddleTs: 0 };
  players[slot] = ws;

  send(ws, { type: 'assign', playerId: slot });

  if (waitingPlayerId === null) send(ws, { type: 'lobby', status: 'no_waiting' });
  else if (waitingPlayerId === slot) send(ws, { type: 'lobby', status: 'waiting_for_opponent' });
  else send(ws, { type: 'lobby', status: 'someone_waiting' });

  ws.on('message', msgRaw => {
    let data; try { data = JSON.parse(msgRaw); } catch { return; }
    if (!data.type) return;

    switch(data.type) {
      case 'pong':
        ws._meta.missedPongs = 0;
        break;

      case 'waitForPlayer':
        if (waitingPlayerId === null) {
          waitingPlayerId = ws.playerId;
          send(ws, { type: 'lobby', status: 'waiting_for_opponent' });
          players.forEach((p, idx) => {
            if (p && idx !== waitingPlayerId) send(p, { type: 'lobby', status: 'someone_waiting' });
          });
        } else {
          send(ws, { type: 'lobby', status: 'someone_waiting' });
        }
        break;

      case 'cancelWait':
        if (waitingPlayerId === ws.playerId) {
          waitingPlayerId = null;
          players.forEach(p => { if (p) send(p, { type: 'lobby', status: 'no_waiting' }); });
        }
        break;

      case 'acceptMatch':
        if (waitingPlayerId !== null && ws.playerId !== waitingPlayerId) {
          const a = waitingPlayerId;
          const b = ws.playerId;
          if (players[a] && players[b]) {
            waitingPlayerId = null;
            const gameId = createGame(players[a], players[b]);
            const game = games[gameId];
            game.loop = setInterval(() => gameLoop(game), 1000 / TICK_HZ);
            broadcast({ type: 'start' });
            broadcastGameState(game);
          }
        }
        break;

      case 'paddle':
        const now = Date.now();
        if (now - ws._meta.lastPaddleTs < 20) return;
        ws._meta.lastPaddleTs = now;
        const x = Number(data.x);
        if (!Number.isFinite(x)) return;

        // update paddle in its game
        for (const gid in games) {
          const game = games[gid];
          const idx = game.players.indexOf(ws);
          if (idx !== -1) {
            game.state.paddles[idx].x = Math.max(0, Math.min(GAME_W - game.state.paddles[idx].w, x));
          }
        }
        break;
    }
  });

  ws.on('close', () => {
    const id = ws.playerId;
    if (typeof id === 'number') {
      players[id] = null;
      if (waitingPlayerId === id) waitingPlayerId = null;

      for (const gid in games) {
        const g = games[gid];
        if (g.players.includes(ws)) {
          clearInterval(g.loop);
          g.players.forEach(p => { if (p !== ws) send(p, { type: 'declined' }); });
          delete games[gid];
        }
      }

      players.forEach(p => { if (p) send(p, { type: 'lobby', status: 'no_waiting' }); });
    }
  });

  ws.on('error', () => {});
});
