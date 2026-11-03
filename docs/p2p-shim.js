(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const forceP2P = params.get("p2p") === "1" || sessionStorage.getItem("gomoku_force_p2p") === "1";
  const staticHost = /\.github\.io$/i.test(window.location.hostname);
  if (!forceP2P && !staticHost) return;
  if (forceP2P) sessionStorage.setItem("gomoku_force_p2p", "1");

  const PEER_PREFIX = "yijing-gomoku-v1-";
  const HOST_STORE_PREFIX = "gomoku_p2p_host_v1_";
  const BOARD_SIZE = 15;
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const nativeFetch = window.fetch.bind(window);
  const sourcesByRoom = new Map();

  let hostSession = null;
  let guestSession = null;
  let lastGuestRoom = null;

  class P2PError extends Error {
    constructor(message, status = 500) {
      super(message);
      this.name = "P2PError";
      this.status = status;
    }
  }

  function randomCode(length = 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let code = "";
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return code;
  }

  function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function cleanText(value, maxLength) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function createEmptyBoard() {
    return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  }

  function createRoomState() {
    return {
      code: null,
      players: { black: null, white: null },
      spectators: [],
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

  function findPlayerByToken(room, token) {
    if (!token) return null;
    if (room.players.black && room.players.black.token === token) return room.players.black;
    if (room.players.white && room.players.white.token === token) return room.players.white;
    return null;
  }

  function findMember(room, token) {
    return findPlayerByToken(room, token) || room.spectators.find((member) => member.token === token) || null;
  }

  function isTokenOnline(room, token) {
    if (!hostSession || hostSession.room !== room) return false;
    if (token === hostSession.hostToken) return true;
    for (const conn of hostSession.connections) {
      if (conn.open && conn.token === token) return true;
    }
    return false;
  }

  function publicRoom(room) {
    if (!hostSession || hostSession.room !== room) return null;
    const onlineSpectators = new Set();
    for (const conn of hostSession.connections) {
      if (!conn.open || !conn.token) continue;
      if (!findPlayerByToken(room, conn.token)) onlineSpectators.add(conn.token);
    }

    const serializePlayer = (player) => player ? {
      name: player.name,
      seat: player.seat,
      ready: player.ready,
      rematch: player.rematch,
      online: isTokenOnline(room, player.token)
    } : null;

    return {
      code: room.code,
      status: room.status,
      players: {
        black: serializePlayer(room.players.black),
        white: serializePlayer(room.players.white)
      },
      spectators: onlineSpectators.size,
      board: room.board.map((row) => row.slice()),
      moves: room.moves.map((move) => ({
        number: move.number,
        seat: move.seat,
        row: move.row,
        col: move.col,
        at: move.at
      })),
      messages: room.messages.slice(-60).map((message) => ({ ...message })),
      currentTurn: room.currentTurn,
      winner: room.winner,
      winningLine: room.winningLine.map((point) => ({ ...point })),
      reason: room.reason,
      round: room.round,
      startedAt: room.startedAt,
      endedAt: room.endedAt,
      serverNow: Date.now(),
      version: room.version
    };
  }

  function peerIdFor(code) {
    return `${PEER_PREFIX}${String(code).toLowerCase()}`;
  }

  function createPeer(id) {
    if (typeof Peer === "undefined") {
      return Promise.reject(new P2PError("联机组件加载失败，请刷新页面重试", 503));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const peer = id ? new Peer(id, { debug: 0 }) : new Peer(undefined, { debug: 0 });
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try { peer.destroy(); } catch {}
        reject(new P2PError("连接联机服务器超时，请稍后重试", 504));
      }, 16000);

      peer.on("open", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(peer);
      });

      peer.on("error", (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        const message = error && error.type === "unavailable-id"
          ? "该房间正在被其他页面使用，请重新创建"
          : error && error.type === "peer-unavailable"
            ? "房间不存在或房主尚未上线"
            : "无法连接联机服务器，请稍后重试";
        try { peer.destroy(); } catch {}
        reject(new P2PError(message, error && error.type === "peer-unavailable" ? 404 : 503));
      });
    });
  }

  function persistHost() {
    if (!hostSession) return;
    try {
      localStorage.setItem(`${HOST_STORE_PREFIX}${hostSession.room.code}`, JSON.stringify({
        room: hostSession.room,
        hostToken: hostSession.hostToken
      }));
    } catch (error) {
      console.warn("无法保存房间状态", error);
    }
  }

  function loadHostSnapshot(code) {
    try {
      const raw = localStorage.getItem(`${HOST_STORE_PREFIX}${code}`);
      if (!raw) return null;
      const snapshot = JSON.parse(raw);
      if (!snapshot.room || snapshot.room.code !== code || !snapshot.hostToken) return null;
      return snapshot;
    } catch {
      return null;
    }
  }

  function clearHostSnapshot(code) {
    try { localStorage.removeItem(`${HOST_STORE_PREFIX}${code}`); } catch {}
  }

  function emitLocal(room) {
    const sources = sourcesByRoom.get(room.code);
    if (!sources) return;
    const payload = JSON.stringify(publicRoom(room));
    for (const source of [...sources]) source.pushRoom(payload);
  }

  function broadcastHost() {
    if (!hostSession) return;
    const room = hostSession.room;
    const payload = JSON.stringify(publicRoom(room));
    for (const conn of hostSession.connections) {
      if (conn.open) {
        try { conn.send({ kind: "room", room: publicRoom(room) }); } catch {}
      }
    }
    const sources = sourcesByRoom.get(room.code);
    if (sources) {
      for (const source of [...sources]) source.pushRoom(payload);
    }
  }

  function configureHostConnection(conn) {
    if (!hostSession) return;
    hostSession.connections.add(conn);
    conn.on("data", (data) => handleHostRpc(conn, data));
    conn.on("close", () => {
      if (hostSession) hostSession.connections.delete(conn);
      broadcastHost();
    });
    conn.on("error", () => {
      if (hostSession) hostSession.connections.delete(conn);
      broadcastHost();
    });
  }

  async function startHostPeer(room, hostToken) {
    if (hostSession && hostSession.room.code === room.code && hostSession.peer && !hostSession.peer.destroyed) {
      hostSession.room = room;
      hostSession.hostToken = hostToken;
      return hostSession;
    }
    if (hostSession) {
      try { hostSession.peer.destroy(); } catch {}
      hostSession = null;
    }

    const peer = await createPeer(peerIdFor(room.code));
    hostSession = {
      room,
      hostToken,
      peer,
      connections: new Set()
    };
    peer.on("connection", configureHostConnection);
    peer.on("disconnected", () => {
      if (!hostSession || hostSession.peer !== peer) return;
      window.setTimeout(() => {
        if (hostSession && hostSession.peer === peer && !peer.destroyed) {
          try { peer.reconnect(); } catch {}
        }
      }, 1200);
    });
    peer.on("error", (error) => {
      if (error && error.type !== "peer-unavailable") console.warn("P2P host:", error);
    });
    persistHost();
    return hostSession;
  }

  function sendToConn(conn, payload) {
    if (conn && conn.open) {
      try { conn.send(payload); } catch {}
    }
  }

  function rpcResult(conn, requestId, ok, data, error, status = 200) {
    sendToConn(conn, {
      kind: "rpcResult",
      requestId,
      ok,
      data,
      error: error || null,
      status
    });
  }
  function startRound(room, isRematch) {
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
    addSystemMessage(room, isRematch
      ? `第 ${room.round} 局开始，双方交换执子，黑棋先行。`
      : "双方已就绪，对局开始，黑棋先行。");
    touch(room);
    return true;
  }

  function checkWin(board, row, col, seat) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of directions) {
      const line = [{ row, col }];
      for (const sign of [-1, 1]) {
        let r = row + dr * sign;
        let c = col + dc * sign;
        while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === seat) {
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

  function joinHostConnection(conn, payload) {
    const room = hostSession.room;
    const name = cleanText(payload.name, 16) || `棋手${Math.floor(10 + Math.random() * 90)}`;
    let token = cleanText(payload.token, 128);
    if (token === hostSession.hostToken) throw new P2PError("无法使用房主身份加入房间", 403);
    let member = token ? findMember(room, token) : null;
    const wasOnline = member ? isTokenOnline(room, member.token) : false;

    if (member) {
      member.name = name;
    } else {
      if (!token) token = randomToken();
      const seat = !room.players.black ? "black" : !room.players.white ? "white" : null;
      member = {
        token,
        name,
        seat,
        ready: false,
        rematch: false,
        lastChatAt: 0
      };
      if (seat) {
        room.players[seat] = member;
        addSystemMessage(room, `${name} 执${seat === "black" ? "黑" : "白"}加入了对局。`);
      } else {
        room.spectators.push(member);
        addSystemMessage(room, `${name} 进入房间观战。`);
      }
    }

    conn.token = member.token;
    conn.memberName = member.name;
    if (wasOnline) addSystemMessage(room, `${member.name} 重新连接。`);
    touch(room);
    return {
      room: publicRoom(room),
      token: member.token,
      seat: member.seat
    };
  }

  function applyHostAction(action, token, payload) {
    const room = hostSession.room;
    const member = findMember(room, token);
    if (!member && action !== "get") throw new P2PError("请先加入房间", 403);

    if (action === "get") {
      return { room: publicRoom(room) };
    }

    if (action === "ready") {
      if (!member.seat) throw new P2PError("只有已入座的棋手可以准备", 403);
      if (room.status !== "waiting") throw new P2PError("当前对局不能准备", 409);
      if (!room.players.black || !room.players.white) throw new P2PError("请等待另一位棋手入座", 409);
      member.ready = Boolean(payload.ready);
      touch(room);
      if (room.players.black.ready && room.players.white.ready) startRound(room, false);
      return { room: publicRoom(room) };
    }

    if (action === "move") {
      if (!member.seat) throw new P2PError("观战者不能落子", 403);
      if (room.status !== "playing") throw new P2PError("对局尚未开始或已经结束", 409);
      if (room.currentTurn !== member.seat) throw new P2PError("还没有轮到你落子", 409);
      const row = Number(payload.row);
      const col = Number(payload.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
        throw new P2PError("落子位置无效", 400);
      }
      if (room.board[row][col] !== null) throw new P2PError("这里已经有棋子了", 409);
      room.board[row][col] = member.seat;
      room.moves.push({
        number: room.moves.length + 1,
        seat: member.seat,
        row,
        col,
        at: Date.now()
      });
      const winningLine = checkWin(room.board, row, col, member.seat);
      if (winningLine) {
        room.status = "finished";
        room.winner = member.seat;
        room.winningLine = winningLine;
        room.reason = "five";
        room.currentTurn = null;
        room.endedAt = Date.now();
        addSystemMessage(room, `${member.name} 以${member.seat === "black" ? "黑棋" : "白棋"}五子连珠，赢下本局。`);
      } else if (room.moves.length === BOARD_SIZE * BOARD_SIZE) {
        room.status = "finished";
        room.winner = "draw";
        room.winningLine = [];
        room.reason = "draw";
        room.currentTurn = null;
        room.endedAt = Date.now();
        addSystemMessage(room, "棋盘已满，本局和棋。");
      } else {
        room.currentTurn = member.seat === "black" ? "white" : "black";
      }
      touch(room);
      return { room: publicRoom(room) };
    }

    if (action === "rematch") {
      if (!member.seat) throw new P2PError("只有棋手可以发起再来一局", 403);
      if (room.status !== "finished") throw new P2PError("当前不能再来一局", 409);
      if (!room.players.black || !room.players.white) throw new P2PError("需要两位棋手才能继续", 409);
      member.rematch = true;
      touch(room);
      if (room.players.black.rematch && room.players.white.rematch) startRound(room, true);
      return { room: publicRoom(room) };
    }

    if (action === "chat") {
      const text = cleanText(payload.text, 120);
      if (!text) throw new P2PError("消息不能为空", 400);
      if (Date.now() - (member.lastChatAt || 0) < 300) throw new P2PError("发言太快了，请稍后再试", 429);
      member.lastChatAt = Date.now();
      room.messages.push({
        id: crypto.randomUUID(),
        kind: "chat",
        name: member.name,
        seat: member.seat || null,
        text,
        at: Date.now()
      });
      if (room.messages.length > 100) room.messages.shift();
      touch(room);
      return { ok: true };
    }

    if (action === "leave") {
      const seat = member.seat;
      const otherSeat = seat === "black" ? "white" : "black";
      const other = seat ? room.players[otherSeat] : null;
      if (seat) {
        room.players[seat] = null;
        if (room.status === "playing") {
          room.status = "finished";
          room.currentTurn = null;
          room.endedAt = Date.now();
          room.reason = "abandoned";
          room.winner = other ? otherSeat : "draw";
          room.winningLine = [];
          addSystemMessage(room, `${member.name} 离开了棋局，对局结束。`);
        } else {
          addSystemMessage(room, `${member.name} 离开了房间。`);
        }
        if (other) {
          other.rematch = false;
          other.ready = false;
        }
      } else {
        room.spectators = room.spectators.filter((item) => item.token !== token);
        addSystemMessage(room, `${member.name} 离开了房间。`);
      }
      touch(room);
      return { ok: true };
    }

    throw new P2PError("接口不存在", 404);
  }

  async function handleHostRpc(conn, message) {
    if (!message || message.kind !== "rpc" || !hostSession) return;
    const requestId = message.requestId;
    const action = message.action;
    const payload = message.payload || {};
    try {
      let data;
      if (action === "join") {
        data = joinHostConnection(conn, payload);
      } else {
        data = applyHostAction(action, cleanText(message.token, 128), payload);
      }
      persistHost();
      rpcResult(conn, requestId, true, data);
      broadcastHost();
      if (action === "leave") {
        window.setTimeout(() => {
          try { conn.close(); } catch {}
        }, 180);
      }
    } catch (error) {
      rpcResult(conn, requestId, false, null, error.message || "请求失败", error.status || 500);
    }
  }

  async function createHostRoom(name) {
    if (hostSession) {
      const oldCode = hostSession.room.code;
      try { hostSession.peer.destroy(); } catch {}
      clearHostSnapshot(oldCode);
      hostSession = null;
    }

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = randomCode();
      const room = createRoomState();
      room.code = code;
      const token = randomToken();
      const player = {
        token,
        name: name || `棋手${Math.floor(10 + Math.random() * 90)}`,
        seat: "black",
        ready: false,
        rematch: false,
        lastChatAt: 0
      };
      room.players.black = player;
      addSystemMessage(room, "房间已创建，等待另一位棋手加入。");
      try {
        await startHostPeer(room, token);
        return {
          room: publicRoom(room),
          token,
          seat: "black",
          roomCode: code
        };
      } catch (error) {
        lastError = error;
        clearHostSnapshot(code);
      }
    }
    throw lastError || new P2PError("创建房间失败", 500);
  }

  async function restoreHost(code, token) {
    if (hostSession && hostSession.room.code === code && hostSession.hostToken === token) {
      const player = findPlayerByToken(hostSession.room, token);
      return {
        room: publicRoom(hostSession.room),
        token,
        seat: player ? player.seat : null
      };
    }
    const snapshot = loadHostSnapshot(code);
    if (!snapshot || snapshot.hostToken !== token) return null;
    await startHostPeer(snapshot.room, snapshot.hostToken);
    const player = findPlayerByToken(hostSession.room, token);
    return {
      room: publicRoom(hostSession.room),
      token,
      seat: player ? player.seat : null
    };
  }
  function installGuestConnection(conn, code) {
    conn._pendingRequests = new Map();
    conn.on("data", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.kind === "room" && message.room) {
        lastGuestRoom = message.room;
        const sources = sourcesByRoom.get(code);
        if (sources) {
          const payload = JSON.stringify(message.room);
          for (const source of [...sources]) source.pushRoom(payload);
        }
        return;
      }
      if (message.kind === "rpcResult") {
        const pending = conn._pendingRequests.get(message.requestId);
        if (!pending) return;
        conn._pendingRequests.delete(message.requestId);
        window.clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.data);
        else pending.reject(new P2PError(message.error || "请求失败", message.status || 500));
      }
    });
    const fail = () => {
      const pending = conn._pendingRequests || new Map();
      for (const item of pending.values()) {
        window.clearTimeout(item.timer);
        item.reject(new P2PError("与房主的连接已断开，请稍后重试", 503));
      }
      pending.clear();
      const sources = sourcesByRoom.get(code);
      if (sources) {
        for (const source of [...sources]) source.pushError();
      }
    };
    conn.on("close", fail);
    conn.on("error", fail);
  }

  function waitForDataConnection(peer, code) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const conn = peer.connect(peerIdFor(code), { reliable: true });
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try { conn.close(); } catch {}
        reject(new P2PError("连接房主超时，请确认房主页面仍处于打开状态", 504));
      }, 16000);

      const onPeerError = (error) => {
        if (settled) return;
        if (error && error.type === "peer-unavailable") {
          settled = true;
          window.clearTimeout(timer);
          reject(new P2PError("房间不存在或房主尚未上线", 404));
        }
      };
      peer.on("error", onPeerError);

      conn.on("open", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(conn);
      });
      conn.on("error", () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(new P2PError("连接房主失败，请稍后重试", 503));
      });
    });
  }

  function rpcGuest(conn, action, token, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!conn || !conn.open) {
        reject(new P2PError("与房主的连接已断开", 503));
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = window.setTimeout(() => {
        conn._pendingRequests.delete(requestId);
        reject(new P2PError("房主响应超时，请稍后重试", 504));
      }, 12000);
      conn._pendingRequests.set(requestId, { resolve, reject, timer });
      try {
        conn.send({ kind: "rpc", requestId, action, token, payload });
      } catch {
        window.clearTimeout(timer);
        conn._pendingRequests.delete(requestId);
        reject(new P2PError("消息发送失败，请重试", 503));
      }
    });
  }

  async function connectGuest(code, name, token) {
    if (guestSession && guestSession.code === code && guestSession.peer && !guestSession.peer.destroyed && guestSession.conn && guestSession.conn.open) {
      const data = await rpcGuest(guestSession.conn, "join", token || guestSession.token, { name, token: token || guestSession.token });
      guestSession.token = data.token;
      guestSession.name = name;
      lastGuestRoom = data.room;
      return data;
    }

    if (guestSession) {
      try { guestSession.peer.destroy(); } catch {}
      guestSession = null;
    }
    const peer = await createPeer(undefined);
    const conn = await waitForDataConnection(peer, code);
    installGuestConnection(conn, code);
    guestSession = {
      code,
      name: name || `棋手${Math.floor(10 + Math.random() * 90)}`,
      token: token || "",
      peer,
      conn
    };
    peer.on("disconnected", () => {
      window.setTimeout(() => {
        if (guestSession && guestSession.peer === peer && !peer.destroyed) {
          try { peer.reconnect(); } catch {}
        }
      }, 1200);
    });
    peer.on("error", (error) => {
      if (error && error.type !== "peer-unavailable") console.warn("P2P guest:", error);
    });

    try {
      const data = await rpcGuest(conn, "join", guestSession.token, { name: guestSession.name, token: guestSession.token });
      guestSession.token = data.token;
      lastGuestRoom = data.room;
      return data;
    } catch (error) {
      try { peer.destroy(); } catch {}
      guestSession = null;
      throw error;
    }
  }

  async function ensureGuest(code, token) {
    if (guestSession && guestSession.code === code && guestSession.conn && guestSession.conn.open) {
      return guestSession;
    }
    const name = guestSession && guestSession.name
      || localStorage.getItem("gomoku_nickname")
      || `棋手${Math.floor(10 + Math.random() * 90)}`;
    const savedToken = token || (guestSession && guestSession.token) || "";
    await connectGuest(code, name, savedToken);
    return guestSession;
  }

  function guestRpc(code, action, token, payload = {}) {
    return ensureGuest(code, token).then((session) => rpcGuest(session.conn, action, token || session.token, payload));
  }

  function responseJson(payload, status = 200) {
    return Response.json(payload, {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  function parseBody(options) {
    if (!options || !options.body) return {};
    if (typeof options.body !== "string") return options.body;
    try { return JSON.parse(options.body); } catch { throw new P2PError("请求格式错误", 400); }
  }

  function performLocalHostAction(action, token, payload) {
    const data = applyHostAction(action, token, payload);
    persistHost();
    broadcastHost();
    if (action === "leave") {
      const code = hostSession.room.code;
      const leavingHost = token === hostSession.hostToken;
      if (leavingHost) {
        clearHostSnapshot(code);
        window.setTimeout(() => {
          if (!hostSession || hostSession.room.code !== code) return;
          try { hostSession.peer.destroy(); } catch {}
          hostSession = null;
        }, 250);
      }
    }
    return data;
  }

  async function handleP2PFetch(input, options = {}) {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.origin);
    const path = url.pathname;
    const method = String(options.method || "GET").toUpperCase();
    const body = method === "POST" ? parseBody(options) : {};
    const roomMatch = path.match(/^\/api\/rooms\/([A-Z0-9]{4,12})(?:\/(join|ready|move|rematch|chat|leave))?$/);

    try {
      if (method === "POST" && path === "/api/rooms") {
        return responseJson(await createHostRoom(cleanText(body.name, 16)));
      }

      if (roomMatch) {
        const code = roomMatch[1].toUpperCase();
        const action = roomMatch[2] || "get";

        if (action === "join") {
          if (hostSession && hostSession.room.code === code && body.token === hostSession.hostToken) {
            const restored = await restoreHost(code, body.token);
            return responseJson(restored);
          }
          if (!hostSession) {
            const restored = await restoreHost(code, body.token);
            if (restored) return responseJson(restored);
          }
          return responseJson(await connectGuest(code, cleanText(body.name, 16), cleanText(body.token, 128)));
        }

        if (hostSession && hostSession.room.code === code) {
          if (action === "get") return responseJson({ room: publicRoom(hostSession.room) });
          if (body.token === hostSession.hostToken) {
            return responseJson(performLocalHostAction(action, body.token, body));
          }
        }

        if (action === "get") {
          if (guestSession && guestSession.code === code && guestSession.conn && guestSession.conn.open) {
            return responseJson(await rpcGuest(guestSession.conn, "get", guestSession.token, {}));
          }
          if (guestSession && guestSession.code === code) {
            await ensureGuest(code, guestSession.token);
            return responseJson(await rpcGuest(guestSession.conn, "get", guestSession.token, {}));
          }
          throw new P2PError("房间连接已断开，请重新打开邀请链接", 503);
        }

        return responseJson(await guestRpc(code, action, cleanText(body.token, 128), body));
      }

      return responseJson({ error: "接口不存在" }, 404);
    } catch (error) {
      const message = error && error.message ? error.message : "请求失败";
      const status = error && error.status ? error.status : 500;
      return responseJson({ error: message }, status);
    }
  }

  class P2PEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      this._closed = false;
      const parsed = new URL(this.url, window.location.origin);
      const match = parsed.pathname.match(/^\/api\/rooms\/([A-Z0-9]{4,12})\/events$/);
      this._code = match ? match[1].toUpperCase() : "";
      this._token = parsed.searchParams.get("token") || "";
      let roomSources = sourcesByRoom.get(this._code);
      if (!roomSources) {
        roomSources = new Set();
        sourcesByRoom.set(this._code, roomSources);
      }
      roomSources.add(this);

      this._timer = window.setTimeout(() => {
        if (this._closed) return;
        this.readyState = 1;
        const event = new Event("open");
        if (this.onopen) this.onopen(event);
        this.dispatchEvent(event);
        let room = null;
        if (hostSession && hostSession.room.code === this._code && this._token === hostSession.hostToken) {
          room = publicRoom(hostSession.room);
        } else if (lastGuestRoom && lastGuestRoom.code === this._code) {
          room = lastGuestRoom;
        }
        if (room) this.pushRoom(JSON.stringify(room));
      }, 30);
    }

    pushRoom(payload) {
      if (this._closed) return;
      const event = new MessageEvent("room", { data: payload });
      this.dispatchEvent(event);
    }

    pushError() {
      if (this._closed) return;
      this.readyState = 0;
      const event = new Event("error");
      if (this.onerror) this.onerror(event);
      this.dispatchEvent(event);
    }

    close() {
      this._closed = true;
      this.readyState = 2;
      window.clearTimeout(this._timer);
      const roomSources = sourcesByRoom.get(this._code);
      if (roomSources) {
        roomSources.delete(this);
        if (!roomSources.size) sourcesByRoom.delete(this._code);
      }
    }
  }

  P2PEventSource.CONNECTING = 0;
  P2PEventSource.OPEN = 1;
  P2PEventSource.CLOSED = 2;

  window.fetch = function p2pFetch(input, options) {
    const rawUrl = typeof input === "string" ? input : input && input.url;
    if (!rawUrl) return nativeFetch(input, options);
    let pathname;
    try { pathname = new URL(rawUrl, window.location.origin).pathname; } catch { return nativeFetch(input, options); }
    if (pathname.startsWith("/api/")) return handleP2PFetch(input, options || {});
    return nativeFetch(input, options);
  };

  window.EventSource = P2PEventSource;
  window.__GOMOKU_P2P__ = true;
  window.addEventListener("pagehide", () => {
    if (guestSession) {
      try { guestSession.peer.destroy(); } catch {}
    }
  });
})();