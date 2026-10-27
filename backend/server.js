const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const cors = require('cors');
const express = require('express');
const { Chess } = require('chess.js');
const { Server } = require('socket.io');
const { createStore } = require('./store');

const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{4,24}$/;
const PLAYER_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
const DEFAULT_TIME_CONTROL = { minutes: 10, incrementSeconds: 0 };
const MAX_CHAT_LENGTH = 500;
const CHAT_COOLDOWN_MS = 750;

function isPayload(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload);
}

function normalizeRoomId(roomId) {
  return typeof roomId === 'string' ? roomId.trim().toUpperCase() : '';
}

function parseIdentity(payload, color) {
  let playerId = null;
  let name = color === 'w' ? 'White' : 'Black';

  if (payload.playerId !== undefined && payload.playerId !== null && payload.playerId !== '') {
    if (typeof payload.playerId !== 'string' || !PLAYER_ID_PATTERN.test(payload.playerId)) {
      return { error: 'Player ID must be 8-64 letters, numbers, underscores, or hyphens.' };
    }
    playerId = payload.playerId;
  }

  if (payload.name !== undefined) {
    if (
      typeof payload.name !== 'string'
      || payload.name.trim().length < 1
      || payload.name.trim().length > 24
      || /[\u0000-\u001f\u007f]/.test(payload.name)
    ) {
      return { error: 'Name must be 1-24 characters and contain no control characters.' };
    }
    name = payload.name.trim();
  }

  return { playerId, name };
}

function parseTimeControl(value) {
  if (value === undefined) return { ...DEFAULT_TIME_CONTROL };
  if (
    !isPayload(value)
    || !Number.isInteger(value.minutes)
    || value.minutes < 1
    || value.minutes > 180
    || !Number.isInteger(value.incrementSeconds)
    || value.incrementSeconds < 0
    || value.incrementSeconds > 60
  ) {
    return {
      error: 'Time control requires whole minutes (1-180) and incrementSeconds (0-60).',
    };
  }
  return { minutes: value.minutes, incrementSeconds: value.incrementSeconds };
}

function makeRoomId(games) {
  let roomId;
  do {
    roomId = crypto.randomBytes(4).toString('hex').toUpperCase();
  } while (games.has(roomId));
  return roomId;
}

function createChessServer(options = {}) {
  const app = express();
  const httpServer = http.createServer(app);
  const allowedOrigins = (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const corsOrigin = allowedOrigins.includes('*') ? '*' : allowedOrigins;
  const store = createStore(
    options.databasePath || process.env.DB_PATH || path.join(__dirname, 'data', 'chess.sqlite'),
  );
  const games = new Map();
  const playerGames = new Map();
  const spectators = new Map();
  const lastChatAt = new Map();
  let closed = false;

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '16kb' }));

  const io = new Server(httpServer, {
    cors: { origin: corsOrigin },
  });

  function gameState(game) {
    const chess = game.chess;
    const finished = Boolean(game.result);
    const playersConnected = Boolean(game.players.w && game.players.b);
    const now = Date.now();
    const remaining = { ...game.clock.remainingMs };
    if (!finished && game.clock.deadlineAt !== null) {
      const currentColor = chess.turn();
      remaining[currentColor] = Math.max(0, game.clock.deadlineAt - now);
    }

    return {
      roomId: game.roomId,
      gameId: game.gameId,
      fen: chess.fen(),
      pgn: chess.pgn(),
      turn: chess.turn(),
      moves: chess.history(),
      status: finished ? 'finished' : playersConnected ? 'active' : 'waiting',
      result: game.result,
      termination: game.termination,
      check: chess.isCheck(),
      checkmate: chess.isCheckmate(),
      draw: chess.isDraw(),
      players: {
        white: Boolean(game.players.w),
        black: Boolean(game.players.b),
      },
      playerNames: {
        white: game.playerNames.w,
        black: game.playerNames.b,
      },
      spectators: game.spectatorCount,
      drawOffer: game.drawOffer,
      rematch: {
        whiteRequested: game.rematchOffers.has('w'),
        blackRequested: game.rematchOffers.has('b'),
      },
      timeControl: { ...game.timeControl },
      clock: {
        whiteMs: Math.ceil(remaining.w),
        blackMs: Math.ceil(remaining.b),
        running: game.clock.deadlineAt !== null && !finished,
        deadlineAt: finished ? null : game.clock.deadlineAt,
      },
    };
  }

  function emitGameState(game) {
    io.to(game.roomId).emit('gameState', gameState(game));
  }

  function respond(socket, acknowledgement, event, result) {
    if (typeof acknowledgement === 'function') {
      acknowledgement(result);
    }
    if (!result.ok) {
      socket.emit('gameError', { event, error: result.error });
    }
  }

  function getRoomId(socket, roomId, acknowledgement, event) {
    const normalizedRoomId = normalizeRoomId(roomId);
    if (!ROOM_ID_PATTERN.test(normalizedRoomId)) {
      respond(socket, acknowledgement, event, {
        ok: false,
        error: 'Room ID must be 4-24 letters, numbers, underscores, or hyphens.',
      });
      return null;
    }
    return normalizedRoomId;
  }

  function playerMembership(socket, roomId, acknowledgement, event) {
    const membership = playerGames.get(socket.id);
    const game = games.get(roomId);
    if (!membership || membership.roomId !== roomId || !game) {
      respond(socket, acknowledgement, event, {
        ok: false,
        error: 'You are not a player in that game.',
      });
      return null;
    }
    return { membership, game };
  }

  function persistFinishedGame(game) {
    try {
      store.saveGame({
        gameId: game.gameId,
        roomId: game.roomId,
        whitePlayerId: game.players.w?.playerId || null,
        blackPlayerId: game.players.b?.playerId || null,
        whiteName: game.playerNames.w,
        blackName: game.playerNames.b,
        result: game.result,
        termination: game.termination,
        pgn: game.chess.pgn(),
        finalFen: game.chess.fen(),
        timeControl: game.timeControl,
        createdAt: game.createdAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`Could not persist result for game ${game.gameId}:`, error);
      io.to(game.roomId).emit('persistenceError', {
        message: 'The game ended, but its result could not be saved.',
      });
    }
  }

  function stopClock(game) {
    if (game.clock.timer) clearTimeout(game.clock.timer);
    if (game.clock.deadlineAt !== null && !game.result) {
      const currentColor = game.chess.turn();
      game.clock.remainingMs[currentColor] = Math.max(0, game.clock.deadlineAt - Date.now());
    }
    game.clock.timer = null;
    game.clock.deadlineAt = null;
  }

  function finishGame(game, result, termination) {
    if (game.result) return false;
    stopClock(game);
    game.result = result;
    game.termination = termination;
    game.drawOffer = null;
    game.rematchOffers.clear();
    persistFinishedGame(game);
    return true;
  }

  function finishFromChessPosition(game) {
    if (!game.chess.isGameOver()) return false;
    if (game.chess.isCheckmate()) {
      finishGame(game, game.chess.turn() === 'w' ? '0-1' : '1-0', 'checkmate');
    } else {
      finishGame(game, '1/2-1/2', 'draw');
    }
    return true;
  }

  function handleTimeout(game) {
    if (game.result || game.clock.deadlineAt === null) return;
    const remaining = game.clock.deadlineAt - Date.now();
    if (remaining > 0) {
      game.clock.timer = setTimeout(() => handleTimeout(game), remaining);
      return;
    }
    const loser = game.chess.turn();
    const winner = loser === 'w' ? 'b' : 'w';
    const result = game.chess.isInsufficientMaterial()
      ? '1/2-1/2'
      : winner === 'w' ? '1-0' : '0-1';
    finishGame(game, result, 'timeout');
    emitGameState(game);
  }

  function startClock(game) {
    if (game.result || !game.players.w || !game.players.b || game.clock.deadlineAt !== null) return;
    game.clock.deadlineAt = Date.now() + game.clock.remainingMs[game.chess.turn()];
    game.clock.timer = setTimeout(
      () => handleTimeout(game),
      game.clock.remainingMs[game.chess.turn()],
    );
  }

  function clockExpired(game) {
    if (game.result || game.clock.deadlineAt === null || game.clock.deadlineAt > Date.now()) {
      return false;
    }
    handleTimeout(game);
    return true;
  }

  function newGame(roomId, whitePlayer, blackPlayer, timeControl) {
    return {
      roomId,
      gameId: crypto.randomUUID(),
      chess: new Chess(),
      players: { w: whitePlayer, b: blackPlayer },
      playerNames: {
        w: whitePlayer.name,
        b: blackPlayer ? blackPlayer.name : 'Black',
      },
      spectatorCount: 0,
      drawOffer: null,
      rematchOffers: new Set(),
      timeControl,
      clock: {
        remainingMs: {
          w: timeControl.minutes * 60_000,
          b: timeControl.minutes * 60_000,
        },
        deadlineAt: null,
        timer: null,
      },
      createdAt: new Date().toISOString(),
      result: null,
      termination: null,
    };
  }

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/games', (request, response) => {
    const { playerId } = request.query;
    const requestedLimit = Number(request.query.limit || 20);
    if (typeof playerId !== 'string' || !PLAYER_ID_PATTERN.test(playerId)) {
      response.status(400).json({ error: 'A valid playerId query parameter is required.' });
      return;
    }
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      response.status(400).json({ error: 'limit must be a whole number between 1 and 100.' });
      return;
    }
    response.json({ games: store.getPlayerGames(playerId, requestedLimit) });
  });

  app.get('/api/games/:gameId', (request, response) => {
    const game = store.getGame(request.params.gameId);
    if (!game) {
      response.status(404).json({ error: 'Completed game not found.' });
      return;
    }
    response.json({ game });
  });

  app.get('/api/players/:playerId/stats', (request, response) => {
    if (!PLAYER_ID_PATTERN.test(request.params.playerId)) {
      response.status(400).json({ error: 'Player ID must be 8-64 letters, numbers, underscores, or hyphens.' });
      return;
    }
    response.json({ stats: store.getPlayerStats(request.params.playerId) });
  });

  io.on('connection', (socket) => {
    socket.on('createGame', async (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'createGame', { ok: false, error: 'Request must be an object.' });
        return;
      }
      if (playerGames.has(socket.id) || spectators.has(socket.id)) {
        respond(socket, acknowledgement, 'createGame', {
          ok: false,
          error: 'Leave your current game before creating another.',
        });
        return;
      }

      const requestedRoomId = payload.roomId;
      const roomId = requestedRoomId
        ? getRoomId(socket, requestedRoomId, acknowledgement, 'createGame')
        : makeRoomId(games);
      if (!roomId) return;
      if (games.has(roomId)) {
        respond(socket, acknowledgement, 'createGame', { ok: false, error: 'That room already exists.' });
        return;
      }

      const timeControl = parseTimeControl(payload.timeControl);
      if (timeControl.error) {
        respond(socket, acknowledgement, 'createGame', { ok: false, error: timeControl.error });
        return;
      }
      const identity = parseIdentity(payload, 'w');
      if (identity.error) {
        respond(socket, acknowledgement, 'createGame', { ok: false, error: identity.error });
        return;
      }

      const game = newGame(roomId, { ...identity, socketId: socket.id }, null, timeControl);
      games.set(roomId, game);
      playerGames.set(socket.id, { roomId, color: 'w' });
      await socket.join(roomId);

      const state = gameState(game);
      respond(socket, acknowledgement, 'createGame', { ok: true, roomId, color: 'w', state });
      socket.emit('gameState', state);
    });

    socket.on('joinGame', async (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'joinGame', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = getRoomId(socket, payload.roomId, acknowledgement, 'joinGame');
      if (!roomId) return;
      if (playerGames.has(socket.id) || spectators.has(socket.id)) {
        respond(socket, acknowledgement, 'joinGame', {
          ok: false,
          error: 'Leave your current game before joining another.',
        });
        return;
      }

      const game = games.get(roomId);
      if (!game) {
        respond(socket, acknowledgement, 'joinGame', { ok: false, error: 'Game not found.' });
        return;
      }
      if (game.result || game.players.b) {
        respond(socket, acknowledgement, 'joinGame', {
          ok: false,
          error: 'That game is full or has already ended.',
        });
        return;
      }

      const identity = parseIdentity(payload, 'b');
      if (identity.error) {
        respond(socket, acknowledgement, 'joinGame', { ok: false, error: identity.error });
        return;
      }
      if (identity.playerId && identity.playerId === game.players.w.playerId) {
        respond(socket, acknowledgement, 'joinGame', {
          ok: false,
          error: 'The same player ID cannot occupy both seats.',
        });
        return;
      }

      game.players.b = { ...identity, socketId: socket.id };
      game.playerNames.b = identity.name;
      playerGames.set(socket.id, { roomId, color: 'b' });
      await socket.join(roomId);
      startClock(game);

      const state = gameState(game);
      respond(socket, acknowledgement, 'joinGame', { ok: true, roomId, color: 'b', state });
      emitGameState(game);
    });

    socket.on('watchGame', async (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'watchGame', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = getRoomId(socket, payload.roomId, acknowledgement, 'watchGame');
      if (!roomId) return;
      if (playerGames.has(socket.id) || spectators.has(socket.id)) {
        respond(socket, acknowledgement, 'watchGame', {
          ok: false,
          error: 'Leave your current game before watching another.',
        });
        return;
      }
      const game = games.get(roomId);
      if (!game) {
        respond(socket, acknowledgement, 'watchGame', { ok: false, error: 'Game not found.' });
        return;
      }

      let name = 'Spectator';
      if (payload.name !== undefined) {
        const identity = parseIdentity({ name: payload.name }, 'w');
        if (identity.error) {
          respond(socket, acknowledgement, 'watchGame', { ok: false, error: identity.error });
          return;
        }
        name = identity.name;
      }

      spectators.set(socket.id, { roomId, name });
      game.spectatorCount += 1;
      await socket.join(roomId);
      const state = gameState(game);
      respond(socket, acknowledgement, 'watchGame', { ok: true, roomId, role: 'spectator', state });
      socket.emit('gameState', state);
      io.to(roomId).emit('spectatorCount', { count: game.spectatorCount });
    });

    socket.on('makeMove', (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'makeMove', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = normalizeRoomId(payload.roomId);
      const player = playerMembership(socket, roomId, acknowledgement, 'makeMove');
      if (!player) return;
      const { membership, game } = player;
      if (clockExpired(game)) {
        emitGameState(game);
        respond(socket, acknowledgement, 'makeMove', { ok: false, error: 'Your clock has run out.' });
        return;
      }
      if (!game.players.b) {
        respond(socket, acknowledgement, 'makeMove', { ok: false, error: 'Wait for another player to join.' });
        return;
      }
      if (game.result) {
        respond(socket, acknowledgement, 'makeMove', { ok: false, error: 'This game has already ended.' });
        return;
      }
      if (game.chess.turn() !== membership.color) {
        respond(socket, acknowledgement, 'makeMove', { ok: false, error: 'It is not your turn.' });
        return;
      }
      if (
        typeof payload.from !== 'string'
        || !/^[a-h][1-8]$/.test(payload.from)
        || typeof payload.to !== 'string'
        || !/^[a-h][1-8]$/.test(payload.to)
        || (payload.promotion !== undefined && !['q', 'r', 'b', 'n'].includes(payload.promotion))
      ) {
        respond(socket, acknowledgement, 'makeMove', {
          ok: false,
          error: 'Move must include valid from and to squares and an optional q, r, b, or n promotion.',
        });
        return;
      }

      let move;
      try {
        move = game.chess.move({
          from: payload.from,
          to: payload.to,
          ...(payload.promotion ? { promotion: payload.promotion } : {}),
        });
      } catch (_error) {
        move = null;
      }
      if (!move) {
        respond(socket, acknowledgement, 'makeMove', { ok: false, error: 'That is not a legal move.' });
        return;
      }

      if (game.clock.deadlineAt !== null) {
        if (game.clock.timer) clearTimeout(game.clock.timer);
        game.clock.timer = null;
        game.clock.remainingMs[membership.color] = Math.max(
          0,
          game.clock.deadlineAt - Date.now(),
        ) + game.timeControl.incrementSeconds * 1000;
        game.clock.deadlineAt = null;
      }
      if (!finishFromChessPosition(game)) startClock(game);

      const state = gameState(game);
      respond(socket, acknowledgement, 'makeMove', { ok: true, move, state });
      emitGameState(game);
    });

    socket.on('resign', (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'resign', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = normalizeRoomId(payload.roomId);
      const player = playerMembership(socket, roomId, acknowledgement, 'resign');
      if (!player) return;
      const { membership, game } = player;
      if (clockExpired(game)) {
        emitGameState(game);
        respond(socket, acknowledgement, 'resign', { ok: false, error: 'The game already ended on time.' });
        return;
      }
      if (game.result) {
        respond(socket, acknowledgement, 'resign', { ok: false, error: 'This game has already ended.' });
        return;
      }
      const result = membership.color === 'w' ? '0-1' : '1-0';
      finishGame(game, result, 'resignation');
      const state = gameState(game);
      respond(socket, acknowledgement, 'resign', { ok: true, state });
      emitGameState(game);
    });

    socket.on('offerDraw', (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'offerDraw', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = normalizeRoomId(payload.roomId);
      const player = playerMembership(socket, roomId, acknowledgement, 'offerDraw');
      if (!player) return;
      const { membership, game } = player;
      if (clockExpired(game)) {
        emitGameState(game);
        respond(socket, acknowledgement, 'offerDraw', { ok: false, error: 'The game already ended on time.' });
        return;
      }
      if (game.result || !game.players.b) {
        respond(socket, acknowledgement, 'offerDraw', {
          ok: false,
          error: 'A draw can only be offered during an active game.',
        });
        return;
      }
      if (game.drawOffer) {
        respond(socket, acknowledgement, 'offerDraw', { ok: false, error: 'A draw offer is already pending.' });
        return;
      }
      game.drawOffer = membership.color;
      respond(socket, acknowledgement, 'offerDraw', { ok: true, state: gameState(game) });
      io.to(roomId).emit('drawOffered', {
        color: membership.color,
        name: game.players[membership.color].name,
      });
      emitGameState(game);
    });

    socket.on('respondDraw', (payload = {}, acknowledgement) => {
      if (!isPayload(payload) || typeof payload.accept !== 'boolean') {
        respond(socket, acknowledgement, 'respondDraw', {
          ok: false,
          error: 'Request must include roomId and a boolean accept value.',
        });
        return;
      }
      const roomId = normalizeRoomId(payload.roomId);
      const player = playerMembership(socket, roomId, acknowledgement, 'respondDraw');
      if (!player) return;
      const { membership, game } = player;
      if (clockExpired(game)) {
        emitGameState(game);
        respond(socket, acknowledgement, 'respondDraw', { ok: false, error: 'The game already ended on time.' });
        return;
      }
      if (game.result || !game.drawOffer || game.drawOffer === membership.color) {
        respond(socket, acknowledgement, 'respondDraw', { ok: false, error: 'There is no draw offer to respond to.' });
        return;
      }

      if (payload.accept) {
        finishGame(game, '1/2-1/2', 'agreed_draw');
      } else {
        game.drawOffer = null;
      }
      const state = gameState(game);
      respond(socket, acknowledgement, 'respondDraw', { ok: true, accepted: payload.accept, state });
      io.to(roomId).emit(payload.accept ? 'drawAccepted' : 'drawOfferDeclined', { state });
      emitGameState(game);
    });

    socket.on('requestRematch', (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'requestRematch', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = normalizeRoomId(payload.roomId);
      const player = playerMembership(socket, roomId, acknowledgement, 'requestRematch');
      if (!player) return;
      const { membership, game } = player;
      if (!game.result || !game.players.w || !game.players.b) {
        respond(socket, acknowledgement, 'requestRematch', {
          ok: false,
          error: 'A rematch can only be requested after a finished game when both players are connected.',
        });
        return;
      }

      game.rematchOffers.add(membership.color);
      if (game.rematchOffers.size < 2) {
        const state = gameState(game);
        respond(socket, acknowledgement, 'requestRematch', { ok: true, started: false, state });
        io.to(roomId).emit('rematchOffered', {
          color: membership.color,
          name: game.players[membership.color].name,
          state,
        });
        return;
      }

      const oldWhite = game.players.w;
      const oldBlack = game.players.b;
      game.players = { w: oldBlack, b: oldWhite };
      game.playerNames = { w: oldBlack.name, b: oldWhite.name };
      playerGames.set(oldBlack.socketId, { roomId, color: 'w' });
      playerGames.set(oldWhite.socketId, { roomId, color: 'b' });
      game.gameId = crypto.randomUUID();
      game.chess = new Chess();
      game.createdAt = new Date().toISOString();
      game.result = null;
      game.termination = null;
      game.drawOffer = null;
      game.rematchOffers.clear();
      game.clock.remainingMs = {
        w: game.timeControl.minutes * 60_000,
        b: game.timeControl.minutes * 60_000,
      };
      game.clock.deadlineAt = null;
      game.clock.timer = null;
      startClock(game);

      const state = gameState(game);
      respond(socket, acknowledgement, 'requestRematch', {
        ok: true,
        started: true,
        color: playerGames.get(socket.id).color,
        state,
      });
      io.to(roomId).emit('rematchStarted', {
        gameId: game.gameId,
        state,
        colors: { white: oldBlack.name, black: oldWhite.name },
      });
      emitGameState(game);
    });

    socket.on('sendChat', (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'sendChat', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = normalizeRoomId(payload.roomId);
      const game = games.get(roomId);
      const player = playerGames.get(socket.id);
      const spectator = spectators.get(socket.id);
      if (!game || (!player && !spectator) || (player && player.roomId !== roomId) || (spectator && spectator.roomId !== roomId)) {
        respond(socket, acknowledgement, 'sendChat', { ok: false, error: 'You are not in that game.' });
        return;
      }
      if (typeof payload.message !== 'string' || !payload.message.trim() || payload.message.trim().length > MAX_CHAT_LENGTH) {
        respond(socket, acknowledgement, 'sendChat', {
          ok: false,
          error: `Message must be 1-${MAX_CHAT_LENGTH} characters.`,
        });
        return;
      }
      const now = Date.now();
      if (now - (lastChatAt.get(socket.id) || 0) < CHAT_COOLDOWN_MS) {
        respond(socket, acknowledgement, 'sendChat', { ok: false, error: 'Please wait before sending another message.' });
        return;
      }

      lastChatAt.set(socket.id, now);
      const color = player ? player.color : null;
      const message = {
        roomId,
        sender: player ? game.players[color].name : spectator.name,
        color,
        message: payload.message.trim(),
        sentAt: new Date(now).toISOString(),
      };
      respond(socket, acknowledgement, 'sendChat', { ok: true, message });
      io.to(roomId).emit('chatMessage', message);
    });

    socket.on('leaveGame', async (payload = {}, acknowledgement) => {
      if (!isPayload(payload)) {
        respond(socket, acknowledgement, 'leaveGame', { ok: false, error: 'Request must be an object.' });
        return;
      }
      const roomId = normalizeRoomId(payload.roomId);
      const player = playerGames.get(socket.id);
      const spectator = spectators.get(socket.id);
      if ((!player || player.roomId !== roomId) && (!spectator || spectator.roomId !== roomId)) {
        respond(socket, acknowledgement, 'leaveGame', { ok: false, error: 'You are not in that game.' });
        return;
      }

      await socket.leave(roomId);
      if (player && player.roomId === roomId) {
        playerGames.delete(socket.id);
        const game = games.get(roomId);
        if (game && game.players[player.color]?.socketId === socket.id) {
          game.players[player.color] = null;
          game.drawOffer = null;
          game.rematchOffers.clear();
          io.to(roomId).emit('playerDisconnected', { color: player.color, state: gameState(game) });
        }
      } else {
        spectators.delete(socket.id);
        const game = games.get(roomId);
        if (game) {
          game.spectatorCount = Math.max(0, game.spectatorCount - 1);
          io.to(roomId).emit('spectatorCount', { count: game.spectatorCount });
        }
      }
      lastChatAt.delete(socket.id);
      respond(socket, acknowledgement, 'leaveGame', { ok: true });
    });

    socket.on('disconnect', () => {
      lastChatAt.delete(socket.id);
      const player = playerGames.get(socket.id);
      if (player) {
        playerGames.delete(socket.id);
        const game = games.get(player.roomId);
        if (game && game.players[player.color]?.socketId === socket.id) {
          game.players[player.color] = null;
          game.drawOffer = null;
          game.rematchOffers.clear();
          io.to(player.roomId).emit('playerDisconnected', { color: player.color, state: gameState(game) });
        }
        return;
      }
      const spectator = spectators.get(socket.id);
      if (!spectator) return;
      spectators.delete(socket.id);
      const game = games.get(spectator.roomId);
      if (game) {
        game.spectatorCount = Math.max(0, game.spectatorCount - 1);
        io.to(spectator.roomId).emit('spectatorCount', { count: game.spectatorCount });
      }
    });
  });

  return {
    app,
    httpServer,
    io,
    games,
    store,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const game of games.values()) stopClock(game);
      await new Promise((resolve, reject) => {
        io.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      store.close();
    },
  };
}

if (require.main === module) {
  const service = createChessServer();
  const port = Number(process.env.PORT) || 3000;
  service.httpServer.listen(port, () => {
    console.log(`Chess backend listening on port ${port}`);
  });
}

module.exports = { createChessServer };
