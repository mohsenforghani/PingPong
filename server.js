const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const GAME_WIDTH = 450;
const GAME_HEIGHT = 800;

// وضعیت بازی
let players = [null, null]; // index 0 => بالا، 1 => پایین
let waitingPlayerId = null;
let gameStarted = false;

let state = {
  ball: { x: GAME_WIDTH/2, y: GAME_HEIGHT/2, vx: 4, vy: 4, radius: 10 },
  paddles: [
    { x: GAME_WIDTH/2 - 50, y: 10, w: 100, h: 20 },
    { x: GAME_WIDTH/2 - 50, y: GAME_HEIGHT-30, w: 100, h: 20 }
  ],
  scores: [0,0]
};

// ریست توپ
function resetBall(){
  state.ball.x = GAME_WIDTH/2;
  state.ball.y = GAME_HEIGHT/2;
  const angle = (Math.random() * Math.PI/4) - Math.PI/8;
  const speed = 5;
  state.ball.vx = speed * Math.sin(angle);
  state.ball.vy = Math.random()>0.5 ? speed * Math.cos(angle) : -speed * Math.cos(angle);
}

// ارسال پیام به همه
function broadcast(data){
  const payload = JSON.stringify(data);
  players.forEach(p=>{
    if(p && p.readyState===WebSocket.OPEN){
      p.send(payload);
    }
  });
}

// حلقه بازی
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
        const factor = maxSpeed / currentSpeed;
        b.vx *= factor;
        b.vy *= factor;
      }
    }
  }

  // گل شدن
  if (b.y < 0) { state.scores[1]++; resetBall(); }
  if (b.y > GAME_HEIGHT) { state.scores[0]++; resetBall(); }

  // فقط هر 3 فریم (حدود 20fps) وضعیت ارسال شود
  if (++frameCount % 3 === 0) {
    broadcast({
      type: 'state',
      state: {
        ball: { x: b.x, y: b.y, radius: b.radius },
        paddles: state.paddles,
        scores: state.scores
      }
    });
  }
}
setInterval(gameLoop, 1000 / 60);


// اتصال بازیکن
wss.on('connection', ws=>{
  const slot = players.findIndex(p=>p===null);
  if(slot===-1){ ws.send(JSON.stringify({type:'full'})); ws.close(); return; }

  players[slot]=ws;
  ws.playerId = slot;
  ws.send(JSON.stringify({type:'assign', playerId: slot}));

  // وضعیت انتظار
  if(waitingPlayerId!==null){
    if(waitingPlayerId===slot) ws.send(JSON.stringify({type:'waiting_for_opponent', waitingPlayerId}));
    else ws.send(JSON.stringify({type:'opponent_waiting', waitingPlayerId}));
  } else ws.send(JSON.stringify({type:'no_waiting'}));

  // پیام‌ها
  ws.on('message', msg=>{
    let data;
    try{ data=JSON.parse(msg); } catch(e){ return; }

    // حرکت پدل
    if(data.type==='paddle' && typeof data.player==='number' && data.player>=0 && data.player<2){
      if(typeof data.x==='number'){
        const maxLeft = GAME_WIDTH - state.paddles[data.player].w;
        state.paddles[data.player].x = Math.max(0, Math.min(maxLeft, data.x));
      }
      return;
    }

    // wait
    if(data.type==='waitForPlayer'){
      if(waitingPlayerId===null){
        waitingPlayerId = ws.playerId;
        ws.send(JSON.stringify({type:'waiting_for_opponent', waitingPlayerId}));
        const other = 1 - ws.playerId;
        if(players[other] && players[other].readyState===WebSocket.OPEN)
          players[other].send(JSON.stringify({type:'opponent_waiting', waitingPlayerId}));
      } else ws.send(JSON.stringify({type:'wait_failed', waitingPlayerId}));
      return;
    }

    // چک waiting
    if(data.type==='checkWaiting'){
      if(waitingPlayerId===null) ws.send(JSON.stringify({type:'no_waiting'}));
      else if(waitingPlayerId===ws.playerId) ws.send(JSON.stringify({type:'waiting_for_opponent', waitingPlayerId}));
      else ws.send(JSON.stringify({type:'opponent_waiting', waitingPlayerId}));
      return;
    }

    // accept
    if(data.type==='acceptMatch'){
      const other = waitingPlayerId;
      if(waitingPlayerId!==null && ws.playerId!==waitingPlayerId &&
         players[0] && players[1] && players[0].readyState===WebSocket.OPEN && players[1].readyState===WebSocket.OPEN){
        gameStarted = true;
        waitingPlayerId = null;
        resetBall();
        broadcast({type:'start'});
        broadcast({type:'state', state}); // ← مهم: ارسال وضعیت اولیه
      } else ws.send(JSON.stringify({type:'accept_failed'}));
      return;
    }

    // decline
    if(data.type==='declineMatch'){
      const waiter = waitingPlayerId;
      if(waiter!==null && players[waiter] && players[waiter].readyState===WebSocket.OPEN)
        players[waiter].send(JSON.stringify({type:'declined'}));
      waitingPlayerId=null;
      broadcast({type:'no_waiting'});
      return;
    }

  });

  ws.on('close', ()=>{
    const id = ws.playerId;
    if(typeof id==='number') players[id]=null;
    if(waitingPlayerId===id){ waitingPlayerId=null; broadcast({type:'no_waiting'}); }
    gameStarted=false;
  });

});

console.log('WebSocket server started on port', process.env.PORT || 8080);

