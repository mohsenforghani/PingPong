const WebSocket = require("ws");
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const GAME_WIDTH = 450;
const GAME_HEIGHT = 800;

let players = [null, null]; // index 0 = بالا، 1 = پایین
let waitingPlayerId = null;
let gameStarted = false;

let state = {
  ball: { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2, vx: 4, vy: 4, radius: 10 },
  paddles: [
    { x: GAME_WIDTH / 2 - 50, y: 10, w: 100, h: 20 },
    { x: GAME_WIDTH / 2 - 50, y: GAME_HEIGHT - 30, w: 100, h: 20 },
  ],
  scores: [0, 0],
};

// ریست توپ
function resetBall() {
  state.ball.x = GAME_WIDTH / 2;
  state.ball.y = GAME_HEIGHT / 2;
  const angle = (Math.random() * Math.PI) / 4 - Math.PI / 8;
  const speed = 5;
  state.ball.vx = speed * Math.sin(angle);
  state.ball.vy = Math.random() > 0.5 ? speed * Math.cos(angle) : -speed * Math.cos(angle);
}

// ارسال پیام به همه
function broadcast(data) {
  const payload = JSON.stringify(data);
  players.forEach((p) => {
    if (p && p.readyState === WebSocket.OPEN) p.send(payload);
  });
}

// حلقه بازی (بهینه)
let frameCount = 0;
function gameLoop() {
  if (!gameStarted) return;

  const b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // برخورد با دیواره‌ها
  if (b.x - b.radius < 0 || b.x + b.radius > GAME_WIDTH) b.vx *= -1;

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
      b.vy *= -1;
      b.vx = offset * speed;
      const maxSpeed = 8;
      const currentSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (currentSpeed > maxSpeed) {
        const f = maxSpeed / currentSpeed;
        b.vx *= f;
        b.vy *= f;
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

  // ارسال وضعیت (هر 3 فریم یک‌بار برای کاهش بار شبکه)
  if (++frameCount % 3 === 0) {
    broadcast({
      type: "state",
      state: {
        ball: { x: b.x, y: b.y, radius: b.radius },
        paddles: state.paddles,
        scores: state.scores,
      },
    });
  }
}
setInterval(gameLoop, 1000 / 60);

// اتصال بازیکن
wss.on("connection", (ws) => {
  const slot = players.findIndex((p) => p === null);
  if (slot === -1) {
    ws.send(JSON.stringify({ type: "full" }));
    ws.close();
    return;
  }

  players[slot] = ws;
  ws.playerId = slot;
  ws.send(JSON.stringify({ type: "assign", playerId: slot }));

  if (waitingPlayerId === null) {
    ws.send(JSON.stringify({ type: "no_waiting" }));
  } else {
    ws.send(JSON.stringify({ type: "opponent_waiting", waitingPlayerId }));
  }

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    // حرکت پدل
    if (data.type === "paddle" && data.player >= 0 && data.player < 2) {
      const maxLeft = GAME_WIDTH - state.paddles[data.player].w;
      state.paddles[data.player].x = Math.max(0, Math.min(maxLeft, data.x));
      return;
    }

    // ورود به حالت انتظار
    if (data.type === "waitForPlayer") {
      waitingPlayerId = ws.playerId;
      ws.send(JSON.stringify({ type: "waiting_for_opponent" }));
      broadcast({ type: "opponent_waiting", waitingPlayerId });
      return;
    }

    // پذیرش بازی
    if (data.type === "acceptMatch") {
      if (waitingPlayerId !== null && ws.playerId !== waitingPlayerId) {
        gameStarted = true;
        waitingPlayerId = null;
        resetBall();
        broadcast({ type: "start" });
        broadcast({ type: "state", state });
      }
      return;
    }

    // رد بازی
    if (data.type === "declineMatch") {
      const waiter = waitingPlayerId;
      waitingPlayerId = null;
      if (waiter !== null && players[waiter]?.readyState === WebSocket.OPEN)
        players[waiter].send(JSON.stringify({ type: "declined" }));
      broadcast({ type: "no_waiting" });
      return;
    }
  });

  ws.on("close", () => {
    const id = ws.playerId;
    if (typeof id === "number") players[id] = null;
    if (waitingPlayerId === id) waitingPlayerId = null;
    gameStarted = false;
  });
});

console.log("WebSocket server started on port", process.env.PORT || 8080);
