// server.js
'use strict';

const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const GAME_W = 450;
const GAME_H = 800;
const TICK_HZ =   80;
const SEND_RATE = 20;
const SEND_EVERY = Math.max(1, Math.round(TICK_HZ / SEND_RATE));
const MAX_SPEED = 8;
const BASE_BALL_SPEED = 12;
const HEARTBEAT_MS = 10000;
const MAX_MISSED_PONG = 3;

console.log('WebSocket server running on port', PORT);

// server state
let players = [null, null];   // [ws, ws]
let waitingPlayerId = null;
let gameStarted = false;
let seq = 0;

const state = {
  ball: { x: GAME_W / 2, y: GAME_H / 2, vx: BASE_BALL_SPEED, vy: BASE_BALL_SPEED, r: 15 },
  paddles: [
    { x: GAME_W / 2 - 50, y: 20, w: 100, h: 20 },
    { x: GAME_W / 2 - 50, y: GAME_H - 50, w: 100, h: 20 }
  ],
  scores: [0, 0]
};


// send JSON with meta
function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!obj.meta) obj.meta = {};
  obj.meta.seq = ++seq;
  obj.meta.ts = Date.now();
  ws.send(JSON.stringify(obj));
}

// broadcast
function broadcast(obj) {
  const payload = JSON.stringify(Object.assign({}, obj, { meta: { seq: ++seq, ts: Date.now() } }));
  players.forEach(p => { if (p && p.readyState === WebSocket.OPEN) p.send(payload); });
}

// ball reset function
function resetBall(towardsPlayer = 1) { // 0 = بالا، 1 = پایین
  state.ball.x = GAME_W / 2;
  state.ball.y = GAME_H / 2;
  const ang = (Math.random() * Math.PI / 3) - (Math.PI / 6); // زاویه کوچک
  const dir = (towardsPlayer === 1) ? 1 : -1;
  state.ball.vx = BASE_BALL_SPEED * Math.sin(ang);
  state.ball.vy = dir * BASE_BALL_SPEED * Math.cos(ang);
}

let tickCount = 0;
function tick() {
  if (!gameStarted) return;

  const b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // wall collisions
  if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
  if (b.x + b.r > GAME_W) { b.x = GAME_W - b.r; b.vx = -Math.abs(b.vx); }

  // paddle collisions
for (let i = 0; i < 2; i++) {
  const p = state.paddles[i];
  const hit =
    b.x + b.r > p.x &&
    b.x - b.r < p.x + p.w &&
    b.y + b.r > p.y &&
    b.y - b.r < p.y + p.h;

  if (hit) {
    // برخورد محکم و دقیق‌تر
    const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
    const currentSpeed = Math.sqrt(b.vx ** 2 + b.vy ** 2);
    const newVy = -Math.sign(b.vy) * Math.abs(b.vy);
    const newVx = offset * currentSpeed;

    b.vx = newVx;
    b.vy = newVy;

    // افزایش تدریجی سرعت بعد از هر برخورد
    const boostedSpeed = Math.min(currentSpeed * 1.05, MAX_SPEED);
    const factor = boostedSpeed / currentSpeed;
    b.vx *= factor;
    b.vy *= factor;

    // تنظیم مجدد موقعیت برای جلوگیری از گیر کردن
    if (i === 0) b.y = p.y + p.h + b.r + 0.1;
    else b.y = p.y - b.r - 0.1;
  }
}



  // score check with safety margin
  const SAFE_MARGIN = 10; // جلوگیری از reset زودرس
  if (b.y < -SAFE_MARGIN) { 
    state.scores[1]++; 
    resetBall(0); // بعد از امتیاز توپ به سمت بازیکن بالا حرکت کند
  }
  if (b.y > GAME_H + SAFE_MARGIN) { 
    state.scores[0]++; 
    resetBall(1); // بعد از امتیاز توپ به سمت بازیکن پایین حرکت کند
  }

  // send state
  if (++tickCount % SEND_EVERY === 0) {
    broadcast({
      type: 'state',
      state: {
        ball: { x: +state.ball.x.toFixed(2), y: +state.ball.y.toFixed(2), r: state.ball.r },
        paddles: state.paddles.map(p => ({
          x: +p.x.toFixed(2), y: p.y, w: p.w, h: p.h
        })),
        scores: state.scores
      }
    });
  }
}

setInterval(tick, 1000 / TICK_HZ);

// heartbeat
setInterval(()=> {
  players.forEach((p, idx) => {
    if (!p) return;
    try {
      p._meta.missedPongs = (p._meta.missedPongs || 0) + 1;
      if (p._meta.missedPongs > MAX_MISSED_PONG) {
        p.terminate();
        players[idx] = null;
        if (waitingPlayerId === idx) waitingPlayerId = null;
        gameStarted = false;
        return;
      }
      p.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch(e){}
  });
}, HEARTBEAT_MS);

// handle connection
wss.on('connection', ws => {
  const slot = players.findIndex(p => p === null);
  if (slot === -1) { ws.send(JSON.stringify({ type: 'full' })); ws.close(); return; }

  ws.playerId = slot;
  ws._meta = { missedPongs: 0, lastPaddleTs: 0 };
  players[slot] = ws;

  // assign
  send(ws, { type: 'assign', playerId: slot });

  // lobby
  if (waitingPlayerId === null) send(ws, { type: 'lobby', status: 'no_waiting' });
  else if (waitingPlayerId === slot) send(ws, { type: 'lobby', status: 'waiting_for_opponent' });
  else send(ws, { type: 'lobby', status: 'someone_waiting' });

  ws.on('message', msgRaw => {
    let data; try { data = JSON.parse(msgRaw); } catch { return; }
    if (!data.type) return;

    switch (data.type) {

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
            gameStarted = true;
            waitingPlayerId = null;
            resetBall();
            broadcast({ type: 'start' });
            // send initial state immediately
            broadcast({
              type: 'state',
              state: {
                ball: { ...state.ball },
                paddles: state.paddles,
                scores: state.scores
              }
            });
          }
        }
        break;

      case 'paddle':
        const now = Date.now();
        if (now - ws._meta.lastPaddleTs < 20) return;
        ws._meta.lastPaddleTs = now;

        const x = Number(data.x);
        if (!Number.isFinite(x)) return;
        const pid = ws.playerId;
        if (pid < 0 || pid > 1) return;
        state.paddles[pid].x = Math.max(0, Math.min(GAME_W - state.paddles[pid].w, x));
        break;
    }
  });

  ws.on('close', () => {
    const id = ws.playerId;
    if (typeof id === 'number') {
      players[id] = null;
      if (waitingPlayerId === id) waitingPlayerId = null;
      gameStarted = false;
      players.forEach(p => { if (p) send(p, { type: 'lobby', status: 'no_waiting' }); });
    }
  });

  ws.on('error', () => {});
});














