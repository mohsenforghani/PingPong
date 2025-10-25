// ===== server.js =====
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

let players = [];
let gameStarted = false;
let waitingForSecond = false;  // آیا بازیکن اول دکمه انتظار را زده؟
let waitingPlayerId = null;    // شناسه بازیکنی که دکمه انتظار را زده



let state = {
  ball: { x: 400, y: 300, vx: 4, vy: 2, radius: 10 },
  paddles: [
    { x: 350, y: 30, w: 100, h: 20 },   // پدل بازیکن 1 (بالا)
    { x: 350, y: 550, w: 100, h: 20 }   // پدل بازیکن 2 (پایین)
  ],
  scores: [0, 0]
};

function resetBall() {
  state.ball.x = 400;
  state.ball.y = 300;
  state.ball.vx = (Math.random() - 0.5) * 6; // حرکت جزئی افقی
  state.ball.vy = Math.random() > 0.5 ? 4 : -4; // حرکت اصلی عمودی
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
// بازیکن اول دکمه انتظار را زد
  if (data.type === 'waitForPlayer') {
    waitingForSecond = true;
    waitingPlayerId = playerId;
    // اطلاع نفر دوم
    broadcast({ type: 'waiting', waitingPlayerId });
  }
 // نفر دوم دکمه بله برای شروع بازی را زد
  if (data.type === 'start' && players.length === 2 && waitingForSecond) {
    gameStarted = true;
    waitingForSecond = false;    // حالا دکمه‌ها پاک می‌شوند
    broadcast({ type: 'start' });
  }
    
  // نفر دوم دکمه بله برای شروع بازی را زد
  if (data.type === 'start' && players.length === 2 && waitingForSecond) {
    gameStarted = true;
    waitingForSecond = false;    // حالا دکمه‌ها پاک می‌شوند
    broadcast({ type: 'start' });
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
  
 // برخورد با دیواره‌های چپ و راست
if (b.x - b.radius < 0 || b.x + b.radius > 800) {
  b.vx *= -1;
}

  // برخورد با راکت‌ها
 // برخورد با پدل‌ها (بالا و پایین)
state.paddles.forEach((p, i) => {
  if (
    b.y + b.radius > p.y && 
    b.y - b.radius < p.y + p.h &&
    b.x + b.radius > p.x &&
    b.x - b.radius < p.x + p.w
  ) {
    b.vy *= -1; // تغییر جهت عمودی
    // اثر برخورد با فاصله از مرکز پدل
    const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
    b.vx += offset * 3;
    const maxSpeed = 8;
    b.vx = Math.max(-maxSpeed, Math.min(maxSpeed, b.vx));
    b.vy = Math.max(-maxSpeed, Math.min(maxSpeed, b.vy));
  }
});


  // گل شدن
 if (b.y < 0) {
  state.scores[1]++; // بازیکن پایین گل زد
  resetBall();
} else if (b.y > 600) {
  state.scores[0]++; // بازیکن بالا گل زد
  resetBall();
}


  broadcast({ type: 'state', state });
}, 1000 / 60);


