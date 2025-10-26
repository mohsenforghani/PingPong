'use strict';

const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// --- تنظیمات بازی ---
const GAME_W = 450;
const GAME_H = 800;
const TICK_HZ = 50;
const BASE_BALL_SPEED = 8;
const HEARTBEAT_MS = 10000;
const MAX_SCORE = 5;

// --- سرور HTTP ساده برای سرو فایل‌های html و js ---
const server = http.createServer((req, res) => {
    let parsed = url.parse(req.url);
    let pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    const ext = path.extname(pathname);
    let contentType = 'text/html';
    if (ext === '.js') contentType = 'application/javascript';
    if (ext === '.css') contentType = 'text/css';

    const filePath = path.join(__dirname, pathname);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));

// --- WebSocket ---
const wss = new WebSocket.Server({ server });

// --- داده‌های لابی و اتاق‌ها ---
let rooms = Array.from({ length: 10 }).map(() => ({
    status: 'empty',      // empty / waiting / playing / finished
    player1: null,        // { ws, name, paddleX }
    player2: null,
    scores: [0, 0],
    ball: null,
    loop: null,
    rematchRequests: {}
}));

// --- کمکی‌ها ---
function send(ws, obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    obj.meta = { ts: Date.now() };
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
    if (!room || room.status !== 'playing') return;

    const b = room.ball;
    b.x += b.vx;
    b.y += b.vy;

    // برخورد با دیواره‌ها
    if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
    if (b.x + b.r > GAME_W) { b.x = GAME_W - b.r; b.vx = -Math.abs(b.vx); }

    // برخورد با پدل‌ها
    if (room.player1 && room.player1.paddleX !== undefined) {
        const p = { x: room.player1.paddleX, y: 20, w: 100, h: 20 };
        if (b.y - b.r < p.y + p.h && b.y + b.r > p.y &&
            b.x + b.r > p.x && b.x - b.r < p.x + p.w) {
            b.vy = Math.abs(b.vy);
        }
    }
    if (room.player2 && room.player2.paddleX !== undefined) {
        const p = { x: room.player2.paddleX, y: GAME_H - 50, w: 100, h: 20 };
        if (b.y + b.r > p.y && b.y - b.r < p.y + p.h &&
            b.x + b.r > p.x && b.x - b.r < p.x + p.w) {
            b.vy = -Math.abs(b.vy);
        }
    }

    // امتیازدهی
    if (b.y < -10) { room.scores[1]++; checkGameOver(roomId); resetBall(room); }
    if (b.y > GAME_H + 10) { room.scores[0]++; checkGameOver(roomId); resetBall(room); }

    const statePayload = {
        type: 'state',
        state: {
            ball: { x: +b.x.toFixed(2), y: +b.y.toFixed(2), r: b.r },
            paddles: [
                { x: room.player1?.paddleX || 0, y: 20, w: 100, h: 20 },
                { x: room.player2?.paddleX || 0, y: GAME_H - 50, w: 100, h: 20 }
            ],
            scores: room.scores
        },
        meta: { ts: Date.now() }
    };

    if (room.player1) send(room.player1.ws, statePayload);
    if (room.player2) send(room.player2.ws, statePayload);
}

function checkGameOver(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.scores[0] >= MAX_SCORE || room.scores[1] >= MAX_SCORE) {
        room.status = 'finished';
        if (room.player1) send(room.player1.ws, { type: 'gameover', scores: room.scores, winner: room.scores[0] >= MAX_SCORE ? 0 : 1 });
        if (room.player2) send(room.player2.ws, { type: 'gameover', scores: room.scores, winner: room.scores[1] >= MAX_SCORE ? 1 : 0 });
        clearInterval(room.loop);
        room.loop = null;
        broadcastLobby();
    }
}

// --- مدیریت اتصال کلاینت‌ها ---
wss.on('connection', ws => {
    ws._meta = { name: null, roomId: null, missedPongs: 0 };

    send(ws, { type: 'requestName', message: 'لطفاً نام خود را وارد کنید' });

    ws.on('message', msg => {
        let data;
        try { data = JSON.parse(msg); } catch { return; }

        switch (data.type) {
            case 'setName':
                ws._meta.name = data.name;
                send(ws, { type: 'joined', name: data.name });
                broadcastLobby();
                break;

            case 'requestRoom':
                const rid = data.roomId;
                if (rid < 0 || rid >= rooms.length) return;
                const room = rooms[rid];

                if (room.status === 'empty') {
                    room.status = 'waiting';
                    room.player1 = { ws, name: ws._meta.name, paddleX: GAME_W / 2 - 50 };
                    ws._meta.roomId = rid;
                    send(ws, { type: 'roomRequested', roomId: rid });
                    broadcastLobby();
                } else if (room.status === 'waiting') {
                    room.status = 'playing';
                    room.player2 = { ws, name: ws._meta.name, paddleX: GAME_W / 2 - 50 };
                    ws._meta.roomId = rid;
                    room.scores = [0, 0];
                    resetBall(room);

                    send(room.player1.ws, { type: 'start', playerIndex: 0, roomId: rid });
                    send(room.player2.ws, { type: 'start', playerIndex: 1, roomId: rid });

                    room.loop = setInterval(() => gameLoop(rid), 1000 / TICK_HZ);
                    broadcastLobby();
                }
                break;

            case 'paddle':
                const x = Number(data.x);
                if (!Number.isFinite(x)) return;
                const r = ws._meta.roomId;
                if (r === null) return;
                const rm = rooms[r];
                if (rm.status !== 'playing') return;
                if (rm.player1 && rm.player1.ws === ws) rm.player1.paddleX = x;
                if (rm.player2 && rm.player2.ws === ws) rm.player2.paddleX = x;
                break;

            case 'rematch':
                const rematchRoom = rooms[ws._meta.roomId];
                if (!rematchRoom) return;
                if (!rematchRoom.rematchRequests) rematchRoom.rematchRequests = {};
                rematchRoom.rematchRequests[ws._meta.name] = true;

                if (rematchRoom.player1 && rematchRoom.player2 &&
                    rematchRoom.rematchRequests[rematchRoom.player1.name] &&
                    rematchRoom.rematchRequests[rematchRoom.player2.name]) {
                    resetBall(rematchRoom);
                    rematchRoom.scores = [0, 0];
                    send(rematchRoom.player1.ws, { type: 'start', playerIndex: 0, roomId: ws._meta.roomId });
                    send(rematchRoom.player2.ws, { type: 'start', playerIndex: 1, roomId: ws._meta.roomId });
                }
                break;
        }
    });

    ws.on('close', () => {
        const roomId = ws._meta.roomId;
        if (roomId !== null) {
            const room = rooms[roomId];
            if (room.player1?.ws === ws) room.player1 = null;
            if (room.player2?.ws === ws) room.player2 = null;
            room.status = 'empty';
            broadcastLobby();
        }
    });
});
