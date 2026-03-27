const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Database file stored in /db folder
const DB_PATH = path.join(__dirname, 'auction.db');

let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH, { verbose: process.env.NODE_ENV === 'development' ? console.log : null });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- ─────────────────────────────────────────
    --  USERS TABLE
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      email       TEXT    UNIQUE NOT NULL,
      phone       TEXT    NOT NULL,
      password    TEXT    NOT NULL,
      role        TEXT    DEFAULT 'admin',
      created_at  TEXT    DEFAULT (datetime('now','localtime')),
      last_login  TEXT
    );

    -- ─────────────────────────────────────────
    --  AUCTIONS TABLE
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS auctions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER NOT NULL,
      name                  TEXT    NOT NULL,
      season                TEXT    DEFAULT '2025',
      num_teams             INTEGER DEFAULT 8,
      purse_per_team        REAL    DEFAULT 100.0,
      bid_increment         REAL    DEFAULT 0.25,
      max_players_per_team  INTEGER DEFAULT 11,
      status                TEXT    DEFAULT 'draft',  -- draft | live | completed
      current_player_id     INTEGER,
      created_at            TEXT    DEFAULT (datetime('now','localtime')),
      started_at            TEXT,
      completed_at          TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- ─────────────────────────────────────────
    --  TEAMS TABLE
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS teams (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id      INTEGER NOT NULL,
      name            TEXT    NOT NULL,
      logo_path       TEXT,
      emoji           TEXT    DEFAULT '🏏',
      captain         TEXT,
      retained_player TEXT,
      purse           REAL    DEFAULT 100.0,
      spent           REAL    DEFAULT 0.0,
      created_at      TEXT    DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE
    );

    -- ─────────────────────────────────────────
    --  PLAYERS TABLE
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS players (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id      INTEGER NOT NULL,
      name            TEXT    NOT NULL,
      role            TEXT    DEFAULT 'Batsman',
      age             INTEGER DEFAULT 0,
      base_price      REAL    DEFAULT 1.0,
      photo_path      TEXT,
      nationality     TEXT    DEFAULT 'Indian',
      status          TEXT    DEFAULT 'pending',  -- pending | sold | unsold | retained
      sold_to_team_id INTEGER,
      sold_price      REAL,
      source          TEXT    DEFAULT 'manual',   -- manual | csv
      created_at      TEXT    DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE,
      FOREIGN KEY (sold_to_team_id) REFERENCES teams(id)
    );

    -- ─────────────────────────────────────────
    --  BIDS TABLE
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS bids (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id  INTEGER NOT NULL,
      player_id   INTEGER NOT NULL,
      team_id     INTEGER NOT NULL,
      bid_amount  REAL    NOT NULL,
      is_winning  INTEGER DEFAULT 0,
      bid_time    TEXT    DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id)  REFERENCES players(id),
      FOREIGN KEY (team_id)    REFERENCES teams(id)
    );

    -- ─────────────────────────────────────────
    --  AUCTION HISTORY / EVENT LOG
    -- ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS auction_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      auction_id  INTEGER NOT NULL,
      event_type  TEXT    NOT NULL,
      description TEXT,
      player_id   INTEGER,
      team_id     INTEGER,
      amount      REAL,
      extra_data  TEXT,   -- JSON string for any extra info
      event_time  TEXT    DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (auction_id) REFERENCES auctions(id) ON DELETE CASCADE
    );

    -- ─────────────────────────────────────────
    --  INDEXES for performance
    -- ─────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_auctions_user    ON auctions(user_id);
    CREATE INDEX IF NOT EXISTS idx_teams_auction    ON teams(auction_id);
    CREATE INDEX IF NOT EXISTS idx_players_auction  ON players(auction_id);
    CREATE INDEX IF NOT EXISTS idx_players_status   ON players(status);
    CREATE INDEX IF NOT EXISTS idx_bids_auction     ON bids(auction_id);
    CREATE INDEX IF NOT EXISTS idx_bids_player      ON bids(player_id);
    CREATE INDEX IF NOT EXISTS idx_history_auction  ON auction_history(auction_id);
  `);

  // Migration: add max_players_per_team to existing DBs
  try {
    db.exec(`ALTER TABLE auctions ADD COLUMN max_players_per_team INTEGER DEFAULT 11`);
  } catch (_) { /* column already exists */ }

  console.log(`✅ SQLite database ready → ${DB_PATH}`);
}

// Helper: log an event to auction_history
function logEvent(auctionId, type, desc, playerId = null, teamId = null, amount = null, extra = null) {
  const d = getDB();
  d.prepare(`
    INSERT INTO auction_history (auction_id, event_type, description, player_id, team_id, amount, extra_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(auctionId, type, desc, playerId, teamId, amount, extra ? JSON.stringify(extra) : null);
}

module.exports = { getDB, logEvent };
