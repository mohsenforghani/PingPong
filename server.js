'use strict';

const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 8080;

const GAME_W = 450;
const GAME_H = 800;
const BASE_BALL_SPEED = 6;
const MAX_SPEED = 12;
const TICK_HZ = 50;
const HEARTBEAT_MS = 10000;
const MAX_SCORE = 5;

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// --- داده‌های اتاق‌ها ---
let rooms = Array.from({ length: 10 }).map(() => ({
    status: 'empty', // empty / waiting / playing
    player1: null,
    player2: null,
    scores: [0,0],
    ball: null,
    loop: null,
    rematchRequests: {}
}));

// --- توابع کمکی ---
function send(ws, obj){
    if(!ws || ws.readyState!==WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
}

function broadcastLobby(){
    const snapshot = rooms.map((r,i)=>({
        id:i,
        status:r.status,
        player1:r.player1?r.player1.name:null,
        player2:r.player2?r.player2.name:null,
        scores:r.scores
    }));
    wss.clients.forEach(ws => send(ws,{type:'lobbySnapshot', rooms:snapshot}));
}

function resetBall(room){
    room.ball = {
        x:GAME_W/2,
        y:GAME_H/2,
        r:15,
        vx:BASE_BALL_SPEED*(Math.random()<0.5?1:-1),
        vy:BASE_BALL_SPEED*(Math.random()<0.5?1:-1)
    };
}

// --- حلقه بازی ---
function gameLoop(roomId){
    const room = rooms[roomId];
    if(!room || room.status!=='playing') return;
    const b = room.ball;

    // حرکت توپ
    b.x += b.vx;
    b.y += b.vy;

    // برخورد با دیواره
    if(b.x-b.r<0){ b.x=b.r; b.vx=Math.abs(b.vx);}
    if(b.x+b.r>GAME_W){ b.x=GAME_W-b.r; b.vx=-Math.abs(b.vx);}

    // برخورد با پدل‌ها
    if(room.player1 && room.player1.paddleX!==undefined){
        const p = {x:room.player1.paddleX, y:20, w:100, h:20};
        if(b.y-b.r<p.y+p.h && b.y+b.r>p.y && b.x+b.r>p.x && b.x-b.r<p.x+p.w){
            b.vy=Math.abs(b.vy);
        }
    }
    if(room.player2 && room.player2.paddleX!==undefined){
        const p = {x:room.player2.paddleX, y:GAME_H-50, w:100, h:20};
        if(b.y+b.r>p.y && b.y-b.r<p.y+p.h && b.x+b.r>p.x && b.x-b.r<p.x+p.w){
            b.vy=-Math.abs(b.vy);
        }
    }

    // امتیازدهی
    if(b.y< -10){ if(room.player2) room.scores[1]++; checkGameOver(roomId); resetBall(room);}
    if(b.y> GAME_H+10){ if(room.player1) room.scores[0]++; checkGameOver(roomId); resetBall(room);}

    const statePayload={
        type:'state',
        state:{
            ball:{x:+b.x.toFixed(2),y:+b.y.toFixed(2),r:b.r},
            paddles:[
                {x:room.player1?.paddleX||0,y:20,w:100,h:20},
                {x:room.player2?.paddleX||0,y:GAME_H-50,w:100,h:20}
            ],
            scores:room.scores
        },
        meta:{ts:Date.now()}
    };
    if(room.player1) send(room.player1.ws,statePayload);
    if(room.player2) send(room.player2.ws,statePayload);
}

// --- پایان بازی ---
function checkGameOver(roomId){
    const room = rooms[roomId];
    if(!room) return;
    if(room.scores[0]>=MAX_SCORE || room.scores[1]>=MAX_SCORE){
        room.status='finished';
        if(room.player1) send(room.player1.ws,{type:'gameover', scores:room.scores, winner:room.scores[0]>=MAX_SCORE?0:1});
        if(room.player2) send(room.player2.ws,{type:'gameover', scores:room.scores, winner:room.scores[1]>=MAX_SCORE?1:0});
        clearInterval(room.loop);
        room.loop=null;
        broadcastLobby();
    }
}

// --- مدیریت اتصال ---
wss.on('connection', ws=>{
    ws._meta={name:null, roomId:null, missedPongs:0};

    send(ws,{type:'requestName', message:'لطفاً نام خود را وارد کنید'});

    ws.on('message', msg=>{
        let data; try{data=JSON.parse(msg);}catch{return;}
        switch(data.type){
            case 'setName':
                ws._meta.name=data.name;
                send(ws,{type:'joined', name:data.name});
                broadcastLobby();
                break;
            case 'requestRoom':
                const roomId = data.roomId;
                if(roomId<0 || roomId>=rooms.length) return;
                const room = rooms[roomId];

                if(room.status==='empty'){
                    room.status='waiting';
                    room.player1={ws,name:ws._meta.name};
                    ws._meta.roomId=roomId;
                    send(ws,{type:'roomRequested', roomId});
                    broadcastLobby();
                } else if(room.status==='waiting'){
                    room.status='playing';
                    room.player2={ws,name:ws._meta.name};
                    room.scores=[0,0];
                    ws._meta.roomId=roomId;
                    send(room.player1.ws,{type:'start', playerIndex:0, roomId});
                    send(room.player2.ws,{type:'start', playerIndex:1, roomId});
                    resetBall(room);
                    room.loop=setInterval(()=>gameLoop(roomId),1000/TICK_HZ);
                    broadcastLobby();
                }
                break;
            case 'cancelRequest':
                const rId = ws._meta.roomId;
                if(rId===null) return;
                const rm = rooms[rId];
                if(rm.player1 && rm.player1.ws===ws && rm.status==='waiting'){
                    rm.status='empty';
                    rm.player1=null;
                    ws._meta.roomId=null;
                    send(ws,{type:'requestCancelled'});
                    broadcastLobby();
                }
                break;
            case 'paddle':
                const px=Number(data.x);
                if(!Number.isFinite(px)) return;
                const rid=ws._meta.roomId;
                if(rid===null) return;
                const ro=rooms[rid];
                if(ro.status!=='playing') return;
                if(ro.player1 && ro.player1.ws===ws) ro.player1.paddleX=px;
                if(ro.player2 && ro.player2.ws===ws) ro.player2.paddleX=px;
                break;
            case 'rematch':
                const rematchRoom = ws._meta.roomId;
                if(rematchRoom===null) return;
                const rmObj = rooms[rematchRoom];
                if(!rmObj.rematchRequests) rmObj.rematchRequests={};
                rmObj.rematchRequests[ws._meta.name]=true;
                if(rmObj.player1 && rmObj.player2 &&
                    rmObj.rematchRequests[rmObj.player1.name] && rmObj.rematchRequests[rmObj.player2.name]){
                    rmObj.scores=[0,0];
                    resetBall(rmObj);
                    rmObj.rematchRequests={};
                    send(rmObj.player1.ws,{type:'rematchAccepted'});
                    send(rmObj.player2.ws,{type:'rematchAccepted'});
                    rmObj.loop=setInterval(()=>gameLoop(rematchRoom),1000/TICK_HZ);
                } else {
                    const other=(rmObj.player1.ws===ws?rmObj.player2.ws:rmObj.player1.ws);
                    send(other,{type:'rematchRequested'});
                }
                break;
            case 'pong':
                ws._meta.missedPongs=0;
                break;
        }
    });

    ws.on('close',()=>{
        const roomId=ws._meta.roomId;
        if(roomId!==null){
            const rm=rooms[roomId];
            if(rm.player1 && rm.player1.ws===ws) rm.player1=null;
            if(rm.player2 && rm.player2.ws===ws) rm.player2=null;
            if(!rm.player1 && !rm.player2){
                rm.status='empty';
                clearInterval(rm.loop);
                rm.loop=null;
            } else {
                const other=rm.player1?rm.player1.ws:rm.player2?rm.player2.ws:null;
                if(other) send(other,{type:'opponent_left'});
            }
            broadcastLobby();
        }
    });
    ws.on('error',()=>{});
});

// --- heartbeat ---
setInterval(()=>{
    wss.clients.forEach(ws=>{
        try{
            ws._meta.missedPongs=(ws._meta.missedPongs||0)+1;
            if(ws._meta.missedPongs>3) ws.terminate();
            else send(ws,{type:'ping', ts:Date.now()});
        }catch{}
    });
},HEARTBEAT_MS);

server.listen(PORT,()=>console.log('Server running on port',PORT));
