'use strict';

const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });
console.log('WebSocket server running on port', PORT);

// --- تنظیمات بازی ---
const GAME_W = 450;
const GAME_H = 800;
const TICK_HZ = 50;
const BASE_BALL_SPEED = 8;
const MAX_SPEED = 12;
const HEARTBEAT_MS = 10000;
const MAX_SCORE = 5;

// --- متغیرها ---
let nextPlayerId = 1;

// --- اتاق‌ها ---
let rooms = Array.from({ length: 10 }).map(() => ({
    status: 'empty',        // empty / waiting / playing / finished
    player1: null,          // { ws, name, paddleX, id }
    player2: null,
    scores: [0, 0],
    ball: null,
    loop: null,
    rematchRequests: {}
}));

// --- توابع کمکی ---
function send(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!obj.meta) obj.meta = {};
    obj.meta.ts = Date.now();
    ws.send(JSON.stringify(obj));
}

function broadcastLobby() {
    const snapshot = rooms.map((r, i) => ({
        id: i,
        status: r.status,
        player1: r.player1 ? r.player1.name : null,
        player2: r.player2 ? r.player2.name : null,
        scores: r.scores
    }));
    wss.clients.forEach(ws => send(ws, { type: 'lobbySnapshot', rooms: snapshot }));
}

function resetBall(room) {
    room.ball = {
        x: GAME_W / 2,
        y: GAME_H / 2,
        r: 15,
        vx: BASE_BALL_SPEED * (Math.random() < 0.5 ? 1 : -1),
        vy: BASE_BALL_SPEED * (Math.random() < 0.5 ? 1 : -1)
    };
}

// --- حلقه بازی ---
function gameLoop(roomId) {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing' || !room.ball) return;

    const b = room.ball;

    // حرکت توپ
    b.x += b.vx;
    b.y += b.vy;

    // برخورد با دیواره‌ها
    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
    if (b.x + b.r > GAME_W) { b.x = GAME_W - b.r; b.vx = -Math.abs(b.vx); }

    // برخورد با پدل‌ها
    const pad1 = room.player1 ? { x: room.player1.paddleX, y: 20, w: 100, h: 20 } : null;
    const pad2 = room.player2 ? { x: room.player2.paddleX, y: GAME_H - 50, w: 100, h: 20 } : null;

    if (pad1 && b.y - b.r < pad1.y + pad1.h &&
        b.y + b.r > pad1.y &&
        b.x + b.r > pad1.x && b.x - b.r < pad1.x + pad1.w) {
        b.vy = Math.abs(b.vy);
    }

    if (pad2 && b.y + b.r > pad2.y &&
        b.y - b.r < pad2.y + pad2.h &&
        b.x + b.r > pad2.x && b.x - b.r < pad2.x + pad2.w) {
        b.vy = -Math.abs(b.vy);
    }

    // امتیازدهی
    if (b.y < -10) {
        if (room.player2) room.scores[1]++;
        checkGameOver(roomId);
        resetBall(room);
    }

    if (b.y > GAME_H + 10) {
        if (room.player1) room.scores[0]++;
        checkGameOver(roomId);
        resetBall(room);
    }

    // ارسال وضعیت به بازیکنان
    const state = {
        type: 'state',
        state: {
            ball: { x: +b.x.toFixed(2), y: +b.y.toFixed(2), r: b.r },
            paddles: [
                pad1 || { x: 0, y: 20, w: 100, h: 20 },
                pad2 || { x: 0, y: GAME_H - 50, w: 100, h: 20 }
            ],
            scores: room.scores
        }
    };
    if (room.player1) send(room.player1.ws, state);
    if (room.player2) send(room.player2.ws, state);
}

// --- پایان بازی ---
function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.scores[0] >= MAX_SCORE || room.scores[1] >= MAX_SCORE) {
        room.status = 'finished';
        if (room.player1) send(room.player1.ws, { type:'gameover', scores: room.scores, winner: room.scores[0]>=MAX_SCORE ? 0:1 });
        if (room.player2) send(room.player2.ws, { type:'gameover', scores: room.scores, winner: room.scores[1]>=MAX_SCORE ? 1:0 });
        clearInterval(room.loop);
        room.loop = null;
        broadcastLobby();
    }
}

// --- مدیریت اتصال کلاینت ---
wss.on('connection', ws => {
    ws._meta = { name:null, roomId:null, paddleX: GAME_W/2, missedPongs:0, id: nextPlayerId++ };

    // درخواست نام بازیکن
    send(ws, { type:'requestName', message:'لطفاً نام خود را وارد کنید' });

    ws.on('message', raw => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        switch(data.type){
            case 'setName':
                if(typeof data.name!=='string') return;
                ws._meta.name = data.name;
                send(ws, { type:'joined', name:data.name });
                broadcastLobby();
                break;

            case 'requestRoom':
                const rid = data.roomId;
                if(rid<0||rid>=rooms.length) return;
                const room = rooms[rid];

                if(room.status==='empty'){
                    room.status='waiting';
                    room.player1 = { ws, name: ws._meta.name, paddleX: GAME_W/2, id: ws._meta.id };
                    ws._meta.roomId = rid;
                    send(ws, { type:'roomRequested', roomId:rid });
                    broadcastLobby();
                } else if(room.status==='waiting'){
                    room.status='playing';
                    room.player2 = { ws, name: ws._meta.name, paddleX: GAME_W/2, id: ws._meta.id };
                    ws._meta.roomId = rid;
                    room.scores=[0,0];
                    send(room.player1.ws, { type:'start', playerIndex:0, roomId:rid });
                    send(room.player2.ws, { type:'start', playerIndex:1, roomId:rid });
                    resetBall(room);
                    room.loop = setInterval(()=>gameLoop(rid),1000/TICK_HZ);
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
                    send(ws, { type:'requestCancelled' });
                    broadcastLobby();
                }
                break;

            case 'paddle':
                const x = Number(data.x);
                if(!Number.isFinite(x)) return;
                const roomIdx = ws._meta.roomId;
                if(roomIdx===null) return;
                const ro = rooms[roomIdx];
                if(ro.status!=='playing') return;
                if(ro.player1 && ro.player1.ws===ws) ro.player1.paddleX=x;
                if(ro.player2 && ro.player2.ws===ws) ro.player2.paddleX=x;
                break;

            case 'rematch':
                const rmid = ws._meta.roomId;
                if(rmid===null) return;
                const rObj = rooms[rmid];
                if(!rObj.rematchRequests) rObj.rematchRequests={};
                rObj.rematchRequests[ws._meta.id]=true;
                if(rObj.player1 && rObj.player2 &&
                   rObj.rematchRequests[rObj.player1.id] && rObj.rematchRequests[rObj.player2.id]){
                    rObj.scores=[0,0];
                    rObj.status='playing';
                    resetBall(rObj);
                    rObj.loop=setInterval(()=>gameLoop(rmid),1000/TICK_HZ);
                    send(rObj.player1.ws,{type:'rematchAccepted'});
                    send(rObj.player2.ws,{type:'rematchAccepted'});
                    rObj.rematchRequests={};
                    broadcastLobby();
                } else {
                    const other = rObj.player1.ws===ws?rObj.player2.ws:rObj.player1.ws;
                    send(other,{type:'rematchRequested'});
                }
                break;

            case 'pong':
                ws._meta.missedPongs=0;
                break;
        }
    });

    ws.on('close',()=>{
        const roomId = ws._meta.roomId;
        if(roomId!==null){
            const r = rooms[roomId];
            if(r.player1 && r.player1.ws===ws) r.player1=null;
            if(r.player2 && r.player2.ws===ws) r.player2=null;
            if(!r.player1 && !r.player2){
                r.status='empty';
                clearInterval(r.loop);
                r.loop=null;
            } else {
                const other = r.player1?r.player1.ws:r.player2?r.player2.ws:null;
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
        }catch(e){}
    });
},HEARTBEAT_MS);
