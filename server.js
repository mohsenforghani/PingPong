// ===== server.js =====
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

let players = [];
let gameStarted = false;

let state = {
  ball: { x: 400, y: 300, vx: 4, vy: 2, radius: 10 },
  paddles: [
    { x: 50, y: 250, w: 20, h: 100 },
    { x: 730, y: 250, w: 20, h: 100 }
  ],
  scores: [0, 0]
};

function resetBall() {
  state.ball.x = 400;
  state.ball.y = 300;
  state.ball.vx = Math.random() > 0.5 ? 4 : -4;
  state.ball.vy = (Math.random() - 0.5) * 6;
}

function resetGame() {
  state.scores = [0, 0];
  resetBall();
  gameStarted = false;
}

function broadcast(data) {
  players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) {
      p.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', ws => {
  if (players.length >= 2) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  const playerId = players.length;
  players.push(ws);
  ws.send(JSON.stringify({ type: 'assign', playerId }));
  console.log(`Player ${playerId} connected`);

  ws.on('message', msg => {
    const data = JSON.parse(msg);

    if (data.type === 'paddle' && typeof data.player === 'number' && data.player < 2) {
      state.paddles[data.player].y = Math.max(0, Math.min(600 - state.paddles[data.player].h, data.y));
    }

    if (data.type === 'start' && players.length === 2) {
      gameStarted = true;
      broadcast({ type: 'start' });
      console.log('Game started!');
    }
  });

  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected`);
    players = players.filter(p => p !== ws);
    resetGame();
  });
});

// حلقه بازی (۶۰ فریم در ثانیه)
setInterval(() => {
  if (!gameStarted) return;

  let b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // برخورد با بالا و پایین
  if (b.y - b.radius < 0 || b.y + b.radius > 600) {
    b.vy *= -1;
  }

  // برخورد با راکت‌ها
  state.paddles.forEach((p, i) => {
    if (
      b.x + b.radius > p.x &&
      b.x - b.radius < p.x + p.w &&
      b.y + b.radius > p.y &&
      b.y - b.radius < p.y + p.h
    ) {
      b.vx *= -1; // تغییر جهت افقی
      // اثر ضربه بر اساس فاصله از مرکز راکت
      const offset = (b.y - (p.y + p.h / 2)) / (p.h / 2);
      b.vy += offset * 3;
      // محدود کردن سرعت توپ
      const maxSpeed = 8;
      b.vx = Math.max(-maxSpeed, Math.min(maxSpeed, b.vx));
      b.vy = Math.max(-maxSpeed, Math.min(maxSpeed, b.vy));
    }
  });

  // گل شدن
  if (b.x < 0) {
    state.scores[1]++;
    resetBall();
  } else if (b.x > 800) {
    state.scores[0]++;
    resetBall();
  }

  broadcast({ type: 'state', state });
}, 1000 / 60);
