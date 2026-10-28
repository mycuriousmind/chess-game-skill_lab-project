const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { io: connect } = require('socket.io-client');
const { createChessServer } = require('../server');

const services = [];
const clients = [];
const temporaryDirectories = [];

after(async () => {
  for (const client of clients) client.disconnect();
  for (const service of services) await service.close();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-backend-test-'));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, 'chess.sqlite');
  const service = createChessServer({ databasePath });
  services.push(service);
  await new Promise((resolve) => service.httpServer.listen(0, resolve));
  return {
    service,
    databasePath,
    url: `http://127.0.0.1:${service.httpServer.address().port}`,
  };
}

async function connectClient(url) {
  const socket = connect(url);
  clients.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 3000);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForEvent(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 3000);
    function onEvent(value) {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(value);
    }
    socket.on(event, onEvent);
  });
}

test('clocks, spectators, chat, draw offers, saved games, and stats work together', async () => {
  const { url, service, databasePath } = await createService();
  const white = await connectClient(url);
  const black = await connectClient(url);
  const spectator = await connectClient(url);

  const created = await emitAck(white, 'createGame', {
    roomId: 'FEATURES1',
    name: 'Ari',
    playerId: 'player-ari-001',
    timeControl: { minutes: 5, incrementSeconds: 3 },
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.state.timeControl, { minutes: 5, incrementSeconds: 3 });
  assert.equal(created.state.clock.running, false);

  const joined = await emitAck(black, 'joinGame', {
    roomId: created.roomId,
    name: 'Sam',
    playerId: 'player-sam-001',
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.state.clock.running, true);
  assert.equal(joined.state.playerNames.white, 'Ari');
  assert.equal(joined.state.playerNames.black, 'Sam');

  const watched = await emitAck(spectator, 'watchGame', { roomId: created.roomId, name: 'Observer' });
  assert.equal(watched.ok, true);
  assert.equal(watched.role, 'spectator');
  assert.equal(watched.state.spectators, 1);
  assert.equal((await emitAck(spectator, 'makeMove', {
    roomId: created.roomId,
    from: 'e2',
    to: 'e4',
  })).ok, false);
  const illegalMove = await emitAck(white, 'makeMove', {
    roomId: created.roomId,
    from: 'e2',
    to: 'e5',
  });
  assert.equal(illegalMove.ok, false);
  const whiteMove = await emitAck(white, 'makeMove', {
    roomId: created.roomId,
    from: 'e2',
    to: 'e4',
  });
  assert.equal(whiteMove.ok, true);
  const blackMove = await emitAck(black, 'makeMove', {
    roomId: created.roomId,
    from: 'e7',
    to: 'e5',
  });
  assert.equal(blackMove.ok, true);
  assert.deepEqual(blackMove.state.moves, ['e4', 'e5']);

  const chatReceived = waitForEvent(spectator, 'chatMessage', (message) => message.message === 'Good game!');
  const chat = await emitAck(white, 'sendChat', { roomId: created.roomId, message: ' Good game! ' });
  assert.equal(chat.ok, true);
  assert.equal((await chatReceived).sender, 'Ari');
  assert.equal((await emitAck(white, 'sendChat', {
    roomId: created.roomId,
    message: 'second message too quickly',
  })).ok, false);

  assert.equal((await emitAck(white, 'offerDraw', { roomId: created.roomId })).ok, true);
  const declined = await emitAck(black, 'respondDraw', { roomId: created.roomId, accept: false });
  assert.equal(declined.ok, true);
  assert.equal(declined.state.drawOffer, null);
  assert.equal((await emitAck(black, 'offerDraw', { roomId: created.roomId })).ok, true);
  const accepted = await emitAck(white, 'respondDraw', { roomId: created.roomId, accept: true });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.state.result, '1/2-1/2');
  assert.equal(accepted.state.termination, 'agreed_draw');

  const response = await fetch(`${url}/api/games/${accepted.state.gameId}`);
  assert.equal(response.status, 200);
  const { game } = await response.json();
  assert.equal(game.result, '1/2-1/2');
  assert.equal(game.whitePlayerId, 'player-ari-001');
  assert.deepEqual(game.timeControl, { minutes: 5, incrementSeconds: 3 });

  const statsResponse = await fetch(`${url}/api/players/player-ari-001/stats`);
  assert.deepEqual((await statsResponse.json()).stats, {
    playerId: 'player-ari-001',
    name: 'Ari',
    wins: 0,
    losses: 0,
    draws: 1,
    gamesPlayed: 1,
  });
  const historyResponse = await fetch(`${url}/api/games?playerId=player-ari-001&limit=10`);
  assert.equal((await historyResponse.json()).games[0].gameId, accepted.state.gameId);

  await service.close();
  const restartedService = createChessServer({ databasePath });
  services.push(restartedService);
  await new Promise((resolve) => restartedService.httpServer.listen(0, resolve));
  const restartedUrl = `http://127.0.0.1:${restartedService.httpServer.address().port}`;
  const persistedGame = await fetch(`${restartedUrl}/api/games/${accepted.state.gameId}`);
  assert.equal(persistedGame.status, 200);
  const persistedStats = await fetch(`${restartedUrl}/api/players/player-ari-001/stats`);
  assert.equal((await persistedStats.json()).stats.gamesPlayed, 1);
});

test('rematches swap colors and each completed game is persisted', async () => {
  const { url } = await createService();
  const white = await connectClient(url);
  const black = await connectClient(url);

  const created = await emitAck(white, 'createGame', {
    roomId: 'REMATCH1',
    name: 'Ari',
    playerId: 'player-ari-002',
    timeControl: { minutes: 1, incrementSeconds: 0 },
  });
  await emitAck(black, 'joinGame', {
    roomId: created.roomId,
    name: 'Sam',
    playerId: 'player-sam-002',
  });

  const resigned = await emitAck(white, 'resign', { roomId: created.roomId });
  assert.equal(resigned.ok, true);
  assert.equal(resigned.state.result, '0-1');
  assert.equal(resigned.state.termination, 'resignation');
  const firstGameId = resigned.state.gameId;

  const firstRequest = await emitAck(white, 'requestRematch', { roomId: created.roomId });
  assert.equal(firstRequest.ok, true);
  assert.equal(firstRequest.started, false);
  const rematch = await emitAck(black, 'requestRematch', { roomId: created.roomId });
  assert.equal(rematch.ok, true);
  assert.equal(rematch.started, true);
  assert.equal(rematch.color, 'w');
  assert.notEqual(rematch.state.gameId, firstGameId);
  assert.equal(rematch.state.playerNames.white, 'Sam');
  assert.equal(rematch.state.playerNames.black, 'Ari');
  assert.equal(rematch.state.turn, 'w');

  const secondResignation = await emitAck(black, 'resign', { roomId: created.roomId });
  assert.equal(secondResignation.ok, true);
  assert.equal(secondResignation.state.result, '0-1');

  const statsResponse = await fetch(`${url}/api/players/player-ari-002/stats`);
  const { stats } = await statsResponse.json();
  assert.equal(stats.gamesPlayed, 2);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1);
  assert.equal(stats.draws, 0);

  const historyResponse = await fetch(`${url}/api/games?playerId=player-ari-002&limit=10`);
  assert.equal((await historyResponse.json()).games.length, 2);
});

test('active games restore their position after a server restart', async () => {
  const { service, databasePath } = await createService();
  const white = await connectClient(`http://127.0.0.1:${service.httpServer.address().port}`);
  const black = await connectClient(`http://127.0.0.1:${service.httpServer.address().port}`);

  const created = await emitAck(white, 'createGame', {
    roomId: 'RESTORE1',
    name: 'Ari',
    playerId: 'player-ari-004',
  });
  await emitAck(black, 'joinGame', {
    roomId: created.roomId,
    name: 'Sam',
    playerId: 'player-sam-004',
  });
  await emitAck(white, 'makeMove', { roomId: created.roomId, from: 'e2', to: 'e4' });
  await emitAck(black, 'makeMove', { roomId: created.roomId, from: 'e7', to: 'e5' });

  await service.close();
  const restartedService = createChessServer({ databasePath });
  services.push(restartedService);
  await restartedService.ready;
  await new Promise((resolve) => restartedService.httpServer.listen(0, resolve));

  const restoredGame = restartedService.games.get(created.roomId);
  assert.ok(restoredGame);
  assert.equal(restoredGame.gameId, created.state.gameId);
  assert.deepEqual(restoredGame.chess.history(), ['e4', 'e5']);
});

test('a clock expiring ends the game and invalid clock controls are rejected', async () => {
  const { url, service } = await createService();
  const white = await connectClient(url);
  const black = await connectClient(url);

  const invalid = await emitAck(white, 'createGame', {
    roomId: 'BADTIME1',
    timeControl: { minutes: 0, incrementSeconds: 0 },
  });
  assert.equal(invalid.ok, false);

  const created = await emitAck(white, 'createGame', {
    roomId: 'TIMEOUT1',
    name: 'Ari',
    playerId: 'player-ari-003',
    timeControl: { minutes: 1, incrementSeconds: 0 },
  });
  await emitAck(black, 'joinGame', {
    roomId: created.roomId,
    name: 'Sam',
    playerId: 'player-sam-003',
  });
  const internalGame = service.games.get(created.roomId);
  clearTimeout(internalGame.clock.timer);
  internalGame.clock.deadlineAt = Date.now() - 1;

  const timedOut = await emitAck(white, 'makeMove', {
    roomId: created.roomId,
    from: 'e2',
    to: 'e4',
  });
  assert.equal(timedOut.ok, false);
  const stateResponse = await fetch(`${url}/api/games/${internalGame.gameId}`);
  assert.equal(stateResponse.status, 200);
  const { game } = await stateResponse.json();
  assert.equal(game.result, '0-1');
  assert.equal(game.termination, 'timeout');
});

test('the backend serves the frontend and its Socket.IO browser client', async () => {
  const { url } = await createService();
  const pageResponse = await fetch(url);
  assert.equal(pageResponse.status, 200);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /House — Chess, played your way/);
  assert.match(pageHtml, /src="\/socket\.io\/socket\.io\.js"/);

  const frontendResponse = await fetch(`${url}/app.js`);
  assert.equal(frontendResponse.status, 200);
  assert.match(await frontendResponse.text(), /createOnlineGame/);

  const socketClientResponse = await fetch(`${url}/socket.io/socket.io.js`);
  assert.equal(socketClientResponse.status, 200);
  assert.match(await socketClientResponse.text(), /Socket\.IO/);
});

test('readiness and account authentication APIs work', async () => {
  const { url } = await createService();
  const readyResponse = await fetch(`${url}/ready`);
  assert.equal(readyResponse.status, 200);
  assert.deepEqual(await readyResponse.json(), { status: 'ready', database: 'ok' });

  const email = 'account@example.test';
  const signupResponse = await fetch(`${url}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: 'Account Player', password: 'password-123' }),
  });
  assert.equal(signupResponse.status, 201);
  const signup = await signupResponse.json();
  assert.equal(signup.user.name, 'Account Player');
  assert.equal(typeof signup.token, 'string');

  const meResponse = await fetch(`${url}/api/auth/me`, {
    headers: { authorization: `Bearer ${signup.token}` },
  });
  assert.equal(meResponse.status, 200);
  assert.equal((await meResponse.json()).user.email, email);

  const loginResponse = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password-123' }),
  });
  assert.equal(loginResponse.status, 200);
  assert.equal((await loginResponse.json()).user.userId, signup.user.userId);

  const invalidLogin = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrong-password' }),
  });
  assert.equal(invalidLogin.status, 401);
});
