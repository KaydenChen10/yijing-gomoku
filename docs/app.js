(() => {
  "use strict";

  const BOARD_SIZE = 15;
  const TOKEN_PREFIX = "gomoku_token_";
  const NAME_KEY = "gomoku_nickname";
  const SOUND_KEY = "gomoku_sound";

  const $ = (id) => document.getElementById(id);

  const els = {
    landingView: $("landingView"),
    roomView: $("roomView"),
    loadingView: $("loadingView"),
    nicknameInput: $("nicknameInput"),
    primaryEntryBtn: $("primaryEntryBtn"),
    primaryEntryText: $("primaryEntryText"),
    joinEntryBtn: $("joinEntryBtn"),
    roomJoinArea: $("roomJoinArea"),
    roomCodeInput: $("roomCodeInput"),
    entryKicker: $("entryKicker"),
    entryTitle: $("entryTitle"),
    entryHint: $("entryHint"),
    roomCode: $("roomCode"),
    roomCodeBtn: $("roomCodeBtn"),
    connectionBadge: $("connectionBadge"),
    roomHomeLink: $("roomHomeLink"),
    soundToggle: $("soundToggle"),
    leaveBtn: $("leaveBtn"),
    leaveDialog: $("leaveDialog"),
    confirmLeaveBtn: $("confirmLeaveBtn"),
    statusBadge: $("statusBadge"),
    statusTitle: $("statusTitle"),
    statusSubtitle: $("statusSubtitle"),
    roundBadge: $("roundBadge"),
    readyProgress: $("readyProgress"),
    readyCount: $("readyCount"),
    readyBar: $("readyBar"),
    primaryAction: $("primaryAction"),
    actionHint: $("actionHint"),
    shareInviteBtn: $("shareInviteBtn"),
    turnIndicator: $("turnIndicator"),
    turnLabel: $("turnLabel"),
    turnText: $("turnText"),
    gameClock: $("gameClock"),
    overlay: $("boardOverlay"),
    overlayTitle: $("overlayTitle"),
    overlayText: $("overlayText"),
    overlayShareBtn: $("overlayShareBtn"),
    yourRole: $("yourRole"),
    boardHint: $("boardHint"),
    onlineCount: $("onlineCount"),
    activityTab: $("activityTab"),
    movesTab: $("movesTab"),
    activityFeed: $("activityFeed"),
    moveFeed: $("moveFeed"),
    moveCount: $("moveCount"),
    emoteRow: $("emoteRow"),
    chatForm: $("chatForm"),
    chatInput: $("chatInput"),
    canvas: $("boardCanvas"),
    toastRegion: $("toastRegion"),
    mobileStatus: $("mobileStatus")
  };

  const playerEls = {
    black: {
      card: $("blackPlayerCard"),
      name: document.querySelector("#blackPlayerCard .player-name"),
      state: document.querySelector("#blackPlayerCard .player-state"),
      you: document.querySelector("#blackPlayerCard .you-tag")
    },
    white: {
      card: $("whitePlayerCard"),
      name: document.querySelector("#whitePlayerCard .player-name"),
      state: document.querySelector("#whitePlayerCard .player-state"),
      you: document.querySelector("#whitePlayerCard .you-tag")
    }
  };

  const S = {
    code: null,
    token: null,
    seat: null,
    room: null,
    source: null,
    connected: false,
    inviteCode: null,
    sound: localStorage.getItem(SOUND_KEY) !== "off",
    movePending: false,
    actionPending: false,
    hover: null,
    metrics: null,
    animationFrame: null,
    animateMoveNumber: null,
    animationStart: 0,
    lastMoveCount: 0,
    hasRoomState: false,
    feedTab: "activity",
    messageSignature: "",
    moveSignature: "",
    windowScrollBottom: true,
    moveScrollBottom: true,
    audioContext: null,
    clockOffset: 0,
    mobileTimer: null,
    refreshTimer: null
  };

  class ApiError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  function randomGuestName() {
    return `棋手${Math.floor(1000 + Math.random() * 9000)}`;
  }

  function getStoredName() {
    return (localStorage.getItem(NAME_KEY) || "").trim() || randomGuestName();
  }

  function normalizeName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 16) || randomGuestName();
  }

  function tokenKey(code) {
    return `${TOKEN_PREFIX}${code}`;
  }

  function opposite(seat) {
    return seat === "black" ? "white" : "black";
  }

  function seatLabel(seat) {
    return seat === "black" ? "黑棋" : "白棋";
  }

  function appBasePath() {
    const pathname = window.location.pathname;
    if (pathname.endsWith("/")) return pathname;
    const lastSlash = pathname.lastIndexOf("/");
    return lastSlash >= 0 ? pathname.slice(0, lastSlash + 1) : "/";
  }

  function roomPath(code) {
    return `${appBasePath()}?room=${encodeURIComponent(code)}`;
  }

  function coordinateLabel(row, col) {
    return `${String.fromCharCode(65 + col)}${BOARD_SIZE - row}`;
  }

  function parseRoomCode(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;
    if (/^[A-Z0-9]{4,12}$/i.test(raw)) return raw.toUpperCase();
    try {
      const url = new URL(raw, window.location.origin);
      const code = (url.searchParams.get("room") || "").toUpperCase();
      if (/^[A-Z0-9]{4,12}$/.test(code)) return code;
    } catch {}
    const match = raw.match(/(?:room=|\/)([A-Z0-9]{4,12})(?:[&#/?]|$)/i);
    return match ? match[1].toUpperCase() : null;
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(path, { ...options, headers });
    } catch {
      throw new ApiError("无法连接服务器，请确认服务仍在运行", 0);
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok) {
      throw new ApiError(payload.error || "请求失败，请稍后再试", response.status);
    }
    return payload;
  }

  function post(path, body) {
    return api(path, { method: "POST", body: JSON.stringify(body) });
  }

  function setLoading(visible) {
    els.loadingView.hidden = !visible;
  }

  function showView(view) {
    els.landingView.hidden = view !== "landing";
    els.roomView.hidden = view !== "room";
    els.loadingView.hidden = true;
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function updateEntryBusy(busy) {
    els.primaryEntryBtn.disabled = busy;
    els.joinEntryBtn.disabled = busy;
    if (busy) {
      els.primaryEntryText.textContent = "正在进入...";
    } else if (S.inviteCode) {
      els.primaryEntryText.textContent = "加入棋局";
    } else {
      els.primaryEntryText.textContent = "创建棋局";
    }
  }

  function showLanding(inviteCode = null, hint = "") {
    closeEventSource();
    S.code = null;
    S.token = null;
    S.seat = null;
    S.room = null;
    S.inviteCode = inviteCode;
    S.hasRoomState = false;
    showView("landing");
    const storedName = getStoredName();
    els.nicknameInput.value = storedName;
    els.roomCodeInput.value = "";

    if (inviteCode) {
      els.entryKicker.textContent = "YOU ARE INVITED";
      els.entryTitle.textContent = "好友邀你落子";
      els.primaryEntryText.textContent = "加入棋局";
      els.entryHint.textContent = `房间 ${inviteCode} 正在等待棋手，输入称呼即可入座。`;
      els.roomJoinArea.hidden = true;
    } else {
      els.entryKicker.textContent = "START A MATCH";
      els.entryTitle.textContent = "邀一位好友，下一局";
      els.primaryEntryText.textContent = "创建棋局";
      els.entryHint.textContent = hint || "创建后会生成专属邀请链接，发给朋友即可。";
      els.roomJoinArea.hidden = false;
    }

    window.setTimeout(() => els.nicknameInput.focus(), 120);
  }

  function rememberIdentity(code, data) {
    S.code = code;
    S.token = data.token;
    S.seat = data.seat;
    localStorage.setItem(tokenKey(code), data.token);
    localStorage.setItem(NAME_KEY, normalizeName(els.nicknameInput.value || getStoredName()));
  }

  function enterRoom(code, data) {
    rememberIdentity(code, data);
    showView("room");
    history.replaceState({}, "", roomPath(code));
    els.roomCode.textContent = code;
    handleRoomUpdate(data.room);
    connectEventSource();
    window.setTimeout(resizeBoard, 40);
  }

  async function createRoom() {
    const name = normalizeName(els.nicknameInput.value);
    localStorage.setItem(NAME_KEY, name);
    updateEntryBusy(true);
    setLoading(true);
    try {
      const data = await post("/api/rooms", { name });
      els.nicknameInput.value = name;
      enterRoom(data.roomCode, data);
    } catch (error) {
      setLoading(false);
      showToast(error.message, true);
    } finally {
      updateEntryBusy(false);
    }
  }

  async function joinRoom(code) {
    if (!code || !/^[A-Z0-9]{4,12}$/.test(code)) {
      showToast("请输入正确的房间号或邀请链接", true);
      return;
    }
    const name = normalizeName(els.nicknameInput.value);
    localStorage.setItem(NAME_KEY, name);
    const existingToken = localStorage.getItem(tokenKey(code)) || "";
    updateEntryBusy(true);
    setLoading(true);
    try {
      const data = await post(`/api/rooms/${code}/join`, { name, token: existingToken });
      els.nicknameInput.value = name;
      enterRoom(code, data);
      if (!data.seat) showToast("房间已有两位棋手，你已进入观战模式");
    } catch (error) {
      setLoading(false);
      if (error.status === 404) {
        showLanding(null, "这个房间不存在或已经过期，请创建一个新棋局。");
        setTimeout(() => showToast("房间不存在或已过期", true), 100);
      } else {
        showLanding(S.inviteCode, error.message);
        showToast(error.message, true);
      }
    } finally {
      updateEntryBusy(false);
    }
  }

  async function tryResume(code) {
    const savedToken = localStorage.getItem(tokenKey(code));
    if (!savedToken) return false;
    setLoading(true);
    try {
      const name = normalizeName(localStorage.getItem(NAME_KEY) || getStoredName());
      const data = await post(`/api/rooms/${code}/join`, { name, token: savedToken });
      enterRoom(code, data);
      return true;
    } catch (error) {
      if (error.status === 404 || error.status === 403) {
        localStorage.removeItem(tokenKey(code));
      }
      return false;
    } finally {
      setLoading(false);
    }
  }
  function closeEventSource() {
    if (S.source) {
      S.source.close();
      S.source = null;
    }
    S.connected = false;
  }

  function setConnectionBadge(mode) {
    els.connectionBadge.className = `connection-badge is-${mode}`;
    const label = els.connectionBadge.querySelector("span");
    if (label) {
      label.textContent = mode === "online" ? "实时连接" : mode === "offline" ? "正在重连" : "连接中";
    }
  }

  function connectEventSource() {
    closeEventSource();
    setConnectionBadge("connecting");
    const url = `/api/rooms/${encodeURIComponent(S.code)}/events?token=${encodeURIComponent(S.token || "")}`;
    const source = new EventSource(url);
    S.source = source;

    source.onopen = () => {
      S.connected = true;
      setConnectionBadge("online");
    };

    source.addEventListener("room", (event) => {
      try {
        const room = JSON.parse(event.data);
        if (room.code === S.code) handleRoomUpdate(room);
      } catch {
        showToast("收到的对局数据无法解析", true);
      }
    });

    source.onerror = () => {
      S.connected = false;
      setConnectionBadge("offline");
      window.clearTimeout(S.refreshTimer);
      S.refreshTimer = window.setTimeout(refreshRoom, 2600);
    };
  }

  async function refreshRoom() {
    if (!S.code) return;
    try {
      const data = await api(`/api/rooms/${S.code}`);
      handleRoomUpdate(data.room);
    } catch (error) {
      if (error.status === 404) {
        closeEventSource();
        localStorage.removeItem(tokenKey(S.code));
        showLanding(null, "房间已失效，请创建一个新棋局。");
        showToast("房间已失效", true);
      }
    }
  }

  function handleRoomUpdate(room) {
    if (!room || room.code !== S.code) return;
    const previous = S.room;
    if (previous && room.round > previous.round && S.seat) {
      S.seat = opposite(S.seat);
    }

    const previousMoveCount = previous ? previous.moves.length : 0;
    if (previous && room.moves.length > previousMoveCount) {
      const latest = room.moves[room.moves.length - 1];
      S.animateMoveNumber = latest ? latest.number : null;
      S.animationStart = performance.now();
      playStoneSound(latest ? latest.seat : "black");
    }

    if (previous && previous.status !== "finished" && room.status === "finished") {
      window.setTimeout(() => playFinishSound(room.winner), 300);
    }

    S.room = room;
    S.clockOffset = room.serverNow - Date.now();
    S.lastMoveCount = room.moves.length;
    S.hasRoomState = true;
    renderRoom(room);
  }

  function setPlayerState(element, text, kind = "online") {
    element.replaceChildren();
    const dot = document.createElement("i");
    dot.className = kind;
    element.append(dot, document.createTextNode(text));
  }

  function setStatusBadge(text, kind = "") {
    els.statusBadge.className = `status-badge${kind ? ` is-${kind}` : ""}`;
    const label = els.statusBadge.querySelector("span");
    if (label) label.textContent = text;
  }

  function setActionButton(text, disabled, mode = "") {
    const label = els.primaryAction.querySelector("span");
    if (label) label.textContent = text;
    els.primaryAction.disabled = disabled;
    els.primaryAction.dataset.mode = mode;
  }

  function renderPlayers(room) {
    for (const seat of ["black", "white"]) {
      const player = room.players[seat];
      const target = playerEls[seat];
      const isTurn = room.status === "playing" && room.currentTurn === seat;
      target.card.classList.toggle("is-empty", !player);
      target.card.classList.toggle("is-turn", Boolean(isTurn));
      target.card.classList.toggle("is-offline", Boolean(player && !player.online));
      target.you.hidden = S.seat !== seat;

      if (!player) {
        target.name.textContent = "等待入座";
        setPlayerState(target.state, "空位", "offline");
        continue;
      }

      target.name.textContent = player.name;
      if (!player.online) {
        setPlayerState(target.state, "暂时离线", "offline");
      } else if (room.status === "waiting") {
        setPlayerState(target.state, player.ready ? "已准备" : "在线", "online");
      } else if (room.status === "finished") {
        setPlayerState(target.state, "对局结束", "online");
      } else if (isTurn) {
        setPlayerState(target.state, "正在思考", "thinking");
      } else {
        setPlayerState(target.state, "对局中", "online");
      }
    }
  }

  function renderMainStatus(room) {
    const bothPlayers = Boolean(room.players.black && room.players.white);
    const myPlayer = S.seat ? room.players[S.seat] : null;
    const opponent = S.seat ? room.players[opposite(S.seat)] : null;
    const isMyTurn = room.status === "playing" && S.seat && room.currentTurn === S.seat;
    const turnPlayer = room.currentTurn ? room.players[room.currentTurn] : null;

    els.roundBadge.textContent = `第 ${room.round} 局`;
    els.readyProgress.hidden = !(room.status === "waiting" && bothPlayers);

    if (room.status === "waiting") {
      setStatusBadge(bothPlayers ? "等待开局" : "等待中");
      els.statusTitle.textContent = bothPlayers ? "棋手已经就位" : "等待棋手入座";
      els.statusSubtitle.textContent = bothPlayers
        ? "双方点击开始游戏，即可展开这一局。"
        : "把邀请链接发给朋友，棋局就可以开始了。";

      if (!S.seat) {
        setActionButton("正在观战", true);
        els.actionHint.textContent = "你以观战身份进入，棋局开始后可观看实时对局。";
      } else if (!bothPlayers) {
        setActionButton("等待对手加入", true);
        els.actionHint.textContent = "邀请链接已生成，分享给朋友即可入座。";
      } else {
        const ready = Boolean(myPlayer && myPlayer.ready);
        const otherReady = Boolean(opponent && opponent.ready);
        setActionButton(ready ? "取消准备" : "开始游戏", false, ready ? "unready" : "ready");
        if (ready) {
          els.actionHint.textContent = "你已准备，等待对手点击开始。";
        } else if (otherReady) {
          els.actionHint.textContent = "对手已准备，点击开始即可对局。";
        } else {
          els.actionHint.textContent = "两位棋手都点击开始后，对局自动开始。";
        }
      }
    } else if (room.status === "playing") {
      setStatusBadge("对局中", "playing");
      if (isMyTurn) {
        els.statusTitle.textContent = "轮到你落子";
        els.statusSubtitle.textContent = "观察全局，落下一枚属于你的棋子。";
      } else if (S.seat) {
        els.statusTitle.textContent = "等待对手落子";
        els.statusSubtitle.textContent = `${turnPlayer ? turnPlayer.name : "对手"} 正在思考下一步。`;
      } else {
        els.statusTitle.textContent = "对局进行中";
        els.statusSubtitle.textContent = `${turnPlayer ? turnPlayer.name : "棋手"} 正在思考下一步。`;
      }
      setActionButton("对局进行中", true);
      els.actionHint.textContent = isMyTurn ? "轮到你了，点击棋盘交叉点落子。" : "请耐心等待对手落子。";
    } else {
      setStatusBadge("本局结束", "finished");
      if (room.winner === "draw") {
        els.statusTitle.textContent = "本局和棋";
        els.statusSubtitle.textContent = "棋盘已满，双方平分秋色。";
      } else {
        const winner = room.winner ? room.players[room.winner] : null;
        els.statusTitle.textContent = winner ? `${winner.name} 胜出` : "本局结束";
        els.statusSubtitle.textContent = room.reason === "abandoned"
          ? "对手离开了棋局，本局随之结束。"
          : "五子连珠，漂亮地赢下了这一局。";
      }

      if (!S.seat) {
        setActionButton("正在观战", true);
        els.actionHint.textContent = "观战模式不能发起再来一局。";
      } else if (!bothPlayers) {
        setActionButton("等待新棋手", true);
        els.actionHint.textContent = "离开的棋手无法继续，返回首页可创建新棋局。";
      } else if (myPlayer && myPlayer.rematch) {
        setActionButton("已申请再来一局", true, "rematch");
        els.actionHint.textContent = "已申请再来一局，等待对手确认。";
      } else {
        setActionButton("再来一局", false, "rematch");
        els.actionHint.textContent = opponent && opponent.rematch
          ? "对手想再来一局，点击确认后交换执子。"
          : "双方确认后交换执子，开始下一局。";
      }
    }

    if (bothPlayers) {
      const readyTotal = [room.players.black, room.players.white].filter((player) => player.ready).length;
      els.readyCount.textContent = `${readyTotal} / 2`;
      els.readyBar.style.width = `${readyTotal * 50}%`;
    }
  }

  function renderTurnArea(room) {
    const isMyTurn = room.status === "playing" && S.seat && room.currentTurn === S.seat;
    const turnSeat = room.currentTurn || room.winner || "black";
    const stone = els.turnIndicator.querySelector(".turn-stone");
    stone.className = `turn-stone ${turnSeat === "white" ? "white-stone" : "black-stone"}`;
    els.turnIndicator.classList.toggle("is-my-turn", Boolean(isMyTurn));
    els.turnIndicator.classList.toggle("is-idle", room.status !== "playing");

    if (room.status === "waiting") {
      els.turnLabel.textContent = "WAITING";
      els.turnText.textContent = "等待棋局开始";
      els.boardHint.textContent = "等待棋局开始";
    } else if (room.status === "playing") {
      const player = room.currentTurn ? room.players[room.currentTurn] : null;
      els.turnLabel.textContent = room.currentTurn === "white" ? "WHITE TO MOVE" : "BLACK TO MOVE";
      els.turnText.textContent = isMyTurn ? "轮到你落子" : `${player ? player.name : "棋手"} 正在思考`;
      els.boardHint.textContent = isMyTurn ? "轮到你了，落子吧" : "等待对手落子";
    } else {
      els.turnLabel.textContent = "FINISHED";
      if (room.winner === "draw") els.turnText.textContent = "本局和棋";
      else {
        const winner = room.winner ? room.players[room.winner] : null;
        els.turnText.textContent = winner ? `${winner.name} 获胜` : "对局结束";
      }
      els.boardHint.textContent = "对局已结束";
    }

    els.yourRole.replaceChildren();
    const roleDot = document.createElement("i");
    els.yourRole.append(roleDot, document.createTextNode(
      S.seat ? `你执${seatLabel(S.seat)}` : "观战中"
    ));
    els.canvas.classList.toggle("is-active", Boolean(isMyTurn) && !S.movePending);
  }

  function renderOverlay(room) {
    const bothPlayers = Boolean(room.players.black && room.players.white);
    const overlayStone = els.overlay.querySelector(".overlay-stone");
    if (room.status === "playing") {
      els.overlay.hidden = true;
      return;
    }

    els.overlay.hidden = false;
    if (room.status === "waiting") {
      overlayStone.className = "overlay-stone black-stone";
      if (bothPlayers) {
        els.overlayTitle.textContent = "静候开局";
        els.overlayText.textContent = "两位棋手已就位，点击开始按钮，黑棋先行。";
      } else {
        els.overlayTitle.textContent = "等待另一位棋手";
        els.overlayText.textContent = "复制邀请链接发给朋友，对方进入后即可入座。";
      }
      els.overlayShareBtn.hidden = false;
      els.overlayShareBtn.textContent = "复制邀请链接";
    } else {
      overlayStone.className = `overlay-stone ${room.winner === "white" ? "white-stone" : "black-stone"}`;
      if (room.winner === "draw") {
        els.overlayTitle.textContent = "势均力敌";
        els.overlayText.textContent = "棋盘已满，本局和棋。";
      } else {
        const winner = room.winner ? room.players[room.winner] : null;
        els.overlayTitle.textContent = winner ? `${winner.name} 胜出` : "本局结束";
        els.overlayText.textContent = room.reason === "abandoned"
          ? "对手离开，对局结束。"
          : "五子连珠，本局胜负已定。";
      }
      els.overlayShareBtn.hidden = true;
    }
  }

  function formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function renderActivity(room) {
    const messages = room.messages || [];
    const lastId = messages.length ? messages[messages.length - 1].id : "";
    const signature = `${messages.length}:${lastId}`;
    if (signature === S.messageSignature) return;
    S.messageSignature = signature;

    const feed = els.activityFeed;
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    const fragment = document.createDocumentFragment();

    for (const message of messages) {
      if (message.kind === "system") {
        const row = document.createElement("p");
        row.className = "system-message";
        row.textContent = message.text;
        fragment.append(row);
        continue;
      }

      const row = document.createElement("div");
      row.className = "chat-message";
      if (S.seat && message.seat === S.seat) row.classList.add("is-self");

      const avatar = document.createElement("span");
      avatar.className = `chat-avatar${message.seat === "white" ? " white-avatar" : message.seat ? "" : " spectator-avatar"}`;
      avatar.textContent = (message.name || "棋").slice(0, 1);

      const body = document.createElement("div");
      body.className = "chat-body";
      const meta = document.createElement("div");
      meta.className = "chat-meta";
      const name = document.createElement("strong");
      name.textContent = message.name || "棋手";
      const time = document.createElement("span");
      time.textContent = formatTime(message.at);
      meta.append(name, time);
      const bubble = document.createElement("div");
      bubble.className = "chat-bubble";
      bubble.textContent = message.text;
      body.append(meta, bubble);
      row.append(avatar, body);
      fragment.append(row);
    }

    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "feed-empty";
      empty.textContent = "棋局动态会显示在这里";
      fragment.append(empty);
    }

    feed.replaceChildren(fragment);
    if (atBottom || !S.messageSignature) feed.scrollTop = feed.scrollHeight;
    else feed.scrollTop = feed.scrollHeight;
  }

  function renderMoves(room) {
    const moves = room.moves || [];
    const last = moves.length ? moves[moves.length - 1] : null;
    const signature = `${moves.length}:${last ? last.number : 0}`;
    if (signature === S.moveSignature) return;
    S.moveSignature = signature;

    els.moveCount.textContent = String(moves.length);
    const feed = els.moveFeed;
    const fragment = document.createDocumentFragment();

    if (!moves.length) {
      const empty = document.createElement("div");
      empty.className = "move-empty";
      empty.textContent = "落子后将在这里记录棋谱";
      fragment.append(empty);
    } else {
      for (const move of moves) {
        const item = document.createElement("div");
        item.className = "move-item";
        if (move.number === moves.length) item.classList.add("is-latest");
        const stone = document.createElement("span");
        stone.className = `move-stone ${move.seat === "white" ? "white-stone" : "black-stone"}`;
        const number = document.createElement("span");
        number.className = "move-no";
        number.textContent = String(move.number).padStart(2, "0");
        const position = document.createElement("span");
        position.className = "move-position";
        position.textContent = coordinateLabel(move.row, move.col);
        item.append(stone, number, position);
        fragment.append(item);
      }
    }

    feed.replaceChildren(fragment);
    feed.scrollTop = feed.scrollHeight;
  }

  function renderRoom(room) {
    els.roomCode.textContent = room.code;
    const onlinePlayers = [room.players.black, room.players.white].filter((player) => player && player.online).length;
    const online = onlinePlayers + (room.spectators || 0);
    els.onlineCount.replaceChildren();
    const onlineDot = document.createElement("i");
    els.onlineCount.append(onlineDot, document.createTextNode(`${Math.max(online, 1)} 在线`));

    renderPlayers(room);
    renderMainStatus(room);
    renderTurnArea(room);
    renderOverlay(room);
    renderActivity(room);
    renderMoves(room);
    updateClock();
    drawBoard();
    updateMobileStatus();
  }

  function updateClock() {
    if (!S.room || !S.room.startedAt) {
      els.gameClock.textContent = "00:00";
      return;
    }
    const end = S.room.endedAt || (Date.now() + S.clockOffset);
    const seconds = Math.max(0, Math.floor((end - S.room.startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    els.gameClock.textContent = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function updateMobileStatus() {
    if (!S.room) return;
    let text = "等待棋局开始";
    if (S.room.status === "playing") {
      text = S.room.currentTurn === S.seat ? "轮到你落子" : "等待对手落子";
    } else if (S.room.status === "finished") {
      text = "本局已结束";
    } else if (S.room.players.black && S.room.players.white) {
      text = "棋手已就位，等待双方准备";
    }
    els.mobileStatus.textContent = text;
    els.mobileStatus.classList.add("is-visible");
    window.clearTimeout(S.mobileTimer);
    S.mobileTimer = window.setTimeout(() => els.mobileStatus.classList.remove("is-visible"), 1600);
  }

  function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " is-error" : ""}`;
    toast.textContent = message;
    els.toastRegion.append(toast);
    window.setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(-4px)";
      window.setTimeout(() => toast.remove(), 220);
    }, 3000);
  }

  function switchFeedTab(tab) {
    S.feedTab = tab;
    const isActivity = tab === "activity";
    els.activityTab.classList.toggle("is-active", isActivity);
    els.movesTab.classList.toggle("is-active", !isActivity);
    els.activityTab.setAttribute("aria-selected", String(isActivity));
    els.movesTab.setAttribute("aria-selected", String(!isActivity));
    els.activityFeed.hidden = !isActivity;
    els.moveFeed.hidden = isActivity;
    els.emoteRow.hidden = !isActivity;
    if (isActivity) els.activityFeed.scrollTop = els.activityFeed.scrollHeight;
    else els.moveFeed.scrollTop = els.moveFeed.scrollHeight;
  }
  const canvas = els.canvas;
  const ctx = canvas.getContext("2d");
  let canvasDpr = 1;

  function resizeBoard() {
    if (!ctx || els.roomView.hidden) return;
    const rect = canvas.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height);
    if (size < 10) return;
    canvasDpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelSize = Math.round(size * canvasDpr);
    if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
      canvas.width = pixelSize;
      canvas.height = pixelSize;
    }
    const padding = Math.max(24, size * 0.055);
    S.metrics = {
      size,
      padding,
      step: (size - padding * 2) / (BOARD_SIZE - 1)
    };
    drawBoard();
  }

  function stoneCenter(row, col) {
    const metrics = S.metrics;
    return {
      x: metrics.padding + col * metrics.step,
      y: metrics.padding + row * metrics.step
    };
  }

  function drawStone(targetCtx, x, y, radius, seat, options = {}) {
    const alpha = options.alpha ?? 1;
    const scale = options.scale ?? 1;
    targetCtx.save();
    targetCtx.globalAlpha = alpha;
    targetCtx.translate(x, y);
    targetCtx.scale(scale, scale);
    targetCtx.shadowColor = seat === "black" ? "rgba(36,24,12,.36)" : "rgba(36,24,12,.26)";
    targetCtx.shadowBlur = radius * 0.5;
    targetCtx.shadowOffsetY = radius * 0.24;

    const gradient = targetCtx.createRadialGradient(
      -radius * 0.35,
      -radius * 0.4,
      radius * 0.04,
      0,
      0,
      radius
    );
    if (seat === "black") {
      gradient.addColorStop(0, "#6f6961");
      gradient.addColorStop(0.18, "#3b3731");
      gradient.addColorStop(0.65, "#171411");
      gradient.addColorStop(1, "#070605");
    } else {
      gradient.addColorStop(0, "#ffffff");
      gradient.addColorStop(0.42, "#f8f4ec");
      gradient.addColorStop(0.82, "#ddd4c6");
      gradient.addColorStop(1, "#bfb3a2");
    }

    targetCtx.beginPath();
    targetCtx.arc(0, 0, radius, 0, Math.PI * 2);
    targetCtx.fillStyle = gradient;
    targetCtx.fill();

    if (seat === "white") {
      targetCtx.shadowColor = "transparent";
      targetCtx.lineWidth = Math.max(0.5, radius * 0.035);
      targetCtx.strokeStyle = "rgba(65,48,29,.18)";
      targetCtx.stroke();
    }

    targetCtx.shadowColor = "transparent";
    const shine = targetCtx.createRadialGradient(
      -radius * 0.37,
      -radius * 0.43,
      0,
      -radius * 0.37,
      -radius * 0.43,
      radius * 0.55
    );
    shine.addColorStop(0, `rgba(255,255,255,${seat === "black" ? 0.22 : 0.74})`);
    shine.addColorStop(1, "rgba(255,255,255,0)");
    targetCtx.fillStyle = shine;
    targetCtx.beginPath();
    targetCtx.arc(0, 0, radius, 0, Math.PI * 2);
    targetCtx.fill();
    targetCtx.restore();
  }

  function drawBoard() {
    if (!ctx || !S.metrics) return;
    const room = S.room;
    const metrics = S.metrics;
    const { size, padding, step } = metrics;
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    const lineWidth = Math.max(0.72, size / 900);
    const labelSize = Math.max(7, size * 0.014);
    ctx.save();
    ctx.strokeStyle = "rgba(54,37,20,.63)";
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "square";

    for (let index = 0; index < BOARD_SIZE; index += 1) {
      const position = padding + index * step;
      ctx.beginPath();
      ctx.moveTo(padding, position);
      ctx.lineTo(size - padding, position);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(position, padding);
      ctx.lineTo(position, size - padding);
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(58,40,22,.68)";
    ctx.font = `500 ${labelSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let index = 0; index < BOARD_SIZE; index += 1) {
      const position = padding + index * step;
      ctx.fillText(String.fromCharCode(65 + index), position, padding * 0.46);
      ctx.fillText(String(BOARD_SIZE - index), padding * 0.43, position);
    }

    ctx.fillStyle = "rgba(45,29,15,.8)";
    const starRadius = Math.max(1.5, size * 0.0035);
    for (const row of [3, 7, 11]) {
      for (const col of [3, 7, 11]) {
        const center = stoneCenter(row, col);
        ctx.beginPath();
        ctx.arc(center.x, center.y, starRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    if (!room) return;

    const winningLine = Array.isArray(room.winningLine) ? room.winningLine : [];
    if (winningLine.length >= 2) {
      const first = stoneCenter(winningLine[0].row, winningLine[0].col);
      const last = stoneCenter(winningLine[winningLine.length - 1].row, winningLine[winningLine.length - 1].col);
      const radius = step * 0.43;
      ctx.save();
      ctx.strokeStyle = "rgba(174,63,50,.42)";
      ctx.lineWidth = Math.max(4, radius * 0.38);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      ctx.restore();
    }

    const latestMove = room.moves && room.moves.length ? room.moves[room.moves.length - 1] : null;
    let latestScale = 1;
    if (latestMove && latestMove.number === S.animateMoveNumber) {
      const elapsed = performance.now() - S.animationStart;
      if (elapsed < 210) {
        const progress = Math.max(0, Math.min(1, elapsed / 210));
        latestScale = 0.58 + 0.42 * (1 - Math.pow(1 - progress, 3));
      }
    }

    for (let row = 0; row < BOARD_SIZE; row += 1) {
      for (let col = 0; col < BOARD_SIZE; col += 1) {
        const seat = room.board[row] ? room.board[row][col] : null;
        if (!seat) continue;
        const center = stoneCenter(row, col);
        const isLatest = latestMove && latestMove.row === row && latestMove.col === col;
        drawStone(ctx, center.x, center.y, step * 0.43, seat, {
          scale: isLatest ? latestScale : 1
        });
      }
    }

    if (latestMove) {
      const center = stoneCenter(latestMove.row, latestMove.col);
      ctx.save();
      ctx.fillStyle = "#b54333";
      ctx.beginPath();
      ctx.arc(center.x, center.y, Math.max(2.1, step * 0.075), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (winningLine.length) {
      ctx.save();
      ctx.strokeStyle = "rgba(174,63,50,.82)";
      ctx.lineWidth = Math.max(1.2, step * 0.07);
      for (const point of winningLine) {
        const center = stoneCenter(point.row, point.col);
        ctx.beginPath();
        ctx.arc(center.x, center.y, step * 0.33, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (S.hover && canPlay() && !room.board[S.hover.row][S.hover.col]) {
      const center = stoneCenter(S.hover.row, S.hover.col);
      drawStone(ctx, center.x, center.y, step * 0.43, S.seat, { alpha: 0.3 });
    }

    if (latestMove && latestMove.number === S.animateMoveNumber && performance.now() - S.animationStart < 230) {
      if (!S.animationFrame) {
        S.animationFrame = requestAnimationFrame(() => {
          S.animationFrame = null;
          drawBoard();
        });
      }
    } else if (S.animateMoveNumber !== null && performance.now() - S.animationStart >= 230) {
      S.animateMoveNumber = null;
    }
  }

  function canPlay() {
    return Boolean(
      S.room &&
      S.room.status === "playing" &&
      S.seat &&
      S.room.currentTurn === S.seat &&
      !S.movePending &&
      els.overlay.hidden
    );
  }

  function pointToCell(event) {
    if (!S.metrics) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const { padding, step } = S.metrics;
    const col = Math.round((x - padding) / step);
    const row = Math.round((y - padding) / step);
    if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
    const center = stoneCenter(row, col);
    if (Math.hypot(center.x - x, center.y - y) > Math.max(step * 0.58, 11)) return null;
    return { row, col };
  }

  async function submitMove(row, col) {
    if (!canPlay() || !S.room || S.room.board[row][col]) return;
    S.movePending = true;
    els.canvas.classList.remove("is-active");
    try {
      const data = await post(`/api/rooms/${S.code}/move`, {
        token: S.token,
        row,
        col
      });
      S.hover = null;
      handleRoomUpdate(data.room);
    } catch (error) {
      showToast(error.message, true);
      if (error.status === 409) await refreshRoom();
    } finally {
      S.movePending = false;
      els.canvas.classList.toggle("is-active", canPlay());
      drawBoard();
    }
  }

  function pointerMove(event) {
    if (!canPlay()) {
      if (S.hover) {
        S.hover = null;
        drawBoard();
      }
      return;
    }
    const cell = pointToCell(event);
    const changed = (!cell && S.hover) || (cell && (!S.hover || cell.row !== S.hover.row || cell.col !== S.hover.col));
    if (changed) {
      S.hover = cell;
      drawBoard();
    }
  }

  function handleCanvasKeydown(event) {
    if (!canPlay()) return;
    const current = S.hover || { row: 7, col: 7 };
    let next = null;
    if (event.key === "ArrowUp") next = { row: Math.max(0, current.row - 1), col: current.col };
    if (event.key === "ArrowDown") next = { row: Math.min(BOARD_SIZE - 1, current.row + 1), col: current.col };
    if (event.key === "ArrowLeft") next = { row: current.row, col: Math.max(0, current.col - 1) };
    if (event.key === "ArrowRight") next = { row: current.row, col: Math.min(BOARD_SIZE - 1, current.col + 1) };
    if (next) {
      event.preventDefault();
      S.hover = next;
      drawBoard();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && S.hover) {
      event.preventDefault();
      submitMove(S.hover.row, S.hover.col);
    }
  }

  function ensureAudio() {
    if (!S.sound) return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!S.audioContext) S.audioContext = new AudioCtor();
    if (S.audioContext.state === "suspended") S.audioContext.resume();
    return S.audioContext;
  }

  function playTone(frequency, duration, delay = 0, type = "sine", volume = 0.035) {
    const audio = ensureAudio();
    if (!audio) return;
    const start = audio.currentTime + delay;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function playStoneSound(seat) {
    if (!S.sound) return;
    playTone(seat === "white" ? 250 : 180, 0.055, 0, "triangle", 0.045);
    playTone(seat === "white" ? 125 : 92, 0.08, 0.006, "sine", 0.026);
  }

  function playFinishSound(winner) {
    if (!S.sound) return;
    if (winner === "draw") {
      playTone(196, 0.24, 0.02, "sine", 0.03);
      playTone(196, 0.24, 0.28, "sine", 0.03);
      return;
    }
    [293.66, 369.99, 440, 587.33].forEach((frequency, index) => {
      playTone(frequency, 0.24, index * 0.11, "sine", 0.032);
    });
  }

  function updateSoundButton() {
    els.soundToggle.classList.toggle("is-muted", !S.sound);
    els.soundToggle.setAttribute("aria-label", S.sound ? "关闭音效" : "开启音效");
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.append(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }

  function inviteUrl() {
    return `${window.location.origin}${appBasePath()}?room=${encodeURIComponent(S.code || "")}`;
  }

  async function copyInvite() {
    if (!S.code) return;
    const copied = await copyText(inviteUrl());
    showToast(copied ? "邀请链接已复制，发给朋友即可入座" : "复制失败，请手动复制地址栏链接", !copied);
  }

  async function copyRoomCode() {
    if (!S.code) return;
    const copied = await copyText(S.code);
    showToast(copied ? `房间号 ${S.code} 已复制` : "复制失败，请手动记录房间号", !copied);
  }

  async function handlePrimaryAction() {
    if (S.actionPending || !S.room || !S.seat) return;
    const mode = els.primaryAction.dataset.mode;
    if (!mode || mode === "rematch" && els.primaryAction.disabled) return;
    S.actionPending = true;
    els.primaryAction.disabled = true;
    try {
      let data;
      if (mode === "ready" || mode === "unready") {
        data = await post(`/api/rooms/${S.code}/ready`, {
          token: S.token,
          ready: mode === "ready"
        });
      } else if (mode === "rematch") {
        data = await post(`/api/rooms/${S.code}/rematch`, { token: S.token });
      } else {
        return;
      }
      handleRoomUpdate(data.room);
    } catch (error) {
      showToast(error.message, true);
      await refreshRoom();
    } finally {
      S.actionPending = false;
      if (S.room) renderMainStatus(S.room);
    }
  }

  async function sendChat(text) {
    const message = String(text || "").trim().slice(0, 120);
    if (!message || !S.code || !S.token) return;
    try {
      await post(`/api/rooms/${S.code}/chat`, { token: S.token, text: message });
      switchFeedTab("activity");
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function leaveRoom() {
    const code = S.code;
    const token = S.token;
    closeEventSource();
    if (code && token) {
      try {
        await post(`/api/rooms/${code}/leave`, { token });
        localStorage.removeItem(tokenKey(code));
      } catch {}
    }
    showLanding(null, "你已离开棋局，可以创建新的房间。");
    history.replaceState({}, "", appBasePath());
  }

  function requestLeave() {
    if (!S.room) {
      showLanding();
      history.replaceState({}, "", appBasePath());
      return;
    }
    if (typeof els.leaveDialog.showModal === "function") {
      els.leaveDialog.showModal();
    } else if (window.confirm("要离开这局棋吗？")) {
      leaveRoom();
    }
  }

  function bindEvents() {
    els.primaryEntryBtn.addEventListener("click", () => {
      if (S.inviteCode) joinRoom(S.inviteCode);
      else createRoom();
    });

    els.joinEntryBtn.addEventListener("click", () => {
      const code = parseRoomCode(els.roomCodeInput.value);
      if (!code) {
        showToast("请输入正确的房间号或邀请链接", true);
        return;
      }
      joinRoom(code);
    });

    els.roomCodeInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.joinEntryBtn.click();
      }
    });

    els.nicknameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        els.primaryEntryBtn.click();
      }
    });

    els.nicknameInput.addEventListener("change", () => {
      localStorage.setItem(NAME_KEY, normalizeName(els.nicknameInput.value));
    });

    els.roomCodeBtn.addEventListener("click", copyRoomCode);
    els.shareInviteBtn.addEventListener("click", copyInvite);
    els.overlayShareBtn.addEventListener("click", copyInvite);
    els.primaryAction.addEventListener("click", handlePrimaryAction);

    els.activityTab.addEventListener("click", () => switchFeedTab("activity"));
    els.movesTab.addEventListener("click", () => switchFeedTab("moves"));

    els.chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = els.chatInput.value;
      els.chatInput.value = "";
      await sendChat(text);
    });

    for (const button of els.emoteRow.querySelectorAll("button[data-emote]")) {
      button.addEventListener("click", () => sendChat(button.dataset.emote));
    }

    els.soundToggle.addEventListener("click", () => {
      S.sound = !S.sound;
      localStorage.setItem(SOUND_KEY, S.sound ? "on" : "off");
      updateSoundButton();
      if (S.sound) playTone(330, 0.08, 0, "sine", 0.02);
    });

    els.leaveBtn.addEventListener("click", requestLeave);
    els.roomHomeLink.addEventListener("click", (event) => {
      if (!S.room) return;
      event.preventDefault();
      requestLeave();
    });

    els.leaveDialog.addEventListener("close", () => {
      if (els.leaveDialog.returnValue === "confirm") leaveRoom();
    });

    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerleave", () => {
      if (S.hover) {
        S.hover = null;
        drawBoard();
      }
    });
    canvas.addEventListener("click", (event) => {
      if (!canPlay()) return;
      const cell = pointToCell(event);
      if (cell) submitMove(cell.row, cell.col);
    });
    canvas.addEventListener("keydown", handleCanvasKeydown);

    document.addEventListener("pointerdown", ensureAudio, { once: true });
    window.addEventListener("resize", resizeBoard);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && S.code && !S.connected) refreshRoom();
    });

    window.addEventListener("beforeunload", () => {
      if (S.nicknameInputSafe) localStorage.setItem(NAME_KEY, S.nicknameInputSafe);
    });
  }

  function init() {
    els.nicknameInput.value = getStoredName();
    updateSoundButton();
    bindEvents();
    switchFeedTab("activity");

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() => resizeBoard());
      observer.observe(canvas);
    }

    window.setInterval(updateClock, 1000);
    window.setInterval(() => {
      if (S.code && !S.connected) refreshRoom();
    }, 12000);

    const invite = parseRoomCode(new URLSearchParams(window.location.search).get("room") || "");
    if (!invite) {
      showLanding();
      return;
    }

    tryResume(invite).then((resumed) => {
      if (!resumed) showLanding(invite);
    });
  }

  init();
})();