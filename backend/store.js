const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createStore(databasePath) {
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
    insertGame.run({
      ...game,
      timeControlJson: JSON.stringify(game.timeControl),
    });

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
    saveGame(game) {
      saveGameTransaction(game);
    },
    getGame(gameId) {
      const row = db.prepare('SELECT * FROM games WHERE game_id = ?').get(gameId);
      if (!row) return null;
      return {
        gameId: row.game_id,
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
        createdAt: row.created_at,
        finishedAt: row.finished_at,
      };
    },
    getPlayerGames(playerId, limit) {
      return db.prepare(`
        SELECT game_id AS gameId, room_id AS roomId, white_name AS whiteName,
          black_name AS blackName, result, termination, time_control_json AS timeControlJson,
          created_at AS createdAt, finished_at AS finishedAt
        FROM games
        WHERE white_player_id = ? OR black_player_id = ?
        ORDER BY finished_at DESC
        LIMIT ?
      `).all(playerId, playerId, limit).map(({ timeControlJson, ...game }) => ({
        ...game,
        timeControl: JSON.parse(timeControlJson),
      }));
    },
    getPlayerStats(playerId) {
      const stats = db.prepare(`
        SELECT player_id AS playerId, name, wins, losses, draws, games_played AS gamesPlayed
        FROM player_stats WHERE player_id = ?
      `).get(playerId);
      return stats || {
        playerId,
        name: null,
        wins: 0,
        losses: 0,
        draws: 0,
        gamesPlayed: 0,
      };
    },
    close() {
      db.close();
    },
  };
}

module.exports = { createStore };
