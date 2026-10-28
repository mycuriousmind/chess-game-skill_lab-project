# House Chess

House Chess is a browser-based chess app with a local two-player mode and a separate Node.js backend for multiplayer features, persistent game history, and player stats. The frontend and backend are intentionally separate projects inside the same repository.

## Features

### Browser frontend

- Play a local game on one device against another player.
- Choose Bullet (1+0), Blitz (5+0), or Rapid (10+0) time controls.
- See legal-move hints, the last move, check status, clocks, and move history.
- Flip the board and export the current position as FEN or the move list as PGN.
- Browse the Learn, Games, Insights, and Profile demo screens.

The Learn, Games, and Insights screens are demo UI placeholders. Online room creation, matchmaking, account signup/login, live moves, chat, draw offers, resignations, rematches, and spectator support are implemented in the backend.

### Node.js backend

- Create and join multiplayer rooms.
- Validate moves on the server.
- Maintain real-time clocks and room state via Socket.IO.
- Persist completed games and player statistics in MongoDB.
- Expose HTTP APIs for game history and player stats.

See the [backend guide](backend/README.md) for the Socket.IO event payloads, HTTP endpoints, server settings, and persistence details.

## Project layout

```text
chess-game-skill_lab-project/
├── frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── backend/
│   ├── server.js
│   ├── store.js
│   ├── scripts/
│   │   └── migrate-sqlite-to-mongodb.js
│   ├── package.json
│   ├── README.md
│   └── test/
│       └── server.test.js
├── README.md
└── PRESENTATION_SECURITY_NOTES.md
```

## Requirements

- Node.js 20 or newer
- npm
- MongoDB running locally (default setup), or a MongoDB URI for another deployment
- A modern browser to open the frontend

## Quick start

### 1) Install MongoDB

Install and run MongoDB locally. For the default local setup, the backend expects:

- URI: `mongodb://127.0.0.1:27017`
- database: `house_chess`

You can verify the local MongoDB service with:

```sh
mongosh mongodb://127.0.0.1:27017
```

If you prefer MongoDB Compass, connect to:

```text
mongodb://127.0.0.1:27017
```

### 2) Install backend dependencies

From the repository root:

```sh
cd backend
npm install
```

### 3) Start the backend

```sh
npm start
```

By default, the server listens on:

```text
http://localhost:3000
```

Check the health endpoint:

```text
http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

### 4) Run the frontend

Open the frontend in a browser:

```text
frontend/index.html
```

The local board game works entirely in the browser without the backend. The backend is required for multiplayer features, accounts, game persistence, and online rooms.

## Environment variables

The backend accepts these environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and Socket.IO server port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB connection string |
| `MONGODB_DATABASE` | `house_chess` | MongoDB database name |
| `AUTH_SECRET` | development fallback | HMAC secret used for auth tokens |
| `NODE_ENV` | unset | Set to `production` for production checks |
| `CORS_ORIGIN` | `*` | Allowed origins, comma-separated |
| `DB_PATH` | unset | Local SQLite path used for migration/testing, not normal runtime |

Example local configuration:

```sh
set MONGODB_URI=mongodb://127.0.0.1:27017
set MONGODB_DATABASE=house_chess
set AUTH_SECRET=change-this-secret
set CORS_ORIGIN=http://localhost:3000
npm start
```

## Running tests and checks

From the backend folder:

```sh
npm test
npm run check
```

## MongoDB, Postman, and Compass

This project uses:

- MongoDB Compass to visually inspect the database and collections.
- Postman to call the Node.js HTTP endpoints.
- Node.js + Express + Socket.IO to run the server logic.

Important distinction:

- Postman does not "connect to Node.js" in the same sense that MongoDB Compass connects to MongoDB.
- Postman sends HTTP requests to the backend API.
- Compass connects directly to MongoDB.
- The Node.js backend connects to MongoDB using `MONGODB_URI`.

Example Postman requests:

- `POST http://localhost:3000/api/auth/signup`
- `POST http://localhost:3000/api/auth/login`
- `GET http://localhost:3000/api/games?playerId=player-1234&limit=20`

For Socket.IO multiplayer actions, use a Socket.IO client or the frontend app, not Postman.

## API summary

The backend exposes these HTTP endpoints:

- `POST /api/auth/signup` — create an account
- `POST /api/auth/login` — log in and receive a token
- `GET /api/auth/me` — get current account info from a bearer token
- `GET /api/games?playerId=...&limit=...` — list completed games for a player
- `GET /api/games/:gameId` — fetch a single completed game
- `GET /api/players/:playerId/stats` — fetch player stats

## Migration

If you have an existing SQLite database, you can migrate it to MongoDB:

```sh
set DB_PATH=backend\data\chess.sqlite
set MONGODB_URI=mongodb://127.0.0.1:27017
set MONGODB_DATABASE=house_chess
npm run migrate:mongodb
```

## Notes

- Player IDs are identifiers, not trusted account identities. Do not treat casual stats as a reliable ranking.
- Chat messages are plain text; clients should render them as text, not HTML.
- For production, use a strong `AUTH_SECRET` and a restricted `CORS_ORIGIN`.
- MongoDB access control is required in production; the default unauthenticated local setup is intended for development only.
- The frontend fetches chess.js and fonts from CDNs, so an internet connection is needed when loading the browser UI.

## What this repo is not

This repository is not a single monolithic app where the browser automatically drives the multiplayer backend. The backend is a separate service, and the browser app is a separate frontend experience.

If you want to work with the online multiplayer features, run the backend and connect to its HTTP routes and Socket.IO events. If you want the local board UI, open the static frontend directly in a browser.
