const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

console.log("Server running on port", PORT);

let players = [];
let scores = [0, 0];
let ball = { x: 400, y: 300, vx: 5, vy: 3, radius: 10 };
let paddles = [
    { x: 50, y: 250, w: 20, h: 100 },
    { x: 730, y: 250, w: 20, h: 100 }
];

const FPS = 60;
const INTERVAL = 1000 / FPS;

wss.on('connection', ws => {
    if(players.length >= 2){
        ws.send(JSON.stringify({message:"Game Full"}));
        ws.close();
        return;
    }

    let playerId = players.length;
    players.push(ws);
    ws.send(JSON.stringify({playerId}));

    ws.on('message', msg => {
        try{
            let data = JSON.parse(msg);
            if(data.player !== undefined && data.y !== undefined){
                paddles[data.player].y = Math.max(0, Math.min(600 - paddles[data.player].h, data.y));
            }
        } catch(e){ console.log("Invalid message:", e); }
    });

    ws.on('close', () => {
        players = players.filter(p => p !== ws);
        resetGame();
    });

    if(players.length === 2){
        startGame();
    }
});

let gameInterval = null;
function startGame(){
    if(gameInterval) clearInterval(gameInterval);
    gameInterval = setInterval(gameLoop, INTERVAL);
}

function gameLoop(){
    moveBall();
    checkCollisions();
    broadcastGameState();
}

function moveBall(){
    ball.x += ball.vx;
    ball.y += ball.vy;

    if(ball.y - ball.radius <= 0 || ball.y + ball.radius >= 600) ball.vy = -ball.vy;

    if(ball.x - ball.radius <= 0){ scores[1]++; resetBall(); }
    if(ball.x + ball.radius >= 800){ scores[0]++; resetBall(); }
}

function checkCollisions(){
    paddles.forEach(p => {
        if(ball.x + ball.radius >= p.x && ball.x - ball.radius <= p.x + p.w &&
           ball.y + ball.radius >= p.y && ball.y - ball.radius <= p.y + p.h){
            if(ball.vx > 0) ball.x = p.x - ball.radius;
            else ball.x = p.x + p.w + ball.radius;

            ball.vx = -ball.vx * 0.98; // اصطکاک
            ball.vy = ball.vy * 0.98;

            ball.vy += ((p.y + p.h/2) - ball.y) * 0.05; // اثر سرعت راکت
        }
    });
}

function broadcastGameState(){
    const state = { ball, paddles, scores };
    const msg = JSON.stringify(state);
    players.forEach(p => { if(p.readyState===WebSocket.OPEN) p.send(msg); });
}

function resetBall(){
    ball.x = 400; ball.y = 300;
    ball.vx = Math.random() > 0.5 ? 5 : -5;
    ball.vy = (Math.random() * 4) - 2;
}

function resetGame(){
    scores = [0,0];
    ball = { x: 400, y: 300, vx: 5, vy: 3, radius: 10 };
    paddles = [
        { x: 50, y: 250, w: 20, h: 100 },
        { x: 730, y: 250, w: 20, h: 100 }
    ];
    if(gameInterval) clearInterval(gameInterval);
}
