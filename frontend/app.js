(() => {
  "use strict";

  const pieceSymbols = {
    wk: "♔", wq: "♕", wr: "♖", wb: "♗", wn: "♘", wp: "♙",
    bk: "♚", bq: "♛", br: "♜", bb: "♝", bn: "♞", bp: "♟"
  };
  const timeControls = {
    bullet: { label: "Bullet", seconds: 60, increment: 0, display: "1 + 0" },
    blitz: { label: "Blitz", seconds: 300, increment: 0, display: "5 + 0" },
    rapid: { label: "Rapid", seconds: 600, increment: 0, display: "10 + 0" }
  };
  const game = typeof window.Chess === "function" ? new window.Chess() : null;
  const board = document.getElementById("chessboard");
  const feedback = document.getElementById("gameFeedback");
  const gameFeedback = document.getElementById("positionStatus");
  const moveList = document.getElementById("moveList");
  const modalBackdrop = document.getElementById("modalBackdrop");
  const toast = document.getElementById("toast");
  let selectedSquare = null;
  let legalTargets = [];
  let flipped = false;
  let selectedTime = "blitz";
  let clocks = { w: 600, b: 600 };
  let timer = null;
  let toastTimer = null;
  let gameStarted = false;
  let gameFinished = false;
  let socket = null;
  let socketReady = false;
  let onlineMode = false;
  let spectatorMode = false;
  let pendingMove = false;
  let playerColor = null;
  let currentRoomId = null;
  let serverGameState = null;
  let onlineClockTimer = null;
  let rematchRequested = false;
  let playerName = localStorage.getItem("housePlayerName") || "Guest";
  let playerId = localStorage.getItem("housePlayerId");

  if (!playerId) {
    playerId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `player_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
    localStorage.setItem("housePlayerId", playerId);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
  }

  function emitBackendEvent(eventName, detail = {}) {
    window.dispatchEvent(new CustomEvent(`house:${eventName}`, { detail }));
  }

  function setFeedback(message) {
    feedback.textContent = message;
  }

  function currentControl() {
    return timeControls[selectedTime];
  }

  function setConnectionStatus(message, connected = false) {
    const status = document.getElementById("backendConnectionStatus");
    status.lastChild.textContent = ` ${message}`;
    status.classList.toggle("connected", connected);
    document.getElementById("findGameButton").disabled = !connected;
    document.getElementById("joinGameButton").disabled = !connected;
    document.getElementById("watchGameButton").disabled = !connected;
    document.getElementById("backendNote").textContent = connected
      ? "Create a room and share its code with a friend."
      : message;
  }

  function sendSocketEvent(eventName, payload) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) {
        resolve({ ok: false, error: "The chess server is not connected." });
        return;
      }
      const timeout = setTimeout(() => {
        resolve({ ok: false, error: "The server did not respond. Please try again." });
      }, 5000);
      socket.emit(eventName, payload, (response) => {
        clearTimeout(timeout);
        resolve(response || { ok: false, error: "The server returned an empty response." });
      });
    });
  }

  function currentIdentity() {
    return { playerId, name: playerName };
  }

  function selectedServerTimeControl() {
    const control = currentControl();
    return {
      minutes: control.seconds / 60,
      incrementSeconds: control.increment,
    };
  }

  function updateOnlineClockDisplay() {
    if (!onlineMode || !serverGameState) return;
    const clockState = serverGameState.clock;
    clocks = {
      w: Math.ceil(clockState.whiteMs / 1000),
      b: Math.ceil(clockState.blackMs / 1000),
    };
    if (clockState.running && clockState.deadlineAt) {
      clocks[serverGameState.turn] = Math.max(0, Math.ceil((clockState.deadlineAt - Date.now()) / 1000));
    }
    updateClocks();
  }

  function startOnlineClock() {
    if (onlineClockTimer !== null) clearInterval(onlineClockTimer);
    onlineClockTimer = null;
    if (!onlineMode || !serverGameState || !serverGameState.clock.running) return;
    onlineClockTimer = setInterval(updateOnlineClockDisplay, 250);
  }

  function updateRoomUrl(roomId) {
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    history.replaceState(null, "", url);
  }

  function clearRoomUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url);
  }

  function appendChatMessage(message) {
    const messages = document.getElementById("chatMessages");
    const empty = messages.querySelector(".chat-empty");
    if (empty) empty.remove();
    const item = document.createElement("li");
    const sender = document.createElement("strong");
    sender.textContent = message.sender || "Player";
    const body = document.createElement("span");
    body.textContent = message.message;
    item.append(sender, body);
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
  }

  function applyServerState(state) {
    if (!state || !game) return;
    const changedGame = !serverGameState || state.gameId !== serverGameState.gameId;
    serverGameState = state;
    currentRoomId = state.roomId;
    if (changedGame) {
      selectedSquare = null;
      legalTargets = [];
      pendingMove = false;
      rematchRequested = false;
      document.getElementById("chatMessages").replaceChildren();
    }

    game.reset();
    if (state.pgn) {
      game.load_pgn(state.pgn);
    }
    gameStarted = state.status === "active" || state.moves.length > 0;
    gameFinished = state.status === "finished";
    if (gameFinished) stopTimer();
    document.getElementById("rematchButton").classList.toggle(
      "hidden",
      !gameFinished || spectatorMode,
    );
    document.getElementById("rematchButton").disabled = rematchRequested;
    document.getElementById("opponentName").textContent = playerColor === "w"
      ? state.playerNames.black
      : playerColor === "b" ? state.playerNames.white : "Live game";
    document.getElementById("opponentRating").textContent = state.status === "waiting"
      ? "Waiting for a player to join"
      : spectatorMode ? `${state.spectators} watching` : `Room ${state.roomId}`;
    document.querySelector("#whiteClock .clock-name").textContent = playerColor === "w"
      ? "You · White" : spectatorMode ? "White" : "White";
    document.querySelector("#blackClock .clock-name").textContent = playerColor === "b"
      ? "You · Black" : "Black";
    document.getElementById("drawButton").disabled = spectatorMode || gameFinished || state.status !== "active";
    document.getElementById("resignButton").disabled = spectatorMode || gameFinished || state.status !== "active";
    document.getElementById("chatStatus").textContent = state.status === "waiting"
      ? "Chat is ready when your opponent joins."
      : `${state.spectators} watching · Room ${state.roomId}`;
    document.getElementById("roomIdInput").value = state.roomId;
    updateOnlineClockDisplay();
    renderBoard();

    if (gameFinished) {
      const resultText = state.termination === "timeout" ? "Game ended on time."
        : state.termination === "resignation" ? "Game ended by resignation."
          : state.termination === "agreed_draw" ? "Draw agreed."
            : state.termination === "checkmate" ? "Checkmate."
              : "Game over.";
      setFeedback(resultText);
      gameFeedback.innerHTML = `<span class="status-pip"></span> ${resultText} ${state.result || ""}`;
      document.getElementById("turnLabel").textContent = state.result || "Game over";
    } else if (state.status === "waiting") {
      setFeedback("Share the room code with a friend.");
      gameFeedback.innerHTML = '<span class="status-pip"></span> Waiting for an opponent';
    } else if (state.check) {
      setFeedback("Check!");
      gameFeedback.innerHTML = '<span class="status-pip"></span> Check';
    } else {
      setFeedback("");
      gameFeedback.innerHTML = `<span class="status-pip"></span> ${spectatorMode ? "Watching live" : `${state.playerNames[state.turn === "w" ? "white" : "black"]} to move`}`;
    }

    if (state.drawOffer && playerColor && state.drawOffer !== playerColor) {
      gameFeedback.innerHTML = '<span class="status-pip"></span> Your opponent offered a draw';
    }
    startOnlineClock();
  }

  function initializeSocket() {
    if (socket || typeof window.io !== "function") return;
    socket = window.io();
    socket.on("connect", () => {
      socketReady = true;
      setConnectionStatus("Server connected", true);
      const roomFromUrl = new URLSearchParams(window.location.search).get("room");
      if (roomFromUrl && !currentRoomId) {
        document.getElementById("roomIdInput").value = roomFromUrl;
        joinOnlineGame(roomFromUrl);
      }
    });
    socket.on("disconnect", () => {
      socketReady = false;
      setConnectionStatus("Server disconnected");
      if (onlineMode) setFeedback("Connection lost. The game will update if the server reconnects.");
    });
    socket.on("connect_error", () => setConnectionStatus("Could not reach server"));
    socket.on("gameState", applyServerState);
    socket.on("gameError", ({ error }) => showToast(error || "The server rejected that action."));
    socket.on("playerDisconnected", ({ color }) => {
      setFeedback(`${color === "w" ? "White" : "Black"} disconnected. Waiting for them to return.`);
    });
    socket.on("chatMessage", appendChatMessage);
    socket.on("drawOffered", ({ color }) => {
      if (!playerColor || color === playerColor) return;
      if (window.confirm("Your opponent offered a draw. Accept?")) {
        sendSocketEvent("respondDraw", { roomId: currentRoomId, accept: true });
      } else {
        sendSocketEvent("respondDraw", { roomId: currentRoomId, accept: false });
      }
    });
    socket.on("drawAccepted", () => showToast("Draw agreed."));
    socket.on("drawOfferDeclined", () => showToast("Draw offer declined."));
    socket.on("rematchOffered", ({ name }) => showToast(`${name} requested a rematch.`));
    socket.on("rematchStarted", () => {
      playerColor = playerColor === "w" ? "b" : "w";
      showToast("Rematch started. Colors have switched.");
    });
    socket.on("spectatorCount", ({ count }) => {
      if (serverGameState) {
        serverGameState.spectators = count;
        applyServerState(serverGameState);
      }
    });
    socket.on("persistenceError", ({ message }) => showToast(message));
  }

  async function createOnlineGame() {
    if (!socketReady) {
      showToast("The chess server is not connected yet.");
      return;
    }
    if (currentRoomId) {
      await sendSocketEvent("leaveGame", { roomId: currentRoomId });
      onlineMode = false;
      spectatorMode = false;
      playerColor = null;
      currentRoomId = null;
      serverGameState = null;
    }
    const response = await sendSocketEvent("createGame", {
      ...currentIdentity(),
      timeControl: selectedServerTimeControl(),
    });
    if (!response.ok) {
      showToast(response.error);
      return;
    }
    onlineMode = true;
    spectatorMode = false;
    playerColor = response.color;
    applyServerState(response.state);
    updateRoomUrl(response.roomId);
    showToast(`Game created. Share room code ${response.roomId} with your friend.`);
  }

  async function joinOnlineGame(roomId = document.getElementById("roomIdInput").value.trim()) {
    if (!socketReady) {
      showToast("The chess server is not connected yet.");
      return;
    }
    if (currentRoomId) {
      await sendSocketEvent("leaveGame", { roomId: currentRoomId });
      onlineMode = false;
      spectatorMode = false;
      playerColor = null;
      currentRoomId = null;
      serverGameState = null;
    }
    const response = await sendSocketEvent("joinGame", {
      roomId,
      ...currentIdentity(),
    });
    if (!response.ok) {
      showToast(response.error);
      return;
    }
    onlineMode = true;
    spectatorMode = false;
    playerColor = response.color;
    applyServerState(response.state);
    updateRoomUrl(response.roomId);
    showToast(`Joined ${response.roomId} as ${playerColor === "w" ? "White" : "Black"}.`);
  }

  async function watchOnlineGame() {
    const roomId = document.getElementById("roomIdInput").value.trim();
    if (currentRoomId) {
      await sendSocketEvent("leaveGame", { roomId: currentRoomId });
      onlineMode = false;
      spectatorMode = false;
      playerColor = null;
      currentRoomId = null;
      serverGameState = null;
    }
    const response = await sendSocketEvent("watchGame", { roomId, name: playerName });
    if (!response.ok) {
      showToast(response.error);
      return;
    }
    onlineMode = true;
    spectatorMode = true;
    playerColor = null;
    applyServerState(response.state);
    updateRoomUrl(response.roomId);
    showToast(`Watching room ${response.roomId}.`);
  }

  function formatTime(seconds) {
    const safeSeconds = Math.max(0, seconds);
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function updateClocks() {
    document.querySelector("#whiteClock strong").textContent = formatTime(clocks.w);
    document.querySelector("#blackClock strong").textContent = formatTime(clocks.b);
    const whiteTurn = game && game.turn() === "w" && !gameFinished;
    document.getElementById("whiteClock").classList.toggle("active-clock", Boolean(whiteTurn));
    document.getElementById("blackClock").classList.toggle("active-clock", Boolean(game && !whiteTurn && !gameFinished));
  }

  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function finishGame(result, message) {
    gameFinished = true;
    stopTimer();
    setFeedback(message);
    document.getElementById("turnLabel").textContent = result;
    gameFeedback.innerHTML = `<span class="status-pip"></span> ${message}`;
    updateClocks();
    if (!onlineMode) emitBackendEvent("game-finished", { result, pgn: game ? game.pgn() : "" });
  }

  function startTimer() {
    stopTimer();
    if (onlineMode) {
      startOnlineClock();
      return;
    }
    if (!gameStarted || gameFinished || !game) return;
    timer = setInterval(() => {
      const activeColor = game.turn();
      clocks[activeColor] -= 1;
      updateClocks();
      if (clocks[activeColor] <= 0) {
        finishGame(activeColor === "w" ? "Black wins on time" : "White wins on time", "Time is up.");
        emitBackendEvent("game-timeout", { flagged: activeColor });
      }
    }, 1000);
  }

  function getBoardSquares() {
    const files = flipped ? "hgfedcba" : "abcdefgh";
    const ranks = flipped ? "12345678" : "87654321";
    return { files, ranks };
  }

  function renderBoard() {
    if (!game || !board) return;
    const { files, ranks } = getBoardSquares();
    const verboseMoves = game.history({ verbose: true });
    const lastMove = verboseMoves.length ? verboseMoves[verboseMoves.length - 1] : null;
    const checkedKing = game.in_check() ? "k" : null;
    const rows = [];

    ranks.split("").forEach((rank, rowIndex) => {
      files.split("").forEach((file, columnIndex) => {
        const squareName = `${file}${rank}`;
        const piece = game.get(squareName);
        const isLight = (rowIndex + columnIndex) % 2 === 0;
        const square = document.createElement("button");
        square.type = "button";
        square.className = `square ${isLight ? "light" : "dark"}`;
        square.setAttribute("role", "gridcell");
        square.setAttribute("aria-label", `${squareName}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ""}`);
        square.dataset.square = squareName;
        if (selectedSquare === squareName) square.classList.add("selected");
        if (lastMove && (lastMove.from === squareName || lastMove.to === squareName)) square.classList.add("last-move");
        if (legalTargets.includes(squareName)) {
          square.classList.add("legal-move");
          if (piece) square.classList.add("has-piece");
        }
        if (piece && checkedKing === piece.type && piece.color === game.turn()) square.classList.add("in-check");

        if (piece) {
          const glyph = document.createElement("span");
          glyph.className = `piece ${piece.color === "w" ? "piece-white" : "piece-black"}`;
          glyph.setAttribute("aria-hidden", "true");
          glyph.textContent = pieceSymbols[piece.color + piece.type];
          square.appendChild(glyph);
        }
        if (columnIndex === 0) {
          const rankLabel = document.createElement("span");
          rankLabel.className = "coordinates rank";
          rankLabel.textContent = rank;
          square.appendChild(rankLabel);
        }
        if (rowIndex === 7) {
          const fileLabel = document.createElement("span");
          fileLabel.className = "coordinates";
          fileLabel.textContent = file;
          square.appendChild(fileLabel);
        }
        square.addEventListener("click", () => handleSquareClick(squareName));
        rows.push(square);
      });
    });

    board.replaceChildren(...rows);
    const rankLabels = document.getElementById("rankLabels");
    const fileLabels = document.getElementById("fileLabels");
    rankLabels.replaceChildren(...ranks.split("").map(rank => {
      const label = document.createElement("span");
      label.textContent = rank;
      return label;
    }));
    fileLabels.replaceChildren(...files.split("").map(file => {
      const label = document.createElement("span");
      label.textContent = file;
      return label;
    }));
    updateMoveList();
    updateClocks();
    document.getElementById("moveCount").textContent = `Move ${Math.floor(game.history().length / 2) + 1}`;
    document.getElementById("turnLabel").textContent = `${game.turn() === "w" ? "White" : "Black"} to move`;
    document.getElementById("moveTabCount").textContent = String(game.history().length);
  }

  function updateMoveList() {
    const history = game.history();
    moveList.replaceChildren();
    if (history.length === 0) {
      const empty = document.createElement("li");
      empty.className = "empty-moves";
      empty.textContent = "Your moves will show up here.";
      moveList.appendChild(empty);
      return;
    }
    for (let index = 0; index < history.length; index += 2) {
      const number = document.createElement("li");
      number.className = "move-number";
      number.textContent = `${Math.floor(index / 2) + 1}.`;
      const whiteMove = document.createElement("li");
      whiteMove.textContent = history[index];
      moveList.append(number, whiteMove);
      const blackMove = document.createElement("li");
      blackMove.textContent = history[index + 1] || "…";
      moveList.appendChild(blackMove);
    }
  }

  function updateGameStatus() {
    if (!game) return;
    if (game.in_checkmate()) {
      finishGame(game.turn() === "w" ? "Black wins by checkmate" : "White wins by checkmate", "Checkmate. What a game.");
    } else if (game.in_stalemate()) {
      finishGame("Draw by stalemate", "Stalemate — a draw.");
    } else if (game.in_draw()) {
      finishGame("Game drawn", "The game is a draw.");
    } else if (game.in_check()) {
      setFeedback("Check!");
      gameFeedback.innerHTML = '<span class="status-pip"></span> Check';
    } else {
      setFeedback("");
      gameFeedback.innerHTML = '<span class="status-pip"></span> Game in progress';
    }
  }

  function handleSquareClick(squareName) {
    if (!game || gameFinished || game.game_over() || pendingMove || (onlineMode && (spectatorMode || !playerColor))) {
      if (gameFinished) showToast("This game is over. Start a new one to play again.");
      return;
    }
    if (onlineMode && (!serverGameState || serverGameState.status !== "active" || game.turn() !== playerColor)) {
      if (!spectatorMode) showToast("Wait for your turn.");
      return;
    }

    const clickedPiece = game.get(squareName);
    if (selectedSquare && legalTargets.includes(squareName)) {
      if (onlineMode) {
        const legalMove = game.moves({ square: selectedSquare, verbose: true })
          .find(move => move.to === squareName);
        pendingMove = true;
        sendSocketEvent("makeMove", {
          roomId: currentRoomId,
          from: selectedSquare,
          to: squareName,
          ...(legalMove && legalMove.promotion ? { promotion: legalMove.promotion } : {})
        }).then(response => {
          pendingMove = false;
          if (!response.ok) {
            showToast(response.error);
            return;
          }
          selectedSquare = null;
          legalTargets = [];
          applyServerState(response.state);
        });
        return;
      }
      try {
        const move = game.move({ from: selectedSquare, to: squareName, promotion: "q" });
        if (move) {
          if (gameStarted) clocks[move.color] += currentControl().increment;
          selectedSquare = null;
          legalTargets = [];
          gameStarted = true;
          renderBoard();
          updateGameStatus();
          startTimer();
          emitBackendEvent("move", { move, fen: game.fen(), pgn: game.pgn() });
          return;
        }
      } catch (error) {
        setFeedback("That move isn't legal. Try another square.");
      }
    }

    if (clickedPiece && clickedPiece.color === game.turn()) {
      selectedSquare = squareName;
      legalTargets = game.moves({ square: squareName, verbose: true }).map(move => move.to);
    } else {
      selectedSquare = null;
      legalTargets = [];
    }
    renderBoard();
  }

  function resetGame(control = selectedTime, local = false) {
    if (!game) {
      showToast("Chess rules could not load. Check your internet connection and reload.");
      return;
    }
    selectedTime = control;
    if (currentRoomId && socket && socket.connected) {
      sendSocketEvent("leaveGame", { roomId: currentRoomId });
      clearRoomUrl();
    }
    onlineMode = false;
    spectatorMode = false;
    playerColor = null;
    currentRoomId = null;
    serverGameState = null;
    pendingMove = false;
    if (onlineClockTimer !== null) clearInterval(onlineClockTimer);
    onlineClockTimer = null;
    game.reset();
    selectedSquare = null;
    legalTargets = [];
    clocks = { w: currentControl().seconds, b: currentControl().seconds };
    gameStarted = false;
    gameFinished = false;
    stopTimer();
    setFeedback(local ? "Local game ready. Play either side." : "Choose how you’d like to play.");
    gameFeedback.innerHTML = '<span class="status-pip"></span> Ready when you are';
    document.getElementById("opponentName").textContent = local ? "Local game" : "Waiting for a player";
    document.getElementById("opponentRating").textContent = local ? `${currentControl().label} · play either side` : "Choose how you’d like to play";
    document.querySelector("#whiteClock .clock-name").textContent = local ? "White" : "You · White";
    document.getElementById("rematchButton").classList.add("hidden");
    document.getElementById("resignButton").disabled = false;
    document.getElementById("drawButton").disabled = false;
    renderBoard();
    emitBackendEvent("game-reset", { control: currentControl(), local });
  }

  function exportText(text, label) {
    if (!text) {
      showToast("There are no moves to export yet.");
      return;
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => showToast(`${label} copied to clipboard.`)).catch(() => downloadText(text, label));
    } else {
      downloadText(text, label);
    }
  }

  function downloadText(text, label) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `house-game.${label.toLowerCase()}`;
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(`${label} downloaded.`);
  }

  function setView(viewName) {
    document.querySelectorAll(".view-panel").forEach(panel => panel.classList.remove("active"));
    document.getElementById(`${viewName}View`)?.classList.add("active");
    document.querySelectorAll(".nav-link").forEach(link => link.classList.toggle("active", link.dataset.view === viewName));
    const selected = document.querySelector(`.nav-link[data-view="${viewName}"]`);
    document.getElementById("pageTitle").textContent = selected ? selected.textContent.trim().replace(/\s+NEW$/, "") : "Play";
    document.getElementById("sidebar").classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openSignup() {
    modalBackdrop.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    document.getElementById("playerName").focus();
  }

  function closeModal() {
    modalBackdrop.classList.add("hidden");
    document.body.style.overflow = "";
  }

  document.querySelectorAll(".nav-link").forEach(button => button.addEventListener("click", () => setView(button.dataset.view)));
  document.querySelectorAll("[data-view-link]").forEach(button => button.addEventListener("click", () => setView(button.dataset.viewLink)));
  document.querySelectorAll(".panel-tab").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(tab => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".tab-content").forEach(tab => tab.classList.toggle("active", tab.id === `${button.dataset.tab}Tab`));
  }));
  document.querySelectorAll(".time-option").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll(".time-option").forEach(option => option.classList.toggle("active", option === button));
    selectedTime = button.dataset.time;
    if (!gameStarted) {
      clocks = { w: currentControl().seconds, b: currentControl().seconds };
      updateClocks();
    }
  }));

  document.getElementById("findGameButton").addEventListener("click", () => {
    createOnlineGame();
  });
  document.getElementById("joinGameButton").addEventListener("click", () => {
    joinOnlineGame();
  });
  document.getElementById("roomIdInput").addEventListener("keydown", event => {
    if (event.key === "Enter") joinOnlineGame();
  });
  document.getElementById("watchGameButton").addEventListener("click", watchOnlineGame);
  document.getElementById("chatForm").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("chatInput");
    const message = input.value.trim();
    if (!currentRoomId || !message) {
      showToast("Join a game before sending a message.");
      return;
    }
    const response = await sendSocketEvent("sendChat", { roomId: currentRoomId, message });
    if (!response.ok) {
      showToast(response.error);
      return;
    }
    input.value = "";
  });
  document.getElementById("playComputerButton").addEventListener("click", () => {
    resetGame(selectedTime, true);
    document.getElementById("opponentName").textContent = "Local game";
    document.getElementById("opponentRating").textContent = `${currentControl().label} · play either side`;
    document.querySelector("#whiteClock .clock-name").textContent = "White";
    setFeedback("Local game ready. Play either side.");
    showToast("Local game ready. Play either side on this device.");
  });
  document.getElementById("inviteButton").addEventListener("click", async () => {
    await createOnlineGame();
    if (!currentRoomId) return;
    const inviteUrl = new URL(window.location.href);
    inviteUrl.searchParams.set("room", currentRoomId);
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(inviteUrl.href);
        showToast(`Invite link copied. Room code: ${currentRoomId}`);
      } catch (_error) {
        showToast(`Share room code ${currentRoomId} with your friend.`);
      }
    } else {
      showToast(`Share room code ${currentRoomId} with your friend.`);
    }
  });
  document.getElementById("flipBoard").addEventListener("click", () => { flipped = !flipped; renderBoard(); });
  document.getElementById("resignButton").addEventListener("click", () => {
    if (!game || gameFinished || !gameStarted) { showToast("Start a game before resigning."); return; }
    if (!window.confirm("Resign this game?")) return;
    if (onlineMode) {
      sendSocketEvent("resign", { roomId: currentRoomId }).then(response => {
        if (!response.ok) showToast(response.error);
        else applyServerState(response.state);
      });
    } else {
      finishGame(game.turn() === "w" ? "Black wins by resignation" : "White wins by resignation", "Game ended by resignation.");
    }
  });
  document.getElementById("drawButton").addEventListener("click", () => {
    if (!gameStarted) { showToast("Start a game before offering a draw."); return; }
    if (onlineMode) {
      sendSocketEvent("offerDraw", { roomId: currentRoomId }).then(response => {
        if (!response.ok) showToast(response.error);
        else showToast("Draw offer sent to your opponent.");
      });
      return;
    }
    emitBackendEvent("draw-offer", { fen: game.fen() });
    showToast("Draw offers are available during online games.");
  });
  document.getElementById("rematchButton").addEventListener("click", async () => {
    if (!onlineMode || !currentRoomId) return;
    const response = await sendSocketEvent("requestRematch", { roomId: currentRoomId });
    if (!response.ok) {
      showToast(response.error);
      return;
    }
    rematchRequested = true;
    document.getElementById("rematchButton").disabled = true;
    if (!response.started) showToast("Rematch requested. Waiting for the other player.");
  });
  document.getElementById("exportPgn").addEventListener("click", () => exportText(game ? game.pgn() : "", "PGN"));
  document.getElementById("copyPgn").addEventListener("click", () => exportText(game ? game.pgn() : "", "PGN"));
  document.getElementById("copyFen").addEventListener("click", () => exportText(game ? game.fen() : "", "FEN"));
  document.getElementById("gameMenuButton").addEventListener("click", () => document.getElementById("gameMenu").classList.toggle("hidden"));
  document.getElementById("reportOpponent").addEventListener("click", () => {
    document.getElementById("gameMenu").classList.add("hidden");
    emitBackendEvent("report-request", {});
    showToast("Player reports and blocking will be available with online play.");
  });
  document.getElementById("mobileMenu").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
  document.getElementById("topSignup").addEventListener("click", openSignup);
  document.getElementById("accountButton").addEventListener("click", openSignup);
  document.getElementById("profileSignup").addEventListener("click", openSignup);
  document.getElementById("settingsButton").addEventListener("click", () => {
    setView("profile");
    showToast("Your game preferences are ready to customize.");
  });
  document.getElementById("modalClose").addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", event => { if (event.target === modalBackdrop) closeModal(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeModal();
      document.getElementById("gameMenu").classList.add("hidden");
      document.getElementById("sidebar").classList.remove("open");
    }
  });
  document.getElementById("signupForm").addEventListener("submit", event => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    playerName = String(formData.get("playerName")).trim();
    localStorage.setItem("housePlayerName", playerName);
    document.querySelector("#accountButton .account-copy strong").textContent = playerName;
    document.querySelector("#accountButton .account-copy span").textContent = "Guest player";
    document.getElementById("formMessage").textContent = "Your display name has been saved on this device. Account sign-up is not enabled yet.";
    closeModal();
    showToast(`You’ll play online as ${playerName}.`);
  });
  document.getElementById("loginLink").addEventListener("click", () => {
    emitBackendEvent("login-request", {});
    document.getElementById("formMessage").textContent = "Connect this form to your login API to sign in.";
  });
  document.querySelectorAll(".coming-soon").forEach(button => button.addEventListener("click", () => showToast(`${button.dataset.feature} will be available soon.`)));

  if (game) {
    resetGame("blitz");
  } else {
    setFeedback("Chess rules could not load. Check your internet connection and reload.");
    showToast("The chess rules library could not load.");
  }
  document.querySelector("#accountButton .account-copy strong").textContent = playerName;
  document.getElementById("backendConnectionStatus").lastChild.textContent = " Connecting…";
  initializeSocket();
  if (!socket) setConnectionStatus("Socket.IO client did not load");
})();
