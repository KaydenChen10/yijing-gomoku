const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_TTL = 12 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const BOARD_SIZE = 15;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求格式错误"));
      }
    });
    req.on("error", reject);
  });
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function randomCode(length = 6) {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function uniqueRoomCode() {
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  return code;
}

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function createRoom() {
  const code = uniqueRoomCode();
  const room = {
    code,
    players: { black: null, white: null },
    members: new Map(),
    clients: new Map(),
    board: createEmptyBoard(),
    moves: [],
    messages: [],
    status: "waiting",
    currentTurn: null,
    winner: null,
    winningLine: [],
    reason: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    lastActivity: Date.now(),
    round: 1,
    version: 1
  };
  rooms.set(code, room);
  addSystemMessage(room, "房间已创建，等待另一位棋手加入。");
  return room;
}

function addSystemMessage(room, text) {
  room.messages.push({
    id: crypto.randomUUID(),
    kind: "system",
    text,
    at: Date.now()
  });
  if (room.messages.length > 100) room.messages.shift();
}

function touch(room) {
  room.lastActivity = Date.now();
  room.version += 1;
}

function playerByToken(room, token) {
  if (!token) return null;
  const member = room.members.get(token);
  if (!member || !member.seat) return null;
  return member;
}

function isTokenOnline(room, token) {
  for (const client of room.clients.values()) {
    if (client.token === token && !client.res.destroyed) return true;
  }
  return false;
}

function publicRoom(room) {
  const spectatorTokens = new Set();
  for (const client of room.clients.values()) {
    if (client.token && !playerByToken(room, client.token)) spectatorTokens.add(client.token);
  }

  return {
    code: room.code,
    status: room.status,
    players: {
      black: room.players.black
        ? {
            name: room.players.black.name,
            seat: "black",
            ready: room.players.black.ready,
            rematch: room.players.black.rematch,
            online: isTokenOnline(room, room.players.black.token)
          }
        : null,
      white: room.players.white
        ? {
            name: room.players.white.name,
            seat: "white",
            ready: room.players.white.ready,
            rematch: room.players.white.rematch,
            online: isTokenOnline(room, room.players.white.token)
          }
        : null
    },
    spectators: spectatorTokens.size,
    board: room.board,
    moves: room.moves.map((move) => ({
      number: move.number,
      seat: move.seat,
      row: move.row,
      col: move.col,
      at: move.at
    })),
    messages: room.messages.slice(-60),
    currentTurn: room.currentTurn,
    winner: room.winner,
    winningLine: room.winningLine,
    reason: room.reason,
    round: room.round,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    serverNow: Date.now(),
    version: room.version
  };
}

function sendEvent(res, event, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room) {
  if (!rooms.has(room.code)) return;
  const payload = publicRoom(room);
  for (const [clientId, client] of room.clients) {
    if (client.res.destroyed || client.res.writableEnded) {
      room.clients.delete(clientId);
      continue;
    }
    sendEvent(client.res, "room", payload);
  }
}

function startRound(room, isRematch = false) {
  if (isRematch) {
    const black = room.players.black;
    const white = room.players.white;
    if (!black || !white) return false;
    black.seat = "white";
    white.seat = "black";
    room.players.black = white;
    room.players.white = black;
    room.round += 1;
  }

  room.board = createEmptyBoard();
  room.moves = [];
  room.status = "playing";
  room.currentTurn = "black";
  room.winner = null;
  room.winningLine = [];
  room.reason = null;
  room.startedAt = Date.now();
  room.endedAt = null;
  for (const player of [room.players.black, room.players.white]) {
    if (player) {
      player.ready = false;
      player.rematch = false;
    }
  }
  addSystemMessage(
    room,
    isRematch
      ? `第 ${room.round} 局开始，双方交换执子，黑棋先行。`
      : "双方已就绪，对局开始，黑棋先行。"
  );
  touch(room);
  broadcast(room);
  return true;
}

function checkWin(board, row, col, seat) {
  const directions = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1]
  ];

  for (const [dr, dc] of directions) {
    const line = [{ row, col }];
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (
        r >= 0 &&
        r < BOARD_SIZE &&
        c >= 0 &&
        c < BOARD_SIZE &&
        board[r][c] === seat
      ) {
        if (sign === -1) line.unshift({ row: r, col: c });
        else line.push({ row: r, col: c });
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

async function handleCreate(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return fail(res, 400, error.message);
  }
  const room = createRoom();
  const name = cleanText(body.name, 16) || `棋手${crypto.randomInt(10, 99)}`;
  const member = makeMember(room, name);
  const token = member.token;
  json(res, 201, { room: publicRoom(room), token, seat: member.seat, roomCode: room.code });
}

function makeMember(room, name) {
  let seat = null;
  if (!room.players.black) seat = "black";
  else if (!room.players.white) seat = "white";

  const token = crypto.randomBytes(24).toString("base64url");
  const member = {
    token,
    name,
    seat,
    ready: false,
    rematch: false,
    joinedAt: Date.now(),
    lastChatAt: 0
  };
  room.members.set(token, member);
  if (seat) {
    room.players[seat] = member;
    addSystemMessage(room, `${name} 执${seat === "black" ? "黑" : "白"}加入了对局。`);
  } else {
    addSystemMessage(room, `${name} 进入房间观战。`);
  }
  touch(room);
  return member;
}

async function handleJoin(req, res, room) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  const suppliedToken = cleanText(body.token, 128);
  const name = cleanText(body.name, 16) || `棋手${crypto.randomInt(10, 99)}`;
  let member = suppliedToken ? room.members.get(suppliedToken) : null;

  if (member) {
    if (name && name !== member.name) member.name = name;
    if (member.seat) {
      const seatName = member.seat === "black" ? "黑棋" : "白棋";
      addSystemMessage(room, `${member.name} 重新连接，继续执${seatName}。`);
    }
  } else {
    member = makeMember(room, name);
  }

  touch(room);
  broadcast(room);
  json(res, 200, { room: publicRoom(room), token: member.token, seat: member.seat });
}

async function handleReady(req, res, room) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  const player = playerByToken(room, cleanText(body.token, 128));
  if (!player) return fail(res, 403, "只有已入座的棋手可以准备");
  if (room.status !== "waiting") return fail(res, 409, "当前对局不能准备");
  if (!room.players.black || !room.players.white) {
    return fail(res, 409, "请等待另一位棋手入座");
  }

  player.ready = Boolean(body.ready);
  touch(room);
  broadcast(room);

  if (room.players.black.ready && room.players.white.ready) {
    startRound(room, false);
  }
  json(res, 200, { room: publicRoom(room) });
}

async function handleMove(req, res, room) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  const player = playerByToken(room, cleanText(body.token, 128));
  if (!player) return fail(res, 403, "你还没有入座");
  if (room.status !== "playing") return fail(res, 409, "对局尚未开始或已经结束");
  if (room.currentTurn !== player.seat) return fail(res, 409, "还没有轮到你落子");

  const row = Number(body.row);
  const col = Number(body.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    return fail(res, 400, "落子位置无效");
  }
  if (room.board[row][col] !== null) return fail(res, 409, "这里已经有棋子了");

  room.board[row][col] = player.seat;
  room.moves.push({
    number: room.moves.length + 1,
    seat: player.seat,
    row,
    col,
    at: Date.now()
  });

  const winningLine = checkWin(room.board, row, col, player.seat);
  if (winningLine) {
    room.status = "finished";
    room.winner = player.seat;
    room.winningLine = winningLine;
    room.reason = "five";
    room.currentTurn = null;
    room.endedAt = Date.now();
    const color = player.seat === "black" ? "黑棋" : "白棋";
    addSystemMessage(room, `${player.name} 以${color}五子连珠，赢下本局。`);
  } else if (room.moves.length === BOARD_SIZE * BOARD_SIZE) {
    room.status = "finished";
    room.winner = "draw";
    room.winningLine = [];
    room.reason = "draw";
    room.currentTurn = null;
    room.endedAt = Date.now();
    addSystemMessage(room, "棋盘已满，本局和棋。");
  } else {
    room.currentTurn = player.seat === "black" ? "white" : "black";
  }

  touch(room);
  broadcast(room);
  json(res, 200, { room: publicRoom(room) });
}

async function handleRematch(req, res, room) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  const player = playerByToken(room, cleanText(body.token, 128));
  if (!player) return fail(res, 403, "只有棋手可以发起再来一局");
  if (room.status !== "finished") return fail(res, 409, "当前不能再来一局");
  if (!room.players.black || !room.players.white) return fail(res, 409, "需要两位棋手才能继续");

  player.rematch = true;
  touch(room);
  broadcast(room);

  if (room.players.black.rematch && room.players.white.rematch) {
    startRound(room, true);
  }
  json(res, 200, { room: publicRoom(room) });
}

async function handleChat(req, res, room) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  const member = room.members.get(cleanText(body.token, 128));
  if (!member) return fail(res, 403, "请先加入房间");
  const text = cleanText(body.text, 120);
  if (!text) return fail(res, 400, "消息不能为空");
  if (Date.now() - member.lastChatAt < 300) return fail(res, 429, "发言太快了，请稍后再试");
  member.lastChatAt = Date.now();

  room.messages.push({
    id: crypto.randomUUID(),
    kind: "chat",
    name: member.name,
    seat: member.seat,
    text,
    at: Date.now()
  });
  if (room.messages.length > 100) room.messages.shift();
  touch(room);
  broadcast(room);
  json(res, 201, { ok: true });
}

async function handleLeave(req, res, room) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return fail(res, 400, error.message);
  }

  const token = cleanText(body.token, 128);
  const member = room.members.get(token);
  if (!member) return json(res, 200, { ok: true });

  const name = member.name;
  const seat = member.seat;
  room.members.delete(token);

  if (seat) {
    const otherSeat = seat === "black" ? "white" : "black";
    const other = room.players[otherSeat];
    room.players[seat] = null;

    if (room.status === "playing") {
      room.status = "finished";
      room.currentTurn = null;
      room.endedAt = Date.now();
      room.reason = "abandoned";
      room.winner = other ? otherSeat : "draw";
      room.winningLine = [];
      addSystemMessage(room, `${name} 离开了棋局，对局结束。`);
    } else {
      addSystemMessage(room, `${name} 离开了房间。`);
      if (room.status === "waiting") {
        room.players.black && (room.players.black.ready = false);
        room.players.white && (room.players.white.ready = false);
      }
    }
    if (other) other.rematch = false;
  } else {
    addSystemMessage(room, `${name} 离开了房间。`);
  }

  touch(room);
  if (room.players.black || room.players.white) {
    broadcast(room);
  } else {
    rooms.delete(room.code);
  }
  json(res, 200, { ok: true });
}

function handleEvents(req, res, room, url) {
  const token = cleanText(url.searchParams.get("token"), 128);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff"
  });
  res.write("retry: 2000\n");
  res.write(": connected\n\n");
  if (res.flushHeaders) res.flushHeaders();

  const clientId = crypto.randomUUID();
  room.clients.set(clientId, { res, token });
  sendEvent(res, "room", publicRoom(room));
  broadcast(room);

  const pingTimer = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
  }, 15000);

  const cleanup = () => {
    clearInterval(pingTimer);
    room.clients.delete(clientId);
    if (rooms.has(room.code)) broadcast(room);
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("error", cleanup);
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(requested);
  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return fail(res, 403, "禁止访问");
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      return fail(res, 404, "页面不存在");
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const headers = {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin"
    };
    if (ext === ".html") headers["Cache-Control"] = "no-cache";
    else headers["Cache-Control"] = "public, max-age=3600";
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function getLanUrls() {
  const urls = [];
  for (const values of Object.values(os.networkInterfaces())) {
    for (const item of values || []) {
      if (item.family === "IPv4" && !item.internal) {
        urls.push(`http://${item.address}:${PORT}`);
      }
    }
  }
  return urls;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return fail(res, 400, "无效请求");
  }
  const pathname = url.pathname;

  try {
    if (pathname === "/health") {
      return json(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() });
    }

    if (req.method === "POST" && pathname === "/api/rooms") {
      return await handleCreate(req, res);
    }

    const roomMatch = pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,12})(?:\/(events|join|ready|move|rematch|chat|leave))?$/);
    if (roomMatch) {
      const code = roomMatch[1].toUpperCase();
      const action = roomMatch[2] || null;
      const room = rooms.get(code);

      if (req.method === "GET" && action === null) {
        if (!room) return fail(res, 404, "房间不存在或已过期");
        return json(res, 200, { room: publicRoom(room) });
      }

      if (req.method === "GET" && action === "events") {
        if (!room) return fail(res, 404, "房间不存在或已过期");
        return handleEvents(req, res, room, url);
      }

      if (!room) return fail(res, 404, "房间不存在或已过期");

      if (req.method !== "POST") return fail(res, 405, "请求方法不支持");
      if (action === "join") return await handleJoin(req, res, room);
      if (action === "ready") return await handleReady(req, res, room);
      if (action === "move") return await handleMove(req, res, room);
      if (action === "rematch") return await handleRematch(req, res, room);
      if (action === "chat") return await handleChat(req, res, room);
      if (action === "leave") return await handleLeave(req, res, room);
      return fail(res, 404, "接口不存在");
    }

    if (pathname.startsWith("/api/")) return fail(res, 404, "接口不存在");
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
    return fail(res, 405, "请求方法不支持");
  } catch (error) {
    console.error("[server]", error);
    if (!res.headersSent) fail(res, 500, "服务器开小差了，请稍后重试");
    else res.end();
  }
});

setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL;
  for (const [code, room] of rooms) {
    if (room.lastActivity < cutoff && room.clients.size === 0) rooms.delete(code);
  }
}, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  弈境 · 五子棋联机平台已启动");
  console.log(`  本机访问: http://localhost:${PORT}`);
  for (const url of getLanUrls()) console.log(`  局域网访问: ${url}`);
  console.log("");
  console.log("  按 Ctrl+C 停止服务");
  console.log("");
});

function shutdown() {
  console.log("\n正在关闭服务...");
  for (const room of rooms.values()) {
    for (const client of room.clients.values()) {
      if (!client.res.writableEnded) client.res.end();
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);