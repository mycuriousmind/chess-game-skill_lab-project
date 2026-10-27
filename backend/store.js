const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { MongoClient } = require('mongodb');

function createSqliteStore(databasePath) {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS games (
      game_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      white_player_id TEXT,
      black_player_id TEXT,
      white_name TEXT NOT NULL,
      black_name TEXT NOT NULL,
      result TEXT NOT NULL,
      termination TEXT NOT NULL,
      pgn TEXT NOT NULL,
      final_fen TEXT NOT NULL,
      time_control_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS games_white_player_finished
      ON games (white_player_id, finished_at DESC);
    CREATE INDEX IF NOT EXISTS games_black_player_finished
      ON games (black_player_id, finished_at DESC);
    CREATE TABLE IF NOT EXISTS player_stats (
      player_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      games_played INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS active_games (
      room_id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const insertGame = db.prepare(`
    INSERT INTO games (
      game_id, room_id, white_player_id, black_player_id, white_name, black_name,
      result, termination, pgn, final_fen, time_control_json, created_at, finished_at
    ) VALUES (
      @gameId, @roomId, @whitePlayerId, @blackPlayerId, @whiteName, @blackName,
      @result, @termination, @pgn, @finalFen, @timeControlJson, @createdAt, @finishedAt
    )
  `);
  const upsertStats = db.prepare(`
    INSERT INTO player_stats (player_id, name, wins, losses, draws, games_played)
    VALUES (@playerId, @name, @wins, @losses, @draws, 1)
    ON CONFLICT(player_id) DO UPDATE SET
      name = excluded.name,
      wins = player_stats.wins + excluded.wins,
      losses = player_stats.losses + excluded.losses,
      draws = player_stats.draws + excluded.draws,
      games_played = player_stats.games_played + 1
  `);
  const saveGameTransaction = db.transaction((game) => {
    insertGame.run({ ...game, timeControlJson: JSON.stringify(game.timeControl) });
    for (const side of ['white', 'black']) {
      const playerId = game[`${side}PlayerId`];
      if (!playerId) continue;
      const isDraw = game.result === '1/2-1/2';
      const won = !isDraw && ((side === 'white' && game.result === '1-0') || (side === 'black' && game.result === '0-1'));
      upsertStats.run({
        playerId,
        name: game[`${side}Name`],
        wins: won ? 1 : 0,
        losses: !isDraw && !won ? 1 : 0,
        draws: isDraw ? 1 : 0,
      });
    }
  });

  return {
    ready: Promise.resolve(),
    saveGame(game) {
      saveGameTransaction(game);
    },
    getGame(gameId) {
      const row = db.prepare('SELECT * FROM games WHERE game_id = ?').get(gameId);
      if (!row) return null;
      return {
        gameId: row.game_id, roomId: row.room_id, whitePlayerId: row.white_player_id,
        blackPlayerId: row.black_player_id, whiteName: row.white_name, blackName: row.black_name,
        result: row.result, termination: row.termination, pgn: row.pgn, finalFen: row.final_fen,
        timeControl: JSON.parse(row.time_control_json), createdAt: row.created_at, finishedAt: row.finished_at,
      };
    },
    getPlayerGames(playerId, limit) {
      return db.prepare(`
        SELECT game_id AS gameId, room_id AS roomId, white_name AS whiteName,
          black_name AS blackName, result, termination, time_control_json AS timeControlJson,
          created_at AS createdAt, finished_at AS finishedAt
        FROM games WHERE white_player_id = ? OR black_player_id = ?
        ORDER BY finished_at DESC LIMIT ?
      `).all(playerId, playerId, limit).map(({ timeControlJson, ...game }) => ({
        ...game, timeControl: JSON.parse(timeControlJson),
      }));
    },
    getPlayerStats(playerId) {
      const stats = db.prepare(`
        SELECT player_id AS playerId, name, wins, losses, draws, games_played AS gamesPlayed
        FROM player_stats WHERE player_id = ?
      `).get(playerId);
      return stats || { playerId, name: null, wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
    },
    createUser(user) {
      db.prepare(`
        INSERT INTO users (user_id, email, name, password_hash, created_at)
        VALUES (@userId, @email, @name, @passwordHash, @createdAt)
      `).run(user);
      return user;
    },
    getUserByEmail(email) {
      return db.prepare('SELECT user_id AS userId, email, name, password_hash AS passwordHash, created_at AS createdAt FROM users WHERE email = ?').get(email) || null;
    },
    getUserById(userId) {
      return db.prepare('SELECT user_id AS userId, email, name, created_at AS createdAt FROM users WHERE user_id = ?').get(userId) || null;
    },
    saveActiveGame(snapshot) {
      db.prepare(`
        INSERT INTO active_games (room_id, snapshot_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
      `).run(snapshot.roomId, JSON.stringify(snapshot), new Date().toISOString());
    },
    deleteActiveGame(roomId) {
      db.prepare('DELETE FROM active_games WHERE room_id = ?').run(roomId);
    },
    getActiveGames() {
      return db.prepare('SELECT snapshot_json AS snapshot FROM active_games').all()
        .map(({ snapshot }) => JSON.parse(snapshot));
    },
    close() {
      db.close();
    },
  };
}

function toGameDocument(game) {
  return {
    _id: game.gameId,
    roomId: game.roomId,
    whitePlayerId: game.whitePlayerId,
    blackPlayerId: game.blackPlayerId,
    whiteName: game.whiteName,
    blackName: game.blackName,
    result: game.result,
    termination: game.termination,
    pgn: game.pgn,
    finalFen: game.finalFen,
    timeControl: game.timeControl,
    createdAt: new Date(game.createdAt),
    finishedAt: new Date(game.finishedAt),
  };
}

function fromGameDocument(game, includeDetails = true) {
  const result = {
    gameId: game._id,
    roomId: game.roomId,
    whiteName: game.whiteName,
    blackName: game.blackName,
    result: game.result,
    termination: game.termination,
    timeControl: game.timeControl,
    createdAt: game.createdAt.toISOString(),
    finishedAt: game.finishedAt.toISOString(),
  };
  if (includeDetails) {
    return {
      ...result,
      whitePlayerId: game.whitePlayerId,
      blackPlayerId: game.blackPlayerId,
      pgn: game.pgn,
      finalFen: game.finalFen,
    };
  }
  return result;
}

function createMongoStore({ uri, databaseName }) {
  const client = new MongoClient(uri);
  const database = client.db(databaseName);
  const games = database.collection('games');
  const playerStats = database.collection('playerStats');
  const users = database.collection('users');
  const activeGames = database.collection('activeGames');
  const ready = client.connect().then(async () => {
    await Promise.all([
      games.createIndex({ whitePlayerId: 1, finishedAt: -1 }),
      games.createIndex({ blackPlayerId: 1, finishedAt: -1 }),
      games.createIndex({ finishedAt: -1 }),
      users.createIndex({ email: 1 }, { unique: true }),
      activeGames.createIndex({ updatedAt: -1 }),
    ]);
    console.log(`Connected to MongoDB database "${databaseName}"`);
  });

  async function saveGame(game) {
    await ready;
    try {
      await games.insertOne(toGameDocument(game));
    } catch (error) {
      if (error?.code === 11000) return;
      throw error;
    }
    for (const side of ['white', 'black']) {
      const playerId = game[`${side}PlayerId`];
      if (!playerId) continue;
      const isDraw = game.result === '1/2-1/2';
      const won = !isDraw && ((side === 'white' && game.result === '1-0') || (side === 'black' && game.result === '0-1'));
      await playerStats.updateOne(
        { _id: playerId },
        {
          $set: { name: game[`${side}Name`], updatedAt: new Date() },
          $setOnInsert: { wins: 0, losses: 0, draws: 0, gamesPlayed: 0 },
          $inc: { wins: won ? 1 : 0, losses: !isDraw && !won ? 1 : 0, draws: isDraw ? 1 : 0, gamesPlayed: 1 },
        },
        { upsert: true },
      );
    }
  }

  return {
    ready,
    saveGame,
    async getGame(gameId) {
      await ready;
      const game = await games.findOne({ _id: gameId });
      return game ? fromGameDocument(game) : null;
    },
    async getPlayerGames(playerId, limit) {
      await ready;
      const records = await games.find({ $or: [{ whitePlayerId: playerId }, { blackPlayerId: playerId }] })
        .sort({ finishedAt: -1 }).limit(limit).toArray();
      return records.map((game) => fromGameDocument(game, false));
    },
    async getPlayerStats(playerId) {
      await ready;
      const stats = await playerStats.findOne({ _id: playerId });
      return stats
        ? { playerId: stats._id, name: stats.name, wins: stats.wins, losses: stats.losses, draws: stats.draws, gamesPlayed: stats.gamesPlayed }
        : { playerId, name: null, wins: 0, losses: 0, draws: 0, gamesPlayed: 0 };
    },
    async createUser(user) {
      await ready;
      await users.insertOne({
        _id: user.userId,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        createdAt: new Date(user.createdAt),
      });
      return user;
    },
    async getUserByEmail(email) {
      await ready;
      const user = await users.findOne({ email });
      return user ? {
        userId: user._id,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        createdAt: user.createdAt.toISOString(),
      } : null;
    },
    async getUserById(userId) {
      await ready;
      const user = await users.findOne({ _id: userId });
      return user ? {
        userId: user._id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt.toISOString(),
      } : null;
    },
    async saveActiveGame(snapshot) {
      await ready;
      await activeGames.replaceOne(
        { _id: snapshot.roomId },
        { ...snapshot, _id: snapshot.roomId, updatedAt: new Date() },
        { upsert: true },
      );
    },
    async deleteActiveGame(roomId) {
      await ready;
      await activeGames.deleteOne({ _id: roomId });
    },
    async getActiveGames() {
      await ready;
      return activeGames.find({}).toArray();
    },
    async close() {
      await ready;
      await client.close();
    },
  };
}

function createStore(options = {}) {
  if (typeof options === 'string') return createSqliteStore(options);
  if (options.databasePath) return createSqliteStore(options.databasePath);
  return createMongoStore({
    uri: options.mongoUri || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
    databaseName: options.databaseName || process.env.MONGODB_DATABASE || 'house_chess',
  });
}

module.exports = { createStore };
