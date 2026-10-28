# Chess backend

This Node.js backend provides real-time two-player chess, spectators, chat, clocks, draw/resign actions, rematches, and persistent completed-game records and player stats.

## Run and test

From this directory:

```sh
npm install
npm start
```

Open `http://localhost:3000` to load the frontend served by the backend. The server listens on port `3000` by default; set `PORT` to change it. Socket.IO and HTTP APIs accept any origin by default; set `CORS_ORIGIN` to a comma-separated list of allowed origins for deployment.

The backend connects to MongoDB at `mongodb://127.0.0.1:27017` by default and uses the `house_chess` database. Set `MONGODB_URI` and `MONGODB_DATABASE` to change those values. Completed games and stats are stored in the `games` and `playerStats` collections and persist across server restarts; live games and active sockets do not. `GET /health` returns `{ "status": "ok" }`.

The MongoDB setup follows the guide's `MongoClient` flow: install MongoDB as a Windows service, verify the service with `mongosh mongodb://127.0.0.1:27017`, and start the backend with `npm start`. The server prints a successful MongoDB connection message before listening on port 3000. Use `GET /ready` to verify the database is reachable.

Accounts are available through `POST /api/auth/signup`, `POST /api/auth/login`, and `GET /api/auth/me`. Passwords are hashed with PBKDF2 and socket connections can use the returned bearer token. In production, set a strong `AUTH_SECRET`, restrict `CORS_ORIGIN`, and enable MongoDB access control.

Active rooms are also stored in the `activeGames` collection. On restart, board positions and clocks are restored; players reconnect using the same authenticated account or player ID and rejoin their seat.

From the backend directory, run `npm run migrate:mongodb` to migrate the SQLite database at `data/chess.sqlite` to the configured MongoDB database. Set `DB_PATH`, `MONGODB_URI`, and `MONGODB_DATABASE` to override the source path or destination. The migration is duplicate-safe, preserves games, player stats, users, and active room snapshots (when those optional SQLite tables exist), and does not modify the SQLite file.

Run `npm test` for the backend integration tests. Node.js 20 or newer is required. The tests pass an explicit temporary SQLite path for isolation; production startup uses MongoDB.

## Socket.IO integration

Clients should send an acknowledgement callback with each request. Responses use `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`. Failed requests are also sent to the requesting socket as `gameError`.

- `createGame` with optional `{ "roomId": "ROOM1", "name": "Ari", "playerId": "player-ari-001", "timeControl": { "minutes": 5, "incrementSeconds": 3 } }` creates a room; the creator is white. All fields are optional. The default clock is 10+0.
- `joinGame` with `{ "roomId": "ROOM1", "name": "Sam", "playerId": "player-sam-001" }` joins a waiting room as black. A clock starts once both players have joined.
- `makeMove` with `{ "roomId": "ROOM1", "from": "e2", "to": "e4", "promotion": "q" }` submits a server-validated move. `promotion` is optional and accepts `q`, `r`, `b`, or `n`.
- Clock controls use whole `minutes` from 1-180 and `incrementSeconds` from 0-60. The server is authoritative; `gameState.clock` includes each player's remaining milliseconds, whether the clock is running, and the active `deadlineAt` timestamp.
- `gameState` is broadcast after joining, each move, game completion, and rematch. It includes FEN, PGN, turn, moves, result/termination, player names, spectator count, draw/rematch offers, time control, and clock values.
- `resign` with `{ "roomId": "ROOM1" }` resigns for the requesting player.
- `offerDraw` with `{ "roomId": "ROOM1" }` sends a draw offer. The opponent accepts or declines with `respondDraw` and `{ "roomId": "ROOM1", "accept": true }`.
- `requestRematch` with `{ "roomId": "ROOM1" }` requests a rematch after the game is over. When both connected players request one, a new game starts in the same room with colors swapped and a fresh clock.
- `watchGame` with `{ "roomId": "ROOM1", "name": "Observer" }` joins as a spectator. Spectators receive game state and can chat, but cannot move, resign, offer draws, or request rematches.
- `sendChat` with `{ "roomId": "ROOM1", "message": "Good game!" }` sends a room message. Messages are limited to 500 characters and rate-limited per socket.
- `leaveGame` with `{ "roomId": "ROOM1" }` leaves the room. `playerDisconnected`, `spectatorCount`, `chatMessage`, `drawOffered`, `drawAccepted`, `drawOfferDeclined`, `rematchOffered`, and `rematchStarted` provide corresponding notifications.

Room IDs are 4-24 letters, numbers, underscores, or hyphens. Names are 1-24 characters. Optional player IDs are 8-64 letters, numbers, underscores, or hyphens; clients should retain and reuse an ID to see cumulative stats. These IDs are not authenticated, so clients can impersonate another ID. Do not treat these casual stats as trusted rankings. Chat is sent as plain text; the frontend must render it as text rather than HTML.

## Persistent HTTP APIs

- `GET /api/games/:gameId` retrieves a completed game's result, PGN, final FEN, clock control, names, and timestamps.
- `GET /api/games?playerId=player-ari-001&limit=20` lists up to 100 completed games for a player (default 20).
- `GET /api/players/:playerId/stats` returns wins, losses, draws, and games played. IDs with no completed games receive zero counts.
