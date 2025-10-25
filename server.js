// server.js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });
const GAME_WIDTH = 800;
const GAME_HEIGHT = 600;

/*
  players: آرایه‌ی دو عنصری نگه‌دارنده‌ی socket های بازیکنان
  index 0 => بازیکن بالا (Player 0)
  index 1 => بازیکن پایین (Player 1)
*/
let players = [null, null];
let gameStarted = false;
let waitingPlayerId = null; // شناسهٔ بازیکنی که دکمه "در انتظار" را زده (null اگر هیچ‌کس منتظر نیست)

let state = {
 ball: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2, vx: 4, vy: 2, radius: 10 },
  paddles: [
   { x: GAME_WIDTH / 2 - 50, y: 30, w: 100, h: 20 },   // پدل بازیکن 0 (بالا)
     { x: GAME_WIDTH / 2 - 50, y: GAME_HEIGHT - 30 - 20, w: 100, h: 20 }   // پدل بازیکن 1 (پایین)
  ],
  scores: [0, 0]
};

function resetBall() {
  state.paddles[0].w = state.paddles[1].w = 100;
  state.paddles[0].h = state.paddles[1].h = 20;
  state.ball.x = GAME_WIDTH / 2;
  state.ball.y = GAME_HEIGHT / 2;
  state.ball.vx = (Math.random() - 0.5) * 6;
  state.ball.vy = Math.random() > 0.5 ? 4 : -4;
}


function resetGame() {
  state.scores = [0, 0];
  state.paddles[0].w = state.paddles[1].w = w;
  state.paddles[0].h = state.paddles[1].h = h;
  resetBall();
  gameStarted = false;
  // توجه: موقع قطع اتصال یا ریست بازی ممکن است لازم باشد که به کلاینتها وضعیت جدید ارسال شود
}

function broadcast(data) {
  players.forEach(p => {
    if (p && p.readyState === WebSocket.OPEN) {
      p.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', ws => {
  // پیدا کردن یک اسلات خالی
  const slot = players.findIndex(p => p === null);
  if (slot === -1) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  // ثبت بازیکن
  players[slot] = ws;
  ws.playerId = slot;
  ws.send(JSON.stringify({ type: 'assign', playerId: slot }));
  console.log(`Player ${slot} connected`);

  // اگر قبلاً کسی دکمه انتظار را زده، به این بازیکن گزارش بده
  if (waitingPlayerId !== null) {
    if (waitingPlayerId === slot) {
      // بازیکنی که خودش قبلاً انتظار گذاشته دوباره وصل شده
      ws.send(JSON.stringify({ type: 'waiting_for_opponent', waitingPlayerId }));
    } else {
      // شخص دیگری منتظر است -> به این بازیکن اطلاع بده که opponent waiting است
      ws.send(JSON.stringify({ type: 'opponent_waiting', waitingPlayerId }));
    }
  } else {
    // هیچ‌کس منتظر نیست
    ws.send(JSON.stringify({ type: 'no_waiting' }));
  }

  // پیام‌های ورودی از کلاینت
  ws.on('message', msg => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.warn('invalid json from client:', msg);
      return;
    }

    // حرکت پدل (ما انتظار داریم کلاینت فیلد x را بفرستد برای پدل‌های افقی بالا/پایین)
    if (data.type === 'paddle' && typeof data.player === 'number' && data.player >= 0 && data.player < 2) {
      if (typeof data.x === 'number') {
        // محدود کردن حد چپ/راست برای پدل
        const maxLeft = 800 - state.paddles[data.player].w;
        state.paddles[data.player].x = Math.max(0, Math.min(maxLeft, data.x));
      }
      return;
    }

    // بازیکن درخواست "در انتظار بودن" داده
    if (data.type === 'waitForPlayer') {
      if (waitingPlayerId === null) {
        waitingPlayerId = ws.playerId;
        // به خودِ منتظر اطلاع ده
        ws.send(JSON.stringify({ type: 'waiting_for_opponent', waitingPlayerId }));
        // به بازیکنِ مقابل (اگر متصل است) اطلاع ده که opponent در انتظار است
        const other = 1 - ws.playerId;
        if (players[other] && players[other].readyState === WebSocket.OPEN) {
          players[other].send(JSON.stringify({ type: 'opponent_waiting', waitingPlayerId }));
        }
        console.log(`Player ${waitingPlayerId} set as waiting`);
      } else {
        // کسی قبلاً منتظر بوده — به درخواست‌کننده بگو که عملیات موفق نبود
        ws.send(JSON.stringify({ type: 'wait_failed', waitingPlayerId }));
      }
      return;
    }

    // کلاینت بررسی می‌خواهد بداند آیا کسی منتظر است
    if (data.type === 'checkWaiting') {
      if (waitingPlayerId === null) {
        ws.send(JSON.stringify({ type: 'no_waiting' }));
      } else if (waitingPlayerId === ws.playerId) {
        ws.send(JSON.stringify({ type: 'waiting_for_opponent', waitingPlayerId }));
      } else {
        ws.send(JSON.stringify({ type: 'opponent_waiting', waitingPlayerId }));
      }
      return;
    }

    // بازیکن دوم قبول کرد
    if (data.type === 'acceptMatch') {
      // فقط اگر کسی در حالت انتظار باشد و کسی دیگر این پیام را بفرستد و دو بازیکن متصل باشند
      const other = waitingPlayerId;
      if (waitingPlayerId !== null && ws.playerId !== waitingPlayerId
          && players[0] && players[1] && players[0].readyState === WebSocket.OPEN && players[1].readyState === WebSocket.OPEN) {
        gameStarted = true;
        waitingPlayerId = null;
        resetBall();
        broadcast({ type: 'start' });
        console.log(`Game started by player ${ws.playerId} (accepted match).`);
      } else {
        ws.send(JSON.stringify({ type: 'accept_failed' }));
      }
      return;
    }

    // بازیکن دوم رد کرد
    if (data.type === 'declineMatch') {
      const waiter = waitingPlayerId;
      if (waiter !== null && players[waiter] && players[waiter].readyState === WebSocket.OPEN) {
        players[waiter].send(JSON.stringify({ type: 'declined' }));
      }
      waitingPlayerId = null;
      // به همه بگو که اکنون هیچ‌کس منتظر نیست (اختیاری)
      broadcast({ type: 'no_waiting' });
      console.log(`Player ${ws.playerId} declined the waiting player.`);
      return;
    }

    // شاید بخواهی پیام start مستقیم هم پشتیبانی کنی (اما ما از acceptMatch استفاده می‌کنیم)
    if (data.type === 'start') {
      // فقط در صورتی که دو بازیکن متصل باشند و هیچ‌کس در حالت انتظار نباشد (یا اگر این نحو را ترجیح می‌دهی، می‌توانی شرایط دیگر را تعریف کنی)
      if (players[0] && players[1] && players[0].readyState === WebSocket.OPEN && players[1].readyState === WebSocket.OPEN) {
        gameStarted = true;
        waitingPlayerId = null;
        resetBall();
        broadcast({ type: 'start' });
        console.log('Game started by start message.');
      }
      return;
    }

    // پیام‌های دیگر نادیده گرفته می‌شوند
  });

  ws.on('close', () => {
    const id = ws.playerId;
    console.log(`Player ${id} disconnected`);
    // آزاد کردن اسلات
    if (typeof id === 'number') players[id] = null;

    // اگر بازیکنِ منتظر قطع شد، وضعیت انتظار را پاک کن و اطلاع بده
    if (waitingPlayerId === id) {
      waitingPlayerId = null;
      broadcast({ type: 'no_waiting' });
    }

    // ریست بازی (اگر خواستی می‌تونی به جای ریست کامل فقط gameStarted=false کنی)
    resetGame();
  });

});

// حلقه بازی (۶۰ فریم)
setInterval(() => {
  if (!gameStarted) return;

  let b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // برخورد با دیواره‌های چپ و راست -> معکوس کردن vx
  if (b.x - b.radius < 0 || b.x + b.radius > 800) {
    b.vx *= -1;
  }

  // برخورد با پدل‌ها (بالا و پایین)
  state.paddles.forEach((p, i) => {
    if (
      b.y + b.radius > p.y &&
      b.y - b.radius < p.y + p.h &&
      b.x + b.radius > p.x &&
      b.x - b.radius < p.x + p.w
    ) {
      // معکوس کردن جهت عمودی
      b.vy *= -1;
      // تغییر vx بر اساس offest از مرکز پدل
      const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
      b.vx += offset * 3;
      const maxSpeed = 8;
      b.vx = Math.max(-maxSpeed, Math.min(maxSpeed, b.vx));
      b.vy = Math.max(-maxSpeed, Math.min(maxSpeed, b.vy));
    }
  });

  // گل شدن (وقتی توپ از بالا یا پایین خارج می‌شود)
 if (b.y < 0) {
  state.scores[1]++;
  resetBall();
} else if (b.y > GAME_HEIGHT) {
  state.scores[0]++;
  resetBall();
}


  // ارسال وضعیت به همه
  broadcast({ type: 'state', state });

}, 1000 / 60);

console.log('WebSocket server started on port', process.env.PORT || 8080);


