// ===== server.js =====
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

let players = [];
let gameStarted = false;

// وضعیت اولیه
let state = {
  ball: { x: 400, y: 300, vx: 5, vy: 3, radius: 10 },
  paddles: [
    { x: 50, y: 250, w: 20, h: 100 },
    { x: 730, y: 250, w: 20, h: 100 }
  ],
  scores: [0, 0]
};

const FRICTION = 0.98;

// اتصال بازیکن‌ها
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
    if (data.type === 'paddle') {
      state.paddles[data.player].y = data.y;
    }
    if (data.type === 'start' && players.length === 2) {
      gameStarted = true;
    }
  });

  ws.on('close', () => {
    players = players.filter(p => p !== ws);
    gameStarted = false;
    resetGame();
  });
});

// حلقه بازی
setInterval(() => {
  if (!gameStarted) return;

  // حرکت توپ
  state.ball.x += state.ball.vx;
  state.ball.y += state.ball.vy;

  // برخورد با دیواره‌ها
  if (state.ball.y - state.ball.radius < 0 || state.ball.y + state.ball.radius > 600) {
    state.ball.vy = -state.ball.vy;
  }

  // برخورد با راکت‌ها
  state.paddles.forEach((p, i) => {
    if (
      state.ball.x + state.ball.radius > p.x &&
      state.ball.x - state.ball.radius < p.x + p.w &&
      state.ball.y + state.ball.radius > p.y &&
      state.ball.y - state.ball.radius < p.y + p.h
    ) {
      state.ball.vx = -state.ball.vx * FRICTION;
      state.ball.vy *= FRICTION;
      // اثر برخورد با مرکز راکت
      const hitPos = (state.ball.y - (p.y + p.h / 2)) / (p.h / 2);
      state.ball.vy += hitPos * 3;
    }
  });

  // گل شدن
  if (state.ball.x < 0) {
    state.scores[1]++;
    resetBall();
  } else if (state.ball.x > 800) {
    state.scores[0]++;
    resetBall();
  }

  broadcast({ type: 'state', state });
}, 1000 / 60); // 60 FPS

function resetBall() {
  state.ball.x = 400;
  state.ball.y = 300;
  state.ball.vx = Math.random() > 0.5 ? 5 : -5;
  state.ball.vy = (Math.random() - 0.5) * 6;
}

function resetGame() {
  state.scores = [0, 0];
  resetBall();
}

function broadcast(data) {
  players.forEach(p => {
    if (p.readyState === WebSocket.OPEN) p.send(JSON.stringify(data));
  });
}
