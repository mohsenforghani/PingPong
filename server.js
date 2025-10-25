// server.js
// Node.js + "ws"
const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const GAME_WIDTH = 450;
const GAME_HEIGHT = 800;

let players = [null, null]; // slot 0 = بالا, 1 = پایین
let waitingPlayerId = null; // playerId که "می‌خواهم بازی کنم" زده
let gameStarted = false;

let state = {
  ball: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2, vx: 4, vy: 4, radius: 10 },
  paddles: [
    { x: GAME_WIDTH / 2 - 50, y: 10, w: 100, h: 20 },
    { x: GAME_WIDTH / 2 - 50, y: GAME_HEIGHT - 30, w: 100, h: 20 }
  ],
  scores: [0, 0]
};

function resetBall() {
  state.ball.x = GAME_WIDTH / 2;
  state.ball.y = GAME_HEIGHT / 2;
  const angle = (Math.random() * Math.PI) / 4 - Math.PI / 8;
  const speed = 5;
  state.ball.vx = speed * Math.sin(angle);
  state.ball.vy = (Math.random() > 0.5 ? 1 : -1) * speed * Math.cos(angle);
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  players.forEach(p => {
    if (p && p.readyState === WebSocket.OPEN) p.send(payload);
  });
}

let frameCount = 0;
function gameLoop() {
  if (!gameStarted) return;

  const b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // برخورد با دیواره‌ها
  if (b.x - b.radius < 0) { b.x = b.radius; b.vx *= -1; }
  if (b.x + b.radius > GAME_WIDTH) { b.x = GAME_WIDTH - b.radius; b.vx *= -1; }

  // برخورد با پدل‌ها
  for (let i = 0; i < 2; i++) {
    const p = state.paddles[i];
    if (
      b.y + b.radius > p.y &&
      b.y - b.radius < p.y + p.h &&
      b.x + b.radius > p.x &&
      b.x - b.radius < p.x + p.w
    ) {
      const offset = (b.x - (p.x + p.w / 2)) / (p.w / 2);
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      b.vy = -Math.abs(b.vy); // اطمینان از جهت عمودی صحیح
      if (i === 0) b.vy = Math.abs(b.vy); // برای پدل بالا (در صورت نیاز جهت را تنظیم کن)
      b.vy *= -1; // برگرداندن جهت (سازگاری با قبل)
      b.vx = offset * speed;
      const maxSpeed = 8;
      const currentSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (currentSpeed > maxSpeed) {
        const factor = maxSpeed / currentSpeed;
        b.vx *= factor; b.vy *= factor;
      }
    }
  }

  // گل شدن
  if (b.y < 0) {
    state.scores[1]++;
    resetBall();
  }
  if (b.y > GAME_HEIGHT) {
    state.scores[0]++;
    resetBall();
  }

  // ارسال وضعیت هر 3 فریم (حدود 20 پیام در ثانیه)
  if (++frameCount % 3 === 0) {
    broadcast({
      type: "state",
      state: {
        ball: { x: b.x, y: b.y, radius: b.radius },
        paddles: state.paddles,
        scores: state.scores
      }
    });
  }
}
setInterval(gameLoop, 1000 / 60);

// مدیریت ارتباطات
wss.on("connection", (ws) => {
  const slot = players.findIndex(p => p === null);
  if (slot === -1) {
    ws.send(JSON.stringify({ type: "full" }));
    ws.close();
    return;
  }

  players[slot] = ws;
  ws.playerId = slot;
  ws.send(JSON.stringify({ type: "assign", playerId: slot }));

  // به کلاینت اطلاعات اولیه لابی رو بفرست
  if (waitingPlayerId === null) {
    ws.send(JSON.stringify({ type: "no_waiting" }));
  } else if (waitingPlayerId === ws.playerId) {
    ws.send(JSON.stringify({ type: "waiting_for_opponent" }));
  } else {
    // اگر شخص دیگری منتظر است به کاربر جدید اطلاع بده تا "شروع بازی" را نشان دهد
    ws.send(JSON.stringify({ type: "show_start", waitingPlayerId }));
  }

  ws.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    // حرکت پدل: **سرور فقط پدلِ خودِ sender را قبول می‌کند**
    if (data.type === "paddle") {
      if (typeof ws.playerId === "number" && typeof data.x === "number") {
        const pid = ws.playerId;
        const maxLeft = GAME_WIDTH - state.paddles[pid].w;
        state.paddles[pid].x = Math.max(0, Math.min(maxLeft, data.x));
      }
      return;
    }

    // بازیکن می‌گوید "می‌خواهم بازی کنم" -> او منتظر می‌شود
    if (data.type === "waitForPlayer") {
      waitingPlayerId = ws.playerId;
      // فقط به همان نفر پیام waiting_for_opponent
      if (players[waitingPlayerId] && players[waitingPlayerId].readyState === WebSocket.OPEN)
        players[waitingPlayerId].send(JSON.stringify({ type: "waiting_for_opponent" }));
      // و به بقیه‌ی بازیکن‌ها بگو که show_start نمایش داده شود
      players.forEach((p, idx) => {
        if (p && p.readyState === WebSocket.OPEN && idx !== waitingPlayerId) {
          p.send(JSON.stringify({ type: "show_start", waitingPlayerId }));
        }
      });
      return;
    }

    // بازیکنِ دیگر روی "شروع بازی" زده -> بازی شروع می‌شود
    if (data.type === "acceptMatch") {
      // فقط زمانی که واقعا یک waitingPlayer داریم و accepter != waiting
      if (waitingPlayerId !== null && ws.playerId !== waitingPlayerId) {
        // هر دو بازیکن باید متصل باشند
        const a = waitingPlayerId, b = ws.playerId;
        if (players[a] && players[b] && players[a].readyState === WebSocket.OPEN && players[b].readyState === WebSocket.OPEN) {
          gameStarted = true;
          waitingPlayerId = null;
          resetBall();
          broadcast({ type: "start" });
          broadcast({
            type: "state",
            state: {
              ball: state.ball,
              paddles: state.paddles,
              scores: state.scores
            }
          });
        }
      }
      return;
    }

    // کنسل کردن انتظار توسط کسی که منتظر است
    if (data.type === "declineMatch" || data.type === "cancelWait") {
      const prev = waitingPlayerId;
      waitingPlayerId = null;
      // اگر کسی منتظر بوده اطلاع بده
      if (prev !== null && players[prev] && players[prev].readyState === WebSocket.OPEN) {
        players[prev].send(JSON.stringify({ type: "declined" }));
      }
      // به بقیه اطلاع بده که دیگر منتظر وجود ندارد
      players.forEach((p) => { if (p && p.readyState === WebSocket.OPEN) p.send(JSON.stringify({ type: "no_waiting" })); });
      return;
    }

    // چک لابی
    if (data.type === "checkWaiting") {
      if (waitingPlayerId === null) ws.send(JSON.stringify({ type: "no_waiting" }));
      else if (waitingPlayerId === ws.playerId) ws.send(JSON.stringify({ type: "waiting_for_opponent" }));
      else ws.send(JSON.stringify({ type: "show_start", waitingPlayerId }));
      return;
    }
  });

  ws.on("close", () => {
    const id = ws.playerId;
    if (typeof id === "number") players[id] = null;
    if (waitingPlayerId === id) {
      waitingPlayerId = null;
      // به همه بگو دیگر منتظر نیست
      players.forEach((p) => { if (p && p.readyState === WebSocket.OPEN) p.send(JSON.stringify({ type: "no_waiting" })); });
    }
    gameStarted = false;
  });
});

console.log("WebSocket server started on port", process.env.PORT || 8080);
