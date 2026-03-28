const { Pool } = require('pg');

// Database connection string from environment variable
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_i5SElZgYUuv4@ep-wandering-credit-am7kjfuw-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString: connectionString,
});

let isInitialized = false;

async function getDB() {
  if (!isInitialized) {
    await initSchema();
    isInitialized = true;
  }
  return pool;
}

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- ─────────────────────────────────────────
      --  USERS TABLE
      -- ─────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        name        TEXT    NOT NULL,
        email       TEXT    UNIQUE NOT NULL,
        phone       TEXT    NOT NULL,
        password    TEXT    NOT NULL,
        role        TEXT    DEFAULT 'admin',
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login  TIMESTAMP
      );

      -- ─────────────────────────────────────────
      --  AUCTIONS TABLE
      -- ─────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS auctions (
        id                    SERIAL PRIMARY KEY,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                  TEXT    NOT NULL,
        season                TEXT    DEFAULT '2025',
        num_teams             INTEGER DEFAULT 8,
        purse_per_team        REAL    DEFAULT 100.0,
        bid_increment         REAL    DEFAULT 0.25,
        max_players_per_team  INTEGER DEFAULT 11,
        status                TEXT    DEFAULT 'draft',  -- draft | live | completed
        current_player_id     INTEGER,
        joinCode              TEXT    UNIQUE,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        started_at            TIMESTAMP,
        completed_at          TIMESTAMP
      );

      -- ─────────────────────────────────────────
      --  TEAMS TABLE
      -- ─────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS teams (
        id              SERIAL PRIMARY KEY,
        auction_id      INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
        name            TEXT    NOT NULL,
        logo_path       TEXT,
        emoji           TEXT    DEFAULT '🏏',
        captain         TEXT,
        retained_player TEXT,
        purse           REAL    DEFAULT 100.0,
        spent           REAL    DEFAULT 0.0,
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- ─────────────────────────────────────────
      --  PLAYERS TABLE
      -- ─────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS players (
        id              SERIAL PRIMARY KEY,
        auction_id      INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
        name            TEXT    NOT NULL,
        role            TEXT    DEFAULT 'Batsman',
        age             INTEGER DEFAULT 0,
        base_price      REAL    DEFAULT 1.0,
        photo_path      TEXT,
        nationality     TEXT    DEFAULT 'Indian',
        status          TEXT    DEFAULT 'pending',  -- pending | sold | unsold | retained
        sold_to_team_id INTEGER REFERENCES teams(id),
        sold_price      REAL,
        source          TEXT    DEFAULT 'manual',   -- manual | csv
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- ─────────────────────────────────────────
      --  BIDS TABLE
      -- ─────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS bids (
        id          SERIAL PRIMARY KEY,
        auction_id  INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
        player_id   INTEGER NOT NULL REFERENCES players(id),
        team_id     INTEGER NOT NULL REFERENCES teams(id),
        bid_amount  REAL    NOT NULL,
        is_winning  INTEGER DEFAULT 0,
        bid_time    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- ─────────────────────────────────────────
      --  AUCTION HISTORY / EVENT LOG
      -- ─────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS auction_history (
        id          SERIAL PRIMARY KEY,
        auction_id  INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
        event_type  TEXT    NOT NULL,
        description TEXT,
        player_id   INTEGER,
        team_id     INTEGER,
        amount      REAL,
        extra_data  TEXT,   -- JSON string for any extra info
        event_time  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Migration logic for Postgres
    const colCheck = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='auctions' AND column_name='joincode'
    `);
    
    if (colCheck.rowCount === 0) {
      await client.query(`ALTER TABLE auctions ADD COLUMN joinCode TEXT UNIQUE`);
    }

    // Generate codes for existing auctions if any
    const missingCodes = await client.query(`SELECT id FROM auctions WHERE joinCode IS NULL`);
    for (const row of missingCodes.rows) {
      const code = 'IPL' + Math.random().toString(36).substring(2, 6).toUpperCase();
      await client.query(`UPDATE auctions SET joinCode = $1 WHERE id = $2`, [code, row.id]);
    }

    console.log(`✅ PostgreSQL database ready (connected via pool)`);
  } catch (err) {
    console.error('❌ Database initialization error:', err);
  } finally {
    client.release();
  }
}

// Helper: log an event to auction_history
async function logEvent(auctionId, type, desc, playerId = null, teamId = null, amount = null, extra = null) {
  try {
    await pool.query(`
      INSERT INTO auction_history (auction_id, event_type, description, player_id, team_id, amount, extra_data)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [auctionId, type, desc, playerId, teamId, amount, extra ? JSON.stringify(extra) : null]);
  } catch (err) {
    console.error('❌ Event logging error:', err);
  }
}

module.exports = { pool, getDB, logEvent };
