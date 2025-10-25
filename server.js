const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const GAME_W = 450;
const GAME_H = 800;

let players = [null, null];
let gameStarted = false;
let waitingPlayerId = null;

let state = {
  ball: { x: GAME_W/2, y: GAME_H/2, vx:4, vy:2, radius:10 },
  paddles: [
    { x: GAME_W/2 - 50, y:10, w:100, h:20 },
    { x: GAME_W/2 - 50, y: GAME_H - 30, w:100, h:20 }
  ],
  scores: [0,0]
};

function resetBall() {
  state.ball.x = GAME_W/2;
  state.ball.y = GAME_H/2;
  const angle = (Math.random()*Math.PI/4) - Math.PI/8;
  const speed = 5;
  state.ball.vx = speed * Math.sin(angle);
  state.ball.vy = Math.random()>0.5 ? speed * Math.cos(angle) : -speed * Math.cos(angle);
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  players.forEach(p => { if(p && p.readyState===WebSocket.OPEN) p.send(payload); });
}

wss.on('connection', ws => {
  const slot = players.findIndex(p=>p===null);
  if(slot===-1){ ws.send(JSON.stringify({type:'full'})); ws.close(); return; }

  players[slot]=ws;
  ws.playerId = slot;
  ws.send(JSON.stringify({type:'assign', playerId:slot}));

  ws.on('message', msg=>{
    let data;
    try { data=JSON.parse(msg); } catch(e){ return; }

    if(data.type==='paddle' && typeof data.player==='number'){
      if(typeof data.x==='number'){
        const maxLeft = GAME_W - state.paddles[data.player].w;
        state.paddles[data.player].x = Math.max(0, Math.min(maxLeft, data.x));
      }
      return;
    }

    if(data.type==='waitForPlayer'){
      if(waitingPlayerId===null){
        waitingPlayerId=ws.playerId;
        ws.send(JSON.stringify({type:'waiting_for_opponent', waitingPlayerId}));
        const other = 1 - ws.playerId;
        if(players[other] && players[other].readyState===WebSocket.OPEN){
          players[other].send(JSON.stringify({type:'opponent_waiting', waitingPlayerId}));
        }
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
      const other = waitingPlayerId;
      if(waitingPlayerId!==null && ws.playerId!==waitingPlayerId && players[0] && players[1]){
        gameStarted=true;
        waitingPlayerId=null;
        resetBall();
        broadcast({type:'start'});
      }
      return;
    }

    if(data.type==='declineMatch'){
      const waiter = waitingPlayerId;
      if(waiter!==null && players[waiter] && players[waiter].readyState===WebSocket.OPEN){
        players[waiter].send(JSON.stringify({type:'declined'}));
      }
      waitingPlayerId=null;
      broadcast({type:'no_waiting'});
      return;
    }
  });

  ws.on('close', ()=>{
    const id = ws.playerId;
    players[id]=null;
    if(waitingPlayerId===id){
      waitingPlayerId=null;
      broadcast({type:'no_waiting'});
    }
    gameStarted=false;
    resetBall();
  });
});

// حلقه بازی
setInterval(()=>{
  if(!gameStarted) return;

  let b = state.ball;
  b.x += b.vx;
  b.y += b.vy;

  // برخورد با دیواره‌های چپ و راست
  if(b.x-b.radius<0 || b.x+b.radius>GAME_W) b.vx*=-1;

  // برخورد با پدل‌ها
  state.paddles.forEach((p,i)=>{
    if(b.y+b.radius>p.y && b.y-b.radius<p.y+p.h && b.x+b.radius>p.x && b.x-b.radius<p.x+p.w){
      const offset = (b.x-(p.x+p.w/2))/(p.w/2);
      const speed = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
      b.vy*=-1;
      b.vx = offset*speed;
      const maxSpeed=8;
      const currentSpeed=Math.sqrt(b.vx*b.vx+b.vy*b.vy);
      if(currentSpeed>maxSpeed){ const f=maxSpeed/currentSpeed; b.vx*=f; b.vy*=f; }
      if(i===0) b.y = p.y + p.h + b.radius;
      else b.y = p.y - b.radius;
    }
  });

  // گل زدن
  if(b.y>GAME_H){
    state.scores[0]+=1;
    resetBall();
  }
  if(b.y<0){
    state.scores[1]+=1;
    resetBall();
  }

  broadcast({type:'state', state});
}, 1000/60);
