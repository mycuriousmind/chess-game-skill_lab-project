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
    emitBackendEvent("game-finished", { result, pgn: game ? game.pgn() : "" });
  }

  function startTimer() {
    stopTimer();
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
    if (!game || gameFinished || game.game_over()) {
      if (gameFinished) showToast("This game is over. Start a new one to play again.");
      return;
    }

    const clickedPiece = game.get(squareName);
    if (selectedSquare && legalTargets.includes(squareName)) {
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
    emitBackendEvent("matchmaking-request", { control: currentControl() });
    showToast("Online matchmaking needs a server connection. Try a local game for now.");
  });
  document.getElementById("playComputerButton").addEventListener("click", () => {
    resetGame();
    document.getElementById("opponentName").textContent = "Local game";
    document.getElementById("opponentRating").textContent = `${currentControl().label} · play either side`;
    document.querySelector("#whiteClock .clock-name").textContent = "White";
    setFeedback("Local game ready. Play either side.");
    showToast("Local game ready. Play either side on this device.");
  });
  document.getElementById("inviteButton").addEventListener("click", () => {
    emitBackendEvent("invite-request", { control: currentControl() });
    showToast("Friend invites will be available when online play is connected.");
  });
  document.getElementById("flipBoard").addEventListener("click", () => { flipped = !flipped; renderBoard(); });
  document.getElementById("resignButton").addEventListener("click", () => {
    if (!game || gameFinished || !gameStarted) { showToast("Start a game before resigning."); return; }
    if (window.confirm("Resign this game?")) finishGame(game.turn() === "w" ? "Black wins by resignation" : "White wins by resignation", "Game ended by resignation.");
  });
  document.getElementById("drawButton").addEventListener("click", () => {
    if (!gameStarted) { showToast("Start a game before offering a draw."); return; }
    emitBackendEvent("draw-offer", { fen: game.fen() });
    showToast("Draw offers will reach your opponent once online play is connected.");
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
    emitBackendEvent("signup-request", {
      name: formData.get("playerName"),
      email: formData.get("playerEmail"),
      password: formData.get("playerPassword")
    });
    document.getElementById("formMessage").textContent = "Thanks! Connect this form to your account API to finish creating your account.";
    showToast("Account creation needs a server connection.");
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
})();
