// server.js
const WebSocket = require('ws');

const LOGICAL_W = 450;
const LOGICAL_H = 800;

const PADDLE_W = 100;
const PADDLE_H = 20;
const BALL_RADIUS = 10;
const BALL_SPEED = 6;

const wss = new WebSocket.Server({ port: 8080 });
console.log("WebSocket سرور روی پورت 8080 فعال است.");

let waitingPlayer = null;
let games = [];

function createGame(player1, player2){
  const state = {
    paddles: [
      { x: LOGICAL_W/2 - PADDLE_W/2, y: 10, w: PADDLE_W, h: PADDLE_H },
      { x: LOGICAL_W/2 - PADDLE_W/2, y: LOGICAL_H - PADDLE_H - 10, w: PADDLE_W, h: PADDLE_H }
    ],
    ball: { x: LOGICAL_W/2, y: LOGICAL_H/2, vx: BALL_SPEED*(Math.random()>0.5?1:-1), vy: BALL_SPEED*(Math.random()>0.5?1:-1), radius: BALL_RADIUS },
    scores: [0,0]
  };
  return { players:[player1,player2], state };
}

// ارسال وضعیت بازی به دو بازیکن
function broadcastGame(game){
  const msg = JSON.stringify({type:'state', state:game.state});
  game.players.forEach(p=>{ if(p.readyState===WebSocket.OPEN) p.send(msg); });
}

// حرکت توپ و برخوردها
function updateGame(game){
  const b = game.state.ball;
  const speed = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
  b.x += b.vx;
  b.y += b.vy;

  // برخورد با دیواره‌ها
  if(b.x - b.radius < 0){ b.x=b.radius; b.vx*=-1; }
  if(b.x + b.radius > LOGICAL_W){ b.x=LOGICAL_W-b.radius; b.vx*=-1; }

  // برخورد با پدل‌ها
  game.state.paddles.forEach((p,i)=>{
    if(b.y + b.radius >= p.y && b.y - b.radius <= p.y+p.h && b.x + b.radius >= p.x && b.x - b.radius <= p.x + p.w){
      // فاصله از مرکز پدل
      const offset = (b.x - (p.x + p.w/2)) / (p.w/2); // -1 تا 1
      const angle = offset * (Math.PI/3); // حداکثر ±60 درجه

      const newSpeed = Math.min(8, speed + 0.5); // کمی افزایش سرعت
      const dir = i===0?1:-1; // بالا به پایین یا پایین به بالا

      b.vx = newSpeed * Math.sin(angle);
      b.vy = dir * newSpeed * Math.cos(angle);

      // جای توپ برای جلوگیری از گیر کردن
      if(i===0) b.y = p.y + p.h + b.radius;
      else b.y = p.y - b.radius;
    }
  });

  // گل شدن
  if(b.y < 0){ game.state.scores[1]++; resetBall(game.state,1); }
  if(b.y > LOGICAL_H){ game.state.scores[0]++; resetBall(game.state,0); }
}


// ریست توپ
function resetBall(state, scorer){
  state.ball.x = LOGICAL_W/2;
  state.ball.y = LOGICAL_H/2;
  state.ball.vx = BALL_SPEED*(Math.random()>0.5?1:-1);
  state.ball.vy = BALL_SPEED*(scorer===0?-1:1);
}

// WebSocket
wss.on('connection', ws=>{
  ws.on('message', message=>{
    let data;
    try{ data = JSON.parse(message); }catch(e){return;}

    switch(data.type){
      case 'checkWaiting':
        if(waitingPlayer && waitingPlayer.readyState===WebSocket.OPEN){
          ws.send(JSON.stringify({type:'opponent_waiting'}));
        } else {
          ws.send(JSON.stringify({type:'assign', playerId:0}));
        }
        break;
      case 'waitForPlayer':
        if(waitingPlayer && waitingPlayer!==ws && waitingPlayer.readyState===WebSocket.OPEN){
          // شروع بازی
          const game = createGame(waitingPlayer, ws);
          games.push(game);
          waitingPlayer.send(JSON.stringify({type:'start'}));
          ws.send(JSON.stringify({type:'start'}));
          waitingPlayer = null;
        } else {
          waitingPlayer = ws;
          ws.send(JSON.stringify({type:'waiting_for_opponent'}));
        }
        break;
      case 'acceptMatch':
        // بازی از قبل شروع شده
        break;
      case 'declineMatch':
        waitingPlayer=null;
        break;
      case 'paddle':
        const game = games.find(g=>g.players.includes(ws));
        if(game && typeof data.x==='number'){
          const idx = game.players.indexOf(ws);
          game.state.paddles[idx].x = Math.max(0, Math.min(LOGICAL_W - PADDLE_W, data.x));
        }
        break;
    }
  });

  ws.on('close',()=>{
    if(waitingPlayer===ws) waitingPlayer=null;
    // حذف از بازی‌ها
    games = games.filter(g=>!g.players.includes(ws));
  });
});

// حلقه اصلی بازی
setInterval(()=>{
  games.forEach(game=>{
    updateGame(game);
    broadcastGame(game);
  });
}, 1000/30); // ۶۰ FPS

