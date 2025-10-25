// server.js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const GAME_WIDTH = 450;
const GAME_HEIGHT = 800;

let players = [null, null]; // player 0 = بالا، player 1 = پایین
let gameStarted = false;
let waitingPlayerId = null;

let state = {
  ball: { x: GAME_WIDTH/2, y: GAME_HEIGHT/2, vx: 5, vy: 5, radius: 10 },
  paddles: [
    { x: GAME_WIDTH/2 - 50, y: 10, w: 100, h: 20 },
    { x: GAME_WIDTH/2 - 50, y: GAME_HEIGHT - 30, w: 100, h: 20 }
  ],
  scores: [0,0]
};

function resetBall() {
  state.ball.x = GAME_WIDTH/2;
  state.ball.y = GAME_HEIGHT/2;
  const angle = (Math.random() * Math.PI / 4) - Math.PI / 8; // ±22.5 درجه
  const speed = 5;
  state.ball.vx = speed * Math.sin(angle);
  state.ball.vy = Math.random() > 0.5 ? speed * Math.cos(angle) : -speed * Math.cos(angle);
}

function broadcast(data){
  const payload = JSON.stringify(data);
  players.forEach(p => {
    if(p && p.readyState === WebSocket.OPEN) p.send(payload);
  });
}

wss.on('connection', ws => {
  const slot = players.findIndex(p=>p===null);
  if(slot === -1){
    ws.send(JSON.stringify({type:'full'}));
    ws.close();
    return;
  }

  players[slot] = ws;
  ws.playerId = slot;
  ws.send(JSON.stringify({type:'assign', playerId: slot}));

  // وضعیت waiting
  if(waitingPlayerId !== null){
    if(waitingPlayerId === slot){
      ws.send(JSON.stringify({type:'waiting_for_opponent', waitingPlayerId}));
    } else {
      ws.send(JSON.stringify({type:'opponent_waiting', waitingPlayerId}));
    }
  } else {
    ws.send(JSON.stringify({type:'no_waiting'}));
  }

  ws.on('message', msg=>{
    let data;
    try{ data = JSON.parse(msg); } catch(e){ return; }

    // حرکت پدل
    if(data.type==='paddle' && typeof data.x==='number'){
      const maxLeft = GAME_WIDTH - state.paddles[data.player].w;
      state.paddles[data.player].x = Math.max(0, Math.min(maxLeft, data.x));
      return;
    }

    // دکمه wait
    if(data.type==='waitForPlayer'){
      if(waitingPlayerId===null){
        waitingPlayerId = ws.playerId;
        ws.send(JSON.stringify({type:'waiting_for_opponent', waitingPlayerId}));
        const other = 1 - ws.playerId;
        if(players[other] && players[other].readyState===WebSocket.OPEN)
          players[other].send(JSON.stringify({type:'opponent_waiting', waitingPlayerId}));
      } else {
        ws.send(JSON.stringify({type:'wait_failed', waitingPlayerId}));
      }
      return;
    }

    if(data.type==='checkWaiting'){
      if(waitingPlayerId===null) ws.send(JSON.stringify({type:'no_waiting'}));
      else if(waitingPlayerId===ws.playerId) ws.send(JSON.stringify({type:'waiting_for_opponent', waitingPlayerId}));
      else ws.send(JSON.stringify({type:'opponent_waiting', waitingPlayerId}));
      return;
    }

    if(data.type==='acceptMatch'){
      if(waitingPlayerId!==null && ws.playerId!==waitingPlayerId && players[0] && players[1]){
        gameStarted=true;
        waitingPlayerId=null;
        resetBall();
        broadcast({type:'start'});
      }
      return;
    }

    if(data.type==='declineMatch'){
      if(waitingPlayerId!==null && players[waitingPlayerId] && players[waitingPlayerId].readyState===WebSocket.OPEN)
        players[waitingPlayerId].send(JSON.stringify({type:'declined'}));
      waitingPlayerId=null;
      broadcast({type:'no_waiting'});
      return;
    }
  });

  ws.on('close', ()=>{
    const id = ws.playerId;
    if(typeof id==='number') players[id]=null;
    if(waitingPlayerId===id){
      waitingPlayerId=null;
      broadcast({type:'no_waiting'});
    }
    gameStarted=false;
  });
});

// حلقه بازی 50fps
setInterval(()=>{
  if(!gameStarted) return;
  const b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // برخورد با دیواره‌ها
  if(b.x-b.radius<0 || b.x+b.radius>GAME_WIDTH) b.vx*=-1;

  // برخورد با پدل‌ها
  state.paddles.forEach(p=>{
    if(b.y + b.radius > p.y && b.y - b.radius < p.y + p.h &&
       b.x + b.radius > p.x && b.x - b.radius < p.x + p.w){
      const offset = (b.x - (p.x + p.w/2)) / (p.w/2);
      const speed = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
      b.vy*=-1;
      b.vx = offset * speed;
      const maxSpeed=8;
      const currentSpeed = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
      if(currentSpeed>maxSpeed){
        const factor=maxSpeed/currentSpeed;
        b.vx*=factor;
        b.vy*=factor;
      }
    }
  });

  // گل شدن
  if(b.y<0){ state.scores[1]++; resetBall(); }
  else if(b.y>GAME_HEIGHT){ state.scores[0]++; resetBall(); }

  broadcast({type:'state', state});
}, 1000/50);

//console.log('WebSocket server started on port', process.env.PORT || 8080);
