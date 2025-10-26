// config.js

// --- سرور ---
export const PORT = process.env.PORT || 8080;

// --- ابعاد بازی ---
export const GAME_W = 450;
export const GAME_H = 800;

// --- توپ ---
export const BASE_BALL_SPEED = 8;
export const MAX_SPEED = 12;
export const BALL_RADIUS = 15;

// --- بازی ---
export const MAX_SCORE = 5; // امتیاز مورد نیاز برای پایان بازی
export const TICK_HZ = 50;  // فریم سرور
export const HEARTBEAT_MS = 10000; // فاصله پینگ پونگ سرور
export const MAX_MISSED_PONG = 3;

// --- لابی / اتاق‌ها ---
export const TOTAL_ROOMS = 10; // تعداد کل اتاق‌ها

// ایجاد ۱۰ اتاق اولیه
export let rooms = Array.from({ length: TOTAL_ROOMS }).map(() => ({
  status: 'empty',   // empty | waiting | playing
  player1: null,     // { name, id }
  player2: null,     // { name, id }
  scores: [0, 0],    // امتیازات
}));

// --- توابع مدیریت لابی ---
export function createLobby() {
  return rooms;
}

export function joinLobby(roomId, playerName, playerId) {
  const room = rooms[roomId];
  if (!room) return null;
  if (room.status === 'empty') {
    room.status = 'waiting';
    room.player1 = { name: playerName, id: playerId };
  } else if (room.status === 'waiting') {
    room.status = 'playing';
    room.player2 = { name: playerName, id: playerId };
    room.scores = [0, 0];
  }
  return room;
}

export function removePlayerFromLobby(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.player1 && room.player1.id === playerId) {
    room.player1 = null;
  } else if (room.player2 && room.player2.id === playerId) {
    room.player2 = null;
  }
  if (!room.player1 && !room.player2) {
    room.status = 'empty';
  } else if (room.player1 && !room.player2) {
    room.status = 'waiting';
  }
}

export function getLobbySnapshot() {
  return rooms.map((room, index) => ({
    id: index,
    status: room.status,
    player1: room.player1,
    player2: room.player2,
    scores: room.scores,
  }));
}
