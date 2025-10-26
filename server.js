const WebSocket = require('ws');
const { createLobby, joinLobby, updateLobby, removePlayerFromLobby, getLobbySnapshot } = require('./config');

const wss = new WebSocket.Server({ port: 8080 });

const rooms = Array.from({ length: 10 }).map(() => ({ status: 'empty', player1: null, player2: null, scores: [0, 0] }));

wss.on('connection', (ws) => {
    let clientId = null;
    let currentRoom = null;
    let playerName = '';
    let isPlaying = false;

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const { type } = data;

        if (type === 'setName') {
            playerName = data.name;
            clientId = `${Date.now()}_${Math.random().toString(36).substring(2, 10)}`; // Random unique clientId
            ws.send(JSON.stringify({ type: 'assigned', clientId }));
            return;
        }

        if (type === 'requestRoom') {
            currentRoom = data.roomId;
            if (rooms[currentRoom].status === 'empty') {
                rooms[currentRoom].status = 'waiting';
                rooms[currentRoom].player1 = { name: playerName, id: clientId };
                updateLobby();
                ws.send(JSON.stringify({ type: 'roomRequested', roomId: currentRoom }));
            } else if (rooms[currentRoom].status === 'waiting') {
                rooms[currentRoom].status = 'playing';
                rooms[currentRoom].player2 = { name: playerName, id: clientId };
                rooms[currentRoom].scores = [0, 0];
                startGame(currentRoom);
                ws.send(JSON.stringify({ type: 'start', roomId: currentRoom, playerIndex: 1 }));
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Room already in use' }));
            }
        }

        if (type === 'requestCancelled') {
            rooms[currentRoom].status = 'empty';
            rooms[currentRoom].player1 = null;
            rooms[currentRoom].player2 = null;
            updateLobby();
            ws.send(JSON.stringify({ type: 'requestCancelled' }));
        }

        if (type === 'rematchRequested') {
            if (rooms[currentRoom].player1.id === clientId || rooms[currentRoom].player2.id === clientId) {
                ws.send(JSON.stringify({ type: 'rematchRequested', roomId: currentRoom }));
            }
        }

        if (type === 'rematchAccepted') {
            ws.send(JSON.stringify({ type: 'rematchAccepted', roomId: currentRoom }));
            startGame(currentRoom);
        }

        if (type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
        }

        // Handle ball and paddle movement (game state updates)
        if (isPlaying) {
            const gameState = data.state;
            updateGame(currentRoom, gameState);
        }
    });

    ws.on('close', () => {
        // Cleanup on client disconnect
        if (currentRoom !== null) {
            removePlayerFromLobby(currentRoom, clientId);
        }
    });

    function startGame(roomId) {
        isPlaying = true;
        rooms[roomId].scores = [0, 0];
        ws.send(JSON.stringify({ type: 'start', roomId, playerIndex: 1 }));
    }

    function updateGame(roomId, gameState) {
        if (!gameState) return;
        rooms[roomId].scores = gameState.scores;
        ws.send(JSON.stringify({ type: 'state', roomId, state: gameState }));
    }

    function updateLobby() {
        const snapshot = rooms.map((room, index) => ({
            id: index,
            status: room.status,
            player1: room.player1,
            player2: room.player2,
            scores: room.scores,
        }));
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'lobbySnapshot', rooms: snapshot }));
            }
        });
    }
});

console.log('Server running on ws://localhost:8080');
