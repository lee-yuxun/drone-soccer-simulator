import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { doAction, gameCreate, snapshot, tickGame } from '../src/sim/game.js';
import { clamp, neutral } from '../src/sim/flight.js';
import { profiles, rolesFor, STEP } from '../src/sim/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SIM_PORT ?? 8766);
const lan = process.argv.includes('--lan');
const host = lan ? '0.0.0.0' : '127.0.0.1';
const files = /.(?:html|js|css|glb)$/;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.glb': 'model/gltf-binary' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const publicPaths = /^(?:\/(?:index|models)\.html|\/(?:src|assets)\/[^.]+\.(?:js|css|glb)|\/node_modules\/three\/(?:build|src|examples\/jsm)\/.+\.js)$/;
    const route = path === '/' ? '/index.html' : path;
    if (!files.test(route) || !publicPaths.test(route) || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404).end();
      return;
    }
    const file = resolve(root, '.' + route);
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) {
      res.writeHead(404).end();
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Content-Length': info.size,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const rooms = new Map();
const code = length => randomBytes(length).toString('hex').toUpperCase();
const send = (socket, value) => {
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 512_000) socket.send(JSON.stringify(value));
};
const error = (socket, message) => send(socket, { type: 'error', message });
const publicSeat = ({ id, team, role, ready, socket }) => ({ id, team, role, ready, online: Boolean(socket) });
const lobby = room => {
  const packet = { type: 'lobby', room: room.code, size: room.size, hostId: room.hostId,
    running: Boolean(room.game && room.game.phase !== 'finished'), hasMatch: Boolean(room.game),
    members: [...room.members.values()].map(publicSeat) };
  for (const member of room.members.values()) send(member.socket, packet);
};

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  const sameOrigin = !origin || origin === 'http://' + req.headers.host || origin === 'https://' + req.headers.host;
  if (req.url !== '/room' || !sameOrigin) { socket.destroy(); return; }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
});

function addPlayer(socket, room, token) {
  const restored = token && [...room.members.values()].find(member => member.token === token);
  if (!restored && room.members.size >= 20) return error(socket, '房間已滿。');
  const id = restored?.id ?? 'P-' + code(3);
  const member = restored ?? { id, token: code(16), team: null, role: null, ready: false };
  const oldSocket = member.socket;
  member.socket = socket;
  member.away = null;
  oldSocket?.close(4001, 'reconnected');
  room.members.set(id, member);
  socket.room = room;
  socket.player = member;
  if (!room.hostId) room.hostId = id;
  send(socket, { type: 'joined', id, room: room.code, token: member.token });
  lobby(room);
}

function leave(socket, deliberate) {
  const { room, player } = socket;
  if (!room || player.socket !== socket) return;
  socket.room = undefined;
  socket.player = undefined;
  player.input = neutral();
  player.socket = null;
  player.away = Date.now();
  if (deliberate) {
    player.token = null;
    room.members.delete(player.id);
    const drone = room.game?.drones.find(drone => drone.id === player.id);
    if (drone) { drone.ai = true; drone.active = true; }
  }
  if (room.hostId === player.id) {
    room.hostId = [...room.members.values()].find(member => member.socket)?.id ?? null;
  }
  lobby(room);
}

function limitedSettings(raw) {
  const number = (key, fallback, lo, hi) => Number.isFinite(raw?.[key]) ? clamp(raw[key], lo, hi) : fallback;
  return { sensitivity: number('sensitivity', 1, .4, 1.8), tilt: number('tilt', 34, 15, 45),
    thrust: number('thrust', 1, .7, 1.4), damping: number('damping', 1, .5, 1.7),
    stabilize: raw?.stabilize !== false };
}

function handle(socket, msg) {
  if (msg.type === 'ping') return send(socket, { type: 'pong', now: msg.now });
  if (msg.type === 'create' && !socket.room) {
    if (rooms.size >= 30) return error(socket, '房間數量已滿，請稍後重試。');
    let roomCode;
    do roomCode = code(2); while (rooms.has(roomCode));
    const room = { code: roomCode, size: msg.size === 5 ? 5 : 3, members: new Map(), created: Date.now() };
    rooms.set(room.code, room);
    return addPlayer(socket, room);
  }
  if (msg.type === 'join' && !socket.room) {
    const room = rooms.get(String(msg.room).toUpperCase());
    if (!room) return error(socket, '找不到房間。請核對房間代碼及開房裝置的網址。');
    return addPlayer(socket, room, msg.token);
  }
  const { room, player } = socket;
  if (!player) return;
  const running = room.game && room.game.phase !== 'finished';
  switch (msg.type) {
    case 'leave': leave(socket, true); break;
    case 'seat': {
      if (running) return error(socket, '比賽進行中，席位已鎖定。');
      if (msg.team === null) {
        player.team = null; player.role = null; player.ready = false; lobby(room); break;
      }
      if (![0, 1].includes(msg.team) || !rolesFor(room.size).includes(msg.role)) return error(socket, '請選擇有效席位。');
      if ([...room.members.values()].some(member => member !== player && member.team === msg.team &&
          member.role === msg.role)) return error(socket, '這個席位已由其他選手選取。');
      player.team = msg.team; player.role = msg.role; player.ready = false;
      lobby(room);
      break;
    }
    case 'size':
      if (player.id !== room.hostId || running) return;
      room.size = msg.size === 5 ? 5 : 3;
      for (const member of room.members.values()) {
        if (!rolesFor(room.size).includes(member.role)) { member.team = null; member.role = null; }
        member.ready = false;
      }
      lobby(room);
      break;
    case 'ready':
      if (!running && player.team != null) { player.ready = !player.ready; lobby(room); }
      break;
    case 'start': {
      if (player.id !== room.hostId || running) return;
      const roster = [...room.members.values()].filter(member => member.socket && member.team != null);
      if (!roster.length || roster.some(member => !member.ready)) return error(socket, '至少一名飛手入席，且所有已入席的線上飛手都須準備。');
      const profileId = Object.hasOwn(profiles, msg.profileId) && msg.profileId === 'fai-f9ab-2026' ?
        msg.profileId : 'course-' + room.size + 'v' + room.size;
      const setSeconds = [120, 180, 240, 300].includes(msg.setSeconds) ? msg.setSeconds : 180;
      const breakSeconds = [120, 150, 180, 240, 300].includes(msg.breakSeconds) ? msg.breakSeconds : 120;
      room.game = gameCreate({ mode: 'lan', size: room.size, profileId,
        settings: { height: msg.height === 4 ? 4 : 3, setSeconds, breakSeconds },
        roster: roster.map(publicSeat), difficulty: msg.difficulty });
      lobby(room);
      break;
    }
    case 'input':
      if (running && player.team != null) {
        player.input = Object.fromEntries(Object.keys(neutral()).map(axis =>
          [axis, Number.isFinite(msg.input?.[axis]) ? clamp(msg.input[axis], -1, 1) : 0]));
        player.lastInput = Date.now();
      }
      break;
    case 'control':
      player.settings = limitedSettings(msg.settings);
      break;
    case 'action':
      if (running && ['arm', 'stop', 'turtle'].includes(msg.action)) doAction(room.game, player.id, msg.action);
      break;
    case 'summary':
      if (room.game) send(socket, { type: 'summary', trace: { ...room.game.trace, samples: [],
        strikerSamples: [], events: [], goals: room.game.trace.goals.map(goal => ({ ...goal, highlight: [] })) } });
      break;
    case 'trace': {
      if (!room.game) return;
      const trace = room.game.trace;
      const goal = trace.goals.find(goal => goal.goalId === msg.goalId);
      const start = goal ? Math.min(goal.start, goal.t - 8) : undefined;
      const end = goal ? goal.t + 2 : undefined;
      const window = frame => !goal || (frame.t >= start && frame.t <= end);
      send(socket, { type: 'trace', requestId: msg.requestId, full: !goal, trace: { ...trace, strikerSamples: [],
        samples: trace.samples.filter(window), events: trace.events.filter(window), goals: goal ? [goal] : trace.goals } });
      break;
    }
    default: break;
  }
}

sockets.on('connection', socket => {
  let budget = 0;
  let windowTime = Date.now();
  socket.on('error', () => {});
  socket.on('message', raw => {
    if (Date.now() - windowTime > 1000) { windowTime = Date.now(); budget = 0; }
    if (++budget > 85) return;
    try {
      const message = JSON.parse(raw.toString());
      if (message && typeof message === 'object') handle(socket, message);
    } catch {
      error(socket, '收到了無法處理的房間資料。');
    }
  });
  socket.on('close', () => leave(socket, false));
});

let previous = performance.now();
let accumulator = 0;
let broadcast = 0;
setInterval(() => {
  const now = performance.now();
  accumulator += Math.min(.1, (now - previous) / 1000);
  previous = now;
  const wallTime = Date.now();
  while (accumulator >= STEP) {
    for (const room of rooms.values()) {
      if (room.game) {
        const inputs = {};
        for (const member of room.members.values()) {
          const drone = room.game.drones.find(drone => drone.id === member.id);
          if (drone) drone.ai = !member.socket && wallTime - member.away > 750;
          if (member.settings) room.game.seatSettings[member.id] = member.settings;
          if (member.lastInput && wallTime - member.lastInput < 350) inputs[member.id] = member.input;
        }
        tickGame(room.game, inputs);
      }
    }
    accumulator -= STEP;
    broadcast += STEP;
  }
  if (broadcast < .05) return;
  broadcast = 0;
  for (const [id, room] of rooms) {
    if (![...room.members.values()].some(member => member.socket) &&
      wallTime - Math.max(room.created, ...[...room.members.values()].map(member => member.away ?? 0)) > 150000) {
      rooms.delete(id);
      continue;
    }
    let changed = false;
    for (const [id, member] of room.members) {
      if (member.socket || wallTime - member.away < 120000) continue;
      room.members.delete(id);
      changed = true;
    }
    if (changed) lobby(room);
    if (!room.game) continue;
    if (room.phase !== room.game.phase) {
      room.phase = room.game.phase;
      if (room.phase === 'finished') lobby(room);
    }
    const packet = { type: 'state', state: snapshot(room.game) };
    for (const member of room.members.values()) send(member.socket, packet);
  }
}, 8);

server.listen(port, host, () => {
  console.log('Local: http://127.0.0.1:' + port);
  if (lan) {
    for (const info of Object.values(networkInterfaces()).flat()) {
      if (info.family === 'IPv4' && !info.internal) console.log('Wi-Fi: http://' + info.address + ':' + port);
    }
  }
});
