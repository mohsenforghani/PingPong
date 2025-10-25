// server.js
// Node.js + ws server (برای Render آماده)
// نصب: npm install ws
// اجرا: node server.js
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
console.log(`Server running on port ${PORT}`);

// بازی در ابعاد سرور (ثابت)
const W = 800, H = 600;
const FPS_PHYS = 60;    // فیزیک سرور (محاسبه توپ)
const FPS_BROAD = 30;   // ارسال به کلاینت (برای کم کردن پهنای باند)

// وضعیت بازی (مختصر نگه داشته شده)
let state = {
  b: { x: W/2, y: H/2, vx: 5, vy: 3, r: 10 },   // ball (b)
  p: [ {x: 20, y: H/2-50, w: 20, h:100, vy:0, ready:false},
       {x: W-40, y: H/2-50, w: 20, h:100, vy:0, ready:false} ], // paddles p[0], p[1]
  s: [0,0],   // scores
  st: 'waiting' // status: waiting | lobby | running
};

// نگه داشتن کانکشن‌ها با شناسه
let players = []; // {ws, id}

// helper: broadcast compact state
function broadcastCompact() {
  // پیام سبک: {b:{x,y,vx,vy,r}, p:[y0,y1], s:[..], st}
  if(players.length === 0) return;
  const payload = {
    b: {
      x: round(state.b.x), y: round(state.b.y),
      vx: round(state.b.vx), vy: round(state.b.vy),
      r: state.b.r
    },
    p: [ round(state.p[0].y), round(state.p[1].y) ],
    s: state.s,
    st: state.st
  };
  const msg = JSON.stringify(payload);
  players.forEach(p => {
    if(p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}

function round(v){ return Math.round(v*100)/100; }

// physics update at FPS_PHYS
function physStep(){
  if(state.st !== 'running') return;

  // update ball
  const b = state.b;
  b.x += b.vx;
  b.y += b.vy;

  // wall collisions (top/bottom)
  if(b.y - b.r <= 0){
    b.y = b.r;
    b.vy = -b.vy;
  } else if(b.y + b.r >= H){
    b.y = H - b.r;
    b.vy = -b.vy;
  }

  // paddles collision (swept simple): check overlap
  state.p.forEach((pad, i) => {
    // paddle box
    const left = pad.x, right = pad.x + pad.w, top = pad.y, bottom = pad.y + pad.h;
    // if ball intersects pad area
    if(b.x - b.r <= right && b.x + b.r >= left && b.y >= top && b.y <= bottom){
      // determine side
      if(i === 0 && b.vx < 0){
        b.x = right + b.r; // push outside
        b.vx = -b.vx * 0.98; // friction on hit
      } else if(i === 1 && b.vx > 0){
        b.x = left - b.r;
        b.vx = -b.vx * 0.98;
      } else {
        // if hitting from the side due to very high speed, reflect vx
        b.vx = -b.vx * 0.98;
      }
      // add paddle effect: use paddle vertical velocity
      b.vy += pad.vy * 0.2;
      // clamp speeds a bit
      if(Math.abs(b.vx) < 1) b.vx = Math.sign(b.vx || 1) * 1;
      if(Math.abs(b.vy) < 0.5) b.vy = Math.sign(b.vy || 0.5) * 0.5;
    }
  });

  // score (ball passed left or right)
  if(b.x + b.r < 0){
    state.s[1] += 1;
    startResetBall(1);
  } else if(b.x - b.r > W){
    state.s[0] += 1;
    startResetBall(-1);
  }
}

// reset ball to center, direction toward scorerOpposite indicated by dir (-1 means left player scored?)
// we use small reset with pause
function startResetBall(dir){
  state.st = 'pause';
  state.b.x = W/2; state.b.y = H/2;
  state.b.vx = 5 * dir; // send toward loser
  state.b.vy = (Math.random()*4 - 2);
  // short pause then continue
  setTimeout(()=> {
    state.st = 'running';
  }, 700);
}

// broadcast loop at FPS_BROAD
let physTimer = setInterval(physStep, 1000 / FPS_PHYS);
let broadTimer = setInterval(broadcastCompact, 1000 / FPS_BROAD);

// handle new connections
wss.on('connection', (ws) => {
  // if more than 2 players, reject
  if(players.length >= 2){
    ws.send(JSON.stringify({ msg: 'full' }));
    ws.close();
    return;
  }
  const id = players.length;
  players.push({ ws, id });
  // send assigned id and small initial state
  ws.send(JSON.stringify({ id }));

  // if first player arrived, status -> lobby (waiting for ready)
  if(players.length === 1){
    state.st = 'lobby';
    state.p[0].ready = false;
    state.p[1].ready = false;
  } else if(players.length === 2){
    state.st = 'lobby';
    // second player connected
  }

  console.log('player connected', id);

  ws.on('message', (raw) => {
    // expect small JSON messages
    // formats:
    // {t:'p', y:NUMBER}   => paddle move
    // {t:'ready'}         => player pressed "منتظر نفر دوم"
    // {t:'start'}         => player pressed "شروع بازی"
    try {
      const d = JSON.parse(raw);
      if(d.t === 'p' && typeof d.y === 'number' && typeof d.id === 'number'){
        const pid = d.id;
        if(state.p[pid]){
          // compute vy
          const prevY = state.p[pid].y;
          const newY = Math.max(0, Math.min(H - state.p[pid].h, d.y));
          state.p[pid].vy = (newY - prevY); // per phys tick this is coarse, acceptable
          state.p[pid].y = newY;
        }
      } else if(d.t === 'ready' && typeof d.id === 'number'){
        const pid = d.id;
        if(state.p[pid]) state.p[pid].ready = true;
        // notify others via broadcastCompact next tick
      } else if(d.t === 'start' && typeof d.id === 'number'){
        // only allow start if both players connected and both ready
        if(players.length === 2 && state.p[0].ready && state.p[1].ready){
          state.st = 'running';
          // ensure ball in good state
          state.b.x = W/2; state.b.y = H/2;
          state.b.vx = Math.random()>0.5?5:-5;
          state.b.vy = (Math.random()*4 - 2);
        }
      }
    } catch (e){
      // ignore invalid
    }
  });

  ws.on('close', () => {
    console.log('player disconnected', id);
    // remove player entry
    players = players.filter(p => p.ws !== ws);
    // reset game
    resetAll();
  });
});

function resetAll(){
  // reset everything to waiting/lobby
  state = {
    b: { x: W/2, y: H/2, vx: 5, vy: 3, r: 10 },
    p: [ {x: 20, y: H/2-50, w: 20, h:100, vy:0, ready:false},
         {x: W-40, y: H/2-50, w: 20, h:100, vy:0, ready:false} ],
    s: [0,0],
    st: players.length === 0 ? 'waiting' : 'lobby'
  };
}

// safety: clear on shutdown
process.on('SIGINT', () => {
  clearInterval(physTimer);
  clearInterval(broadTimer);
  wss.close();
  process.exit();
});
