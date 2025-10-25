// server.js
// Node 18+
// npm i ws
'use strict';

const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// Game constants
const GAME_W = 450;
const GAME_H = 800;
const TICK_HZ = 60;               // internal physics tick
const SEND_RATE = 20;             // send ~20 updates/sec to clients
const SEND_EVERY = Math.max(1, Math.round(TICK_HZ / SEND_RATE));
const MAX_SPEED = 8;
const BASE_BALL_SPEED = 4.5;
const HEARTBEAT_MS = 10000;       // server ping interval
const MAX_MISSED_PONG = 3;

// minimal logging
console.log('WebSocket server starting on port', PORT);

// server state
let players = [null, null];       // [ws, ws] or null
let waitingPlayerId = null;       // playerId who pressed "want to play"
let gameStarted = false;
let seq = 0;                      // monotonic sequence for state messages

const state = {
  ball: { x: GAME_W / 2, y: GAME_H / 2, vx: BASE_BALL_SPEED, vy: BASE_BALL_SPEED, r: 10 },
  paddles: [
    { x: GAME_W / 2 - 50, y: 10, w: 100, h: 20 },
    { x: GAME_W / 2 - 50, y: GAME_H - 30, w: 100, h: 20 }
  ],
  scores: [0, 0]
};

// helper: reset ball in center with random angle
function resetBall() {
  state.ball.x = GAME_W / 2;
  state.ball.y = GAME_H / 2;
  const ang = (Math.random() * Math.PI / 3) - (Math.PI / 6); // -30..+30 deg
  const dir = Math.random() < 0.5 ? 1 : -1;
  state.ball.vx = BASE_BALL_SPEED * Math.sin(ang);
  state.ball.vy = dir * BASE_BALL_SPEED * Math.cos(ang);
}

// helper: send JSON (small) with sequence & timestamp
function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // attach metadata where relevant
  if (!obj.meta) obj.meta = {};
  obj.meta.seq = ++seq;
  obj.meta.ts = Date.now();
  ws.send(JSON.stringify(obj));
}

// broadcast to all connected players
function broadcast(obj) {
  const payload = JSON.stringify(Object.assign({}, obj, { meta: { seq: ++seq, ts: Date.now() } }));
  players.forEach(p => {
    if (p && p.readyState === WebSocket.OPEN) p.send(payload);
  });
}

// basic rate limiter per connection for paddle messages
function makeConnectionState(ws) {
  return {
    ws,
    lastPaddleTs: 0,
    missedPongs: 0,
    isAlive: true
  };
}

// game loop (physics)
let tickCount = 0;
function tick() {
  if (!gameStarted) return;

  const b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // wall collisions (left/right)
  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
  if (b.x + b.r > GAME_W) { b.x = GAME_W - b.r; b.vx = -Math.abs(b.vx); }

  // paddle collisions
  for (let i = 0; i < 2; i++) {
    const p = state.paddles[i];
    if (b.y + b.r > p.y && b.y - b.r < p.y + p.h &&
        b.x + b.r > p.x && b.x - b.r < p.x + p.w) {

      // compute offset relative to paddle center (-1..1)
      const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      // flip vertical direction
      b.vy = -b.vy;
      // tweak vx based on offset
      b.vx = offset * Math.max(1.5, speed);

      // clamp speed
      const cur = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (cur > MAX_SPEED) {
        const f = MAX_SPEED / cur;
        b.vx *= f; b.vy *= f;
      }
      // nudge ball out of paddle to avoid sticking
      if (i === 0) b.y = p.y + p.h + b.r + 0.1;
      else b.y = p.y - b.r - 0.1;
    }
  }

  // score
  if (b.y < 0) { state.scores[1]++; resetBall(); }
  if (b.y > GAME_H) { state.scores[0]++; resetBall(); }

  // send state every SEND_EVERY ticks
  if (++tickCount % SEND_EVERY === 0) {
    // send minimal / delta structure
    broadcast({
      type: 'state',
      state: {
        ball: { x: +state.ball.x.toFixed(2), y: +state.ball.y.toFixed(2), r: state.ball.r },
        paddles: [
          { x: +state.paddles[0].x.toFixed(2), y: state.paddles[0].y, w: state.paddles[0].w, h: state.paddles[0].h },
          { x: +state.paddles[1].x.toFixed(2), y: state.paddles[1].y, w: state.paddles[1].w, h: state.paddles[1].h }
        ],
        scores: state.scores
      }
    });
  }
}
setInterval(tick, 1000 / TICK_HZ);

// heartbeat (server pings clients)
setInterval(()=> {
  players.forEach((pConn, idx) => {
    if (!pConn) return;
    try {
      if (pConn._meta) {
        pConn._meta.missedPongs = (pConn._meta.missedPongs || 0) + 1;
        if (pConn._meta.missedPongs > MAX_MISSED_PONG) {
          // assume dead
          pConn.terminate();
          players[idx] = null;
          if (waitingPlayerId === idx) waitingPlayerId = null;
          gameStarted = false;
          return;
        }
      }
      // send ping as JSON small
      pConn.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch (e) {
      // ignore send errors
    }
  });
}, HEARTBEAT_MS);

// connection handling
wss.on('connection', (ws) => {
  // find first free slot
  const slot = players.findIndex(p => p === null);
  if (slot === -1) {
    // full
    try { ws.send(JSON.stringify({ type: 'full' })); } catch (e) {}
    ws.close();
    return;
  }

  // attach metadata
  ws._meta = { missedPongs: 0, lastPaddleTs: 0 };
  players[slot] = ws;
  ws.playerId = slot;

  // send assignment
  send(ws, { type: 'assign', playerId: slot });

  // send lobby status to this client
  if (waitingPlayerId === null) {
    send(ws, { type: 'lobby', status: 'no_waiting' });
  } else if (waitingPlayerId === slot) {
    send(ws, { type: 'lobby', status: 'waiting_for_opponent' });
  } else {
    send(ws, { type: 'lobby', status: 'someone_waiting' });
  }

  // message handler
  ws.on('message', (msgRaw) => {
    // parse JSON safely
    let data;
    try { data = JSON.parse(msgRaw); } catch (e) { return; }

    // minimal validation: type must exist
    if (!data.type) return;

    switch (data.type) {

      // client responds to server ping
      case 'pong':
        ws._meta.missedPongs = 0;
        break;

      // client asks "I want to play" -> become waiter
      case 'waitForPlayer':
        if (waitingPlayerId === null) {
          waitingPlayerId = ws.playerId;
          // inform waiter and others
          send(ws, { type: 'lobby', status: 'waiting_for_opponent' });
          players.forEach((p, idx) => {
            if (p && p.readyState === WebSocket.OPEN && idx !== waitingPlayerId)
              send(p, { type: 'lobby', status: 'someone_waiting' });
          });
        } else {
          // someone already waiting
          send(ws, { type: 'lobby', status: 'someone_waiting' });
        }
        break;

      // client cancels wait
      case 'cancelWait':
        if (waitingPlayerId === ws.playerId) {
          waitingPlayerId = null;
          players.forEach((p) => {
            if (p && p.readyState === WebSocket.OPEN)
              send(p, { type: 'lobby', status: 'no_waiting' });
          });
        }
        break;

      // second player accepts match -> start
      case 'acceptMatch':
        if (waitingPlayerId !== null && ws.playerId !== waitingPlayerId) {
          // ensure both connected
          const a = waitingPlayerId;
          const b = ws.playerId;
          if (players[a] && players[b] && players[a].readyState === WebSocket.OPEN && players[b].readyState === WebSocket.OPEN) {
            gameStarted = true;
            waitingPlayerId = null;
            resetBall();
            broadcast({ type: 'start' });
            // immediate state
            broadcast({ type: 'state', state: {
              ball: { x: state.ball.x, y: state.ball.y, r: state.ball.r },
              paddles: state.paddles,
              scores: state.scores
            }});
          } else {
            send(ws, { type: 'error', msg: 'player disconnected' });
          }
        }
        break;

      // paddle update from client (server authoritative: use ws.playerId)
      case 'paddle':
        // throttle: at most 30Hz updates accepted
        {
          const now = Date.now();
          const last = ws._meta.lastPaddleTs || 0;
          if (now - last < 20) return; // ignore rapid updates (<20ms)
          ws._meta.lastPaddleTs = now;

          const x = Number(data.x);
          if (Number.isFinite(x)) {
            // clamp
            const pid = ws.playerId;
            if (typeof pid === 'number' && pid >= 0 && pid <= 1) {
              const maxLeft = GAME_W - state.paddles[pid].w;
              const clamped = Math.max(0, Math.min(maxLeft, x));
              state.paddles[pid].x = clamped;
            }
          }
        }
        break;

      default:
        // unknown message type - ignore or log
        break;
    }
  });

  ws.on('close', () => {
    const id = ws.playerId;
    if (typeof id === 'number') {
      players[id] = null;
      if (waitingPlayerId === id) {
        waitingPlayerId = null;
        // inform others
        players.forEach(p => { if (p && p.readyState === WebSocket.OPEN) send(p, { type: 'lobby', status: 'no_waiting' }); });
      }
      gameStarted = false;
    }
  });

  ws.on('error', () => {
    // ignore - connection-level errors
  });
});
