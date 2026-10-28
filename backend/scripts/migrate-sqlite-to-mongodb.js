const path = require('node:path');
const Database = require('better-sqlite3');
const { MongoClient } = require('mongodb');

const sqlitePath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'chess.sqlite');
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DATABASE || 'house_chess';

function tableExists(sqlite, tableName) {
  return Boolean(sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName));
}

async function migrate() {
  const sqlite = new Database(sqlitePath, { readonly: true });
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const database = client.db(databaseName);
    const games = database.collection('games');
    const playerStats = database.collection('playerStats');
    const users = database.collection('users');
    const activeGames = database.collection('activeGames');
    await Promise.all([
      games.createIndex({ whitePlayerId: 1, finishedAt: -1 }),
      games.createIndex({ blackPlayerId: 1, finishedAt: -1 }),
      games.createIndex({ finishedAt: -1 }),
      users.createIndex({ email: 1 }, { unique: true }),
      activeGames.createIndex({ updatedAt: -1 }),
    ]);

    const gameRows = sqlite.prepare('SELECT * FROM games').all();
    for (const row of gameRows) {
      await games.updateOne(
        { _id: row.game_id },
        {
          $setOnInsert: {
            _id: row.game_id,
            roomId: row.room_id,
            whitePlayerId: row.white_player_id,
            blackPlayerId: row.black_player_id,
            whiteName: row.white_name,
            blackName: row.black_name,
            result: row.result,
            termination: row.termination,
            pgn: row.pgn,
            finalFen: row.final_fen,
            timeControl: JSON.parse(row.time_control_json),
            createdAt: new Date(row.created_at),
            finishedAt: new Date(row.finished_at),
          },
        },
        { upsert: true },
      );
    }

    const userRows = tableExists(sqlite, 'users')
      ? sqlite.prepare('SELECT * FROM users').all()
      : [];
    for (const row of userRows) {
      await users.updateOne(
        { _id: row.user_id },
        {
          $setOnInsert: {
            _id: row.user_id,
            email: row.email,
            name: row.name,
            passwordHash: row.password_hash,
            createdAt: new Date(row.created_at),
          },
        },
        { upsert: true },
      );
    }

    const activeGameRows = tableExists(sqlite, 'active_games')
      ? sqlite.prepare('SELECT * FROM active_games').all()
      : [];
    for (const row of activeGameRows) {
      await activeGames.updateOne(
        { _id: row.room_id },
        {
          $setOnInsert: {
            ...JSON.parse(row.snapshot_json),
            _id: row.room_id,
            updatedAt: new Date(row.updated_at),
          },
        },
        { upsert: true },
      );
    }

    const statsRows = sqlite.prepare('SELECT * FROM player_stats').all();
    for (const row of statsRows) {
      await playerStats.updateOne(
        { _id: row.player_id },
        {
          $set: {
            name: row.name,
            wins: row.wins,
            losses: row.losses,
            draws: row.draws,
            gamesPlayed: row.games_played,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
    console.log(
      `Migrated ${gameRows.length} games, ${statsRows.length} player statistics, `
      + `${userRows.length} users, and ${activeGameRows.length} active games.`,
    );
  } finally {
    sqlite.close();
    await client.close();
  }
}

migrate().catch((error) => {
  console.error('MongoDB migration failed:', error);
  process.exitCode = 1;
});
