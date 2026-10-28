# House Chess

House Chess is a browser-based chess interface with a local two-player game and a separate Node.js backend for real-time multiplayer chess. The frontend and backend are currently separate: local play works in the browser, while online play requires a client integration with the backend's Socket.IO API.

## Features

### Browser frontend

- Play a local game by taking turns on the same device.
- Choose Bullet (1+0), Blitz (5+0), or Rapid (10+0) time controls.
- See legal-move hints, the last move, check status, clocks, and move history.
- Flip the board and export the current position as FEN or moves as PGN.
- Browse the Learn, Games, Insights, and Profile interface sections.

The Learn, Games, and Insights screens remain demo UI. Account signup/login, online room creation, invite links, joining, live moves, chat, draw offers, resignations, rematches, and spectators are backed by the Node.js and MongoDB services.

### Node.js backend

- Create and join multiplayer rooms, play validated chess moves, and watch games.
- Use server-managed clocks, chat, draw offers, resignations, and rematches.
- Persist completed games and player statistics in MongoDB.
- Query completed games and player statistics through HTTP APIs.

See the [backend guide](backend/README.md) for Socket.IO event payloads, HTTP endpoints, server settings, and persistence details.

## Project layout

```text
chess-game-skill_lab-project/
├── frontend/
│   ├── index.html       # Page structure and demo sections
│   ├── app.js           # Local game behavior and UI interactions
│   └── style.css        # Responsive layout and visual styling
└── backend/
    ├── server.js        # Express, Socket.IO, and game-room logic
    ├── store.js         # MongoDB persistence for games and statistics
    ├── scripts/
    │   └── migrate-sqlite-to-mongodb.js
    ├── package.json     # Backend scripts and dependencies
    ├── README.md        # Backend configuration and API reference
    └── test/
        └── server.test.js
```

## Requirements

- Node.js 20 or newer and npm to run or test the backend.
- An internet connection when loading the frontend, which fetches chess.js and web fonts from CDNs.

## Run the frontend

Open `frontend/index.html` in a modern browser. The frontend uses the chess.js browser build from a CDN. Local games run entirely in the browser; no backend is required for them.

## Run the backend

In a terminal, change to the `backend` directory and install dependencies:

```sh
cd backend
npm install
npm start
```

The server listens on `http://localhost:3000` by default. Check that it is running at `http://localhost:3000/health`.

To run the backend integration tests or syntax check:

```sh
npm test
npm run check
```

### Backend configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and Socket.IO server port |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | MongoDB server connection string |
| `MONGODB_DATABASE` | `house_chess` | MongoDB database name |
| `AUTH_SECRET` | development fallback | HMAC secret for account tokens; required in production |
| `NODE_ENV` | unset | Set to `production` to enable secure startup checks |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins; `*` allows any origin |

For local development, install MongoDB as a Windows service as described in the MongoDB guide, then verify it with `mongosh mongodb://127.0.0.1:27017`. Set `CORS_ORIGIN` to the specific origins that should access the backend for deployment. The backend persists completed games and stats in the `games` and `playerStats` collections, but active games and socket connections are in memory and do not survive a restart.

To migrate the existing SQLite records:

```sh
set DB_PATH=backend\data\chess.sqlite
set MONGODB_URI=mongodb://127.0.0.1:27017
set MONGODB_DATABASE=house_chess
npm run migrate:mongodb
```

## Connecting a frontend client

The backend exposes Socket.IO events for real-time games, but `frontend/app.js` currently emits browser `CustomEvent`s (such as `house:matchmaking-request` and `house:move`) rather than connecting to Socket.IO. To enable online play, add a Socket.IO client integration that translates UI actions to the backend requests and applies incoming `gameState` updates. Follow the event contracts and input constraints in the [backend guide](backend/README.md).

## Notes

- Player IDs accepted by the backend are identifiers, not authenticated accounts. Do not use the resulting casual statistics as trusted rankings.
- Chat is plain text. Any client displaying messages must insert them as text rather than HTML.
- Signup and login use the backend account API. Set a strong `AUTH_SECRET` and a restricted `CORS_ORIGIN` before deployment.
- MongoDB access control is required for production; the unauthenticated localhost service is for development only.
