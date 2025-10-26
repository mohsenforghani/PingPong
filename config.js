let rooms = Array.from({ length: 10 }).map(() => ({
  status: 'empty',
  player1: null,
  player2: null,
  scores: [0, 0],
}));

function createLobby() {
  return rooms;
}

function joinLobby(roomId, playerName, playerId) {
  const room = rooms[roomId];
  if (room.status === 'empty') {
    room.status = 'waiting';
    room.player1 = { name: playerName, id: playerId };
  } else if (room.status === 'waiting') {
    room.status = 'playing';
    room.player2 = { name: playerName, id: playerId };
    room.scores = [0, 0];
  }
}

function updateLobby() {
  const lobbySnapshot = rooms.map((room, index) => ({
    id: index,
    status: room.status,
    player1: room.player1,
    player2: room.player2,
    scores: room.scores,
  }));
  return lobbySnapshot;
}

function removePlayerFromLobby(roomId, playerId) {
  const room = rooms[roomId];
  if (room.player1.id === playerId) {
    room.player1 = null;
  } else if (room.player2.id === playerId) {
    room.player2 = null;
  }
  if (!room.player1 && !room.player2) {
    room.status = 'empty';
  }
}

function getLobbySnapshot() {
  return rooms;
}

module.exports = {
  createLobby,
  joinLobby,
  updateLobby,
  removePlayerFromLobby,
  getLobbySnapshot,
};
