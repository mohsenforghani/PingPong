// Importing required modules
const WebSocket = require('ws');
const config = require('./config'); // Importing configuration file

// Setup WebSocket server
const wss = new WebSocket.Server({ port: config.SERVER_PORT });
console.log(`Server is running on ws://localhost:${config.SERVER_PORT}`);

// Variables for managing rooms and players
let rooms = [];  // List to keep track of rooms and their statuses

// Initialize rooms
for (let i = 0; i < config.MAX_ROOMS; i++) {
  rooms.push({
    id: i,
    player1: null,
    player2: null,
    status: 'empty', // 'empty', 'waiting', 'playing'
    scores: [0, 0]
  });
}

// Handle incoming WebSocket connections
wss.on('connection', (ws) => {
  let currentRoom = null;
  let clientId = Date.now();  // Generate a simple unique client ID
  let playerName = 'Unknown';  // Default name until the player sets it

  console.log(`Client ${clientId} connected`);

  // Send assigned client ID
  ws.send(JSON.stringify({ type: 'assigned', clientId }));

  // Handle incoming messages from client
  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    const { type, roomId, name } = data;

    if (type === 'setName') {
      playerName = name;
      console.log(`Player ${clientId} set their name to: ${name}`);
      ws.send(JSON.stringify({ type: 'joined', name }));
      return;
    }

    if (type === 'requestLobby') {
      // Send a snapshot of all the rooms
      ws.send(JSON.stringify({
        type: 'lobbySnapshot',
        rooms: rooms.map((room) => ({
          id: room.id,
          status: room.status,
          player1: room.player1 ? room.player1.name : null,
          player2: room.player2 ? room.player2.name : null,
          scores: room.scores,
        }))
      }));
      return;
    }

    if (type === 'requestRoom') {
      // Handle player requesting a room to join
      if (rooms[roomId].status === 'empty') {
        rooms[roomId].status = 'waiting';
        rooms[roomId].player1 = { id: clientId, name: playerName };
        ws.send(JSON.stringify({ type: 'roomRequested', roomId }));
        return;
      }

      if (rooms[roomId].status === 'waiting' && rooms[roomId].player1.id !== clientId) {
        // Room is waiting for a second player, join the room
        rooms[roomId].status = 'playing';
        rooms[roomId].player2 = { id: clientId, name: playerName };
        ws.send(JSON.stringify({ type: 'start', roomId, playerIndex: 1 }));

        // Notify the first player that the second player has joined
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'start', roomId, playerIndex: 0 }));
          }
        });
      }
      return;
    }

    if (type === 'gameState') {
      // Update game state (ball position, paddles, etc.)
      if (rooms[roomId].status === 'playing') {
        rooms[roomId].scores = data.scores;  // Update the scores
        // Broadcast the game state to both players
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'state',
              roomId,
              state: data.state,
              scores: rooms[roomId].scores
            }));
          }
        });
      }
      return;
    }

    if (type === 'gameOver') {
      // Handle game over
      const winner = data.winner;
      const room = rooms[roomId];
      room.status = 'empty'; // Reset room status
      room.player1 = null;
      room.player2 = null;

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'gameover',
            winner,
            scores: room.scores
          }));
        }
      });
      return;
    }

    if (type === 'rematchRequested') {
      // Handle rematch request
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'rematchRequested' }));
        }
      });
      return;
    }

    if (type === 'rematchAccepted') {
      // Handle rematch acceptance
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'rematchAccepted' }));
        }
      });
      return;
    }

    if (type === 'leaveRoom') {
      // Player leaves the room
      rooms[roomId].status = 'empty';
      rooms[roomId].player1 = null;
      rooms[roomId].player2 = null;
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'opponent_left' }));
        }
      });
      return;
    }
  });

  // Handle connection close
  ws.on('close', () => {
    console.log(`Client ${clientId} disconnected`);
    // Handle disconnection logic here if necessary (e.g., cleaning up rooms)
  });
});
