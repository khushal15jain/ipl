const express = require('express');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const router = express.Router();
const { pool, logEvent } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { teamUpload, playerPhotoUpload, csvUpload } = require('../middleware/upload');

// ══════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS (no auth) — for Join Auction flow
// ══════════════════════════════════════════════════════

// GET /api/auctions/public — list all auctions that are currently LIVE
router.get('/api/auctions/public', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, season, status FROM auctions WHERE status = 'live' ORDER BY created_at DESC`
    );
    res.json({ auctions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auctions/public/join/:code — validate joinCode and return auction/teams
router.get('/api/auctions/public/join/:code', async (req, res) => {
  try {
    const auctionResult = await pool.query(
      `SELECT id, name, season, status FROM auctions WHERE LOWER(joincode) = LOWER($1)`,
      [req.params.code]
    );
    const auction = auctionResult.rows[0];

    if (!auction) return res.status(404).json({ error: 'Invalid Join Code' });

    const teamsResult = await pool.query(
      'SELECT id, name, emoji, logo_path FROM teams WHERE auction_id = $1 ORDER BY id',
      [auction.id]
    );
    res.json({ auction, teams: teamsResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auctions/public/:name/teams — fetch teams for a named auction
router.get('/api/auctions/public/:name/teams', async (req, res) => {
  try {
    const auctionResult = await pool.query(
      `SELECT id, name, season, status, bid_increment, max_players_per_team, purse_per_team 
       FROM auctions WHERE LOWER(name) = LOWER($1) ORDER BY created_at DESC LIMIT 1`,
      [req.params.name]
    );
    const auction = auctionResult.rows[0];
    if (!auction) return res.status(404).json({ error: 'Auction not found' });
    
    const teamsResult = await pool.query(
      'SELECT id, name, emoji, logo_path, purse, spent FROM teams WHERE auction_id = $1 ORDER BY id',
      [auction.id]
    );
    res.json({ auction, teams: teamsResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auctions/public/:id/state — full viewer state for a given auction id
router.get('/api/auctions/public/:id/state', async (req, res) => {
  try {
    const auctionResult = await pool.query('SELECT * FROM auctions WHERE id = $1', [req.params.id]);
    const auction = auctionResult.rows[0];
    if (!auction) return res.status(404).json({ error: 'Not found' });
    
    const teamsResult = await pool.query('SELECT * FROM teams WHERE auction_id = $1 ORDER BY id', [auction.id]);
    const soldPlayersResult = await pool.query(
      `SELECT p.*, t.name AS team_name FROM players p
       JOIN teams t ON t.id = p.sold_to_team_id
       WHERE p.auction_id = $1 AND p.status IN ('sold','retained')
       ORDER BY p.id`,
      [auction.id]
    );
    res.json({ auction, teams: teamsResult.rows, soldPlayers: soldPlayersResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All routes below require auth
router.use(authMiddleware);

// ══════════════════════════════════════════════════════
//  AUCTION CRUD
// ══════════════════════════════════════════════════════

// GET /api/auctions — list user's auctions
router.get('/api/auctions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.*,
        (SELECT COUNT(*) FROM teams   WHERE auction_id = a.id) AS team_count,
        (SELECT COUNT(*) FROM players WHERE auction_id = a.id AND status != 'retained') AS player_count,
        (SELECT COUNT(*) FROM players WHERE auction_id = a.id AND status = 'sold') AS sold_count
      FROM auctions a
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `, [req.user.id]);
    res.json({ auctions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auctions — create new auction
router.post('/api/auctions', async (req, res) => {
  try {
    const { name, season, num_teams, purse_per_team, bid_increment, max_players_per_team } = req.body;
    if (!name) return res.status(400).json({ error: 'Auction name required' });

    // Generate unique 6-char join code (IPL + 3 random)
    let joinCode;
    let exists = true;
    while (exists) {
      joincode = 'IPL' + Math.random().toString(36).substring(2, 6).toUpperCase();
      const check = await pool.query('SELECT id FROM auctions WHERE joincode = $1', [joincode]);
      if (check.rowCount === 0) exists = false;
    }

    const result = await pool.query(`
      INSERT INTO auctions (user_id, name, season, num_teams, purse_per_team, bid_increment, max_players_per_team, joincode)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id
    `, [req.user.id, name, season || '2025', num_teams || 8, purse_per_team || 100, bid_increment || 0.25, max_players_per_team || 11, joincode]);

    const newId = result.rows[0].id;
    await logEvent(newId, 'AUCTION_CREATED', `Auction "${name}" created (Code: ${joincode})`);
    res.json({ success: true, auction_id: newId, joincode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auctions/:id — full auction detail
router.get('/api/auctions/:id', async (req, res) => {
  try {
    const auctionResult = await pool.query('SELECT * FROM auctions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const auction = auctionResult.rows[0];
    if (!auction) return res.status(404).json({ error: 'Auction not found' });
    
    const teamsResult   = await pool.query('SELECT * FROM teams WHERE auction_id = $1 ORDER BY id', [auction.id]);
    const playersResult = await pool.query('SELECT * FROM players WHERE auction_id = $1 ORDER BY id', [auction.id]);
    
    res.json({ auction, teams: teamsResult.rows, players: playersResult.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/auctions/:id/status — update status
router.patch('/api/auctions/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const auctionResult = await pool.query('SELECT * FROM auctions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const auction = auctionResult.rows[0];
    if (!auction) return res.status(404).json({ error: 'Not found' });

    let started_at = auction.started_at;
    let completed_at = auction.completed_at;

    if (status === 'live') started_at = new Date().toISOString();
    if (status === 'completed') completed_at = new Date().toISOString();

    await pool.query(
      `UPDATE auctions SET status=$1, started_at=$2, completed_at=$3 WHERE id=$4`,
      [status, started_at, completed_at, auction.id]
    );

    await logEvent(auction.id, 'STATUS_CHANGE', `Auction status → ${status}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auctions/:id
router.delete('/api/auctions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM auctions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  TEAMS
// ══════════════════════════════════════════════════════

// POST /api/auctions/:id/teams — add team (with optional logo)
router.post('/api/auctions/:id/teams', teamUpload.single('logo'), async (req, res) => {
  try {
    const { name, captain, retained_player, emoji } = req.body;
    if (!name) return res.status(400).json({ error: 'Team name required' });

    const auctionResult = await pool.query('SELECT * FROM auctions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const auction = auctionResult.rows[0];
    if (!auction) return res.status(404).json({ error: 'Auction not found' });

    const countResult = await pool.query('SELECT COUNT(*) AS c FROM teams WHERE auction_id = $1', [auction.id]);
    const teamCount = parseInt(countResult.rows[0].c);
    if (teamCount >= auction.num_teams)
      return res.status(400).json({ error: `Max ${auction.num_teams} teams allowed` });

    const logoPath = req.file ? `/uploads/teams/${req.file.filename}` : null;
    const emojis = ['🦁','🐯','🦅','🐉','🦊','⚡','🔥','🌊','💎','🏆','⭐','🎯'];

    const insertResult = await pool.query(`
      INSERT INTO teams (auction_id, name, logo_path, emoji, captain, retained_player, purse)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [auction.id, name, logoPath, emoji || emojis[teamCount % emojis.length], captain || null, retained_player || null, auction.purse_per_team]);

    const newTeamId = insertResult.rows[0].id;

    // If retained player specified, add them as a player record
    if (retained_player) {
      await pool.query(`
        INSERT INTO players (auction_id, name, role, age, base_price, status, sold_to_team_id, sold_price, source)
        VALUES ($1, $2, 'Player', 0, 0, 'retained', $3, 0, 'manual')
      `, [auction.id, retained_player, newTeamId]);
    }

    await logEvent(auction.id, 'TEAM_ADDED', `Team "${name}" added`, null, newTeamId);
    res.json({ success: true, team_id: newTeamId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/teams/:teamId
router.delete('/api/teams/:teamId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM teams WHERE id = $1', [req.params.teamId]);
    const team = result.rows[0];
    if (!team) return res.status(404).json({ error: 'Team not found' });
    
    if (team.logo_path) {
      const full = path.join(__dirname, '../public', team.logo_path);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
    await pool.query('DELETE FROM teams WHERE id = $1', [req.params.teamId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  PLAYERS — MANUAL ADD
// ══════════════════════════════════════════════════════

// POST /api/auctions/:id/players — add single player with photo
router.post('/api/auctions/:id/players', playerPhotoUpload.single('photo'), async (req, res) => {
  try {
    const { name, role, age, base_price, nationality } = req.body;
    if (!name) return res.status(400).json({ error: 'Player name required' });

    const auctionResult = await pool.query('SELECT id FROM auctions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    const auction = auctionResult.rows[0];
    if (!auction) return res.status(404).json({ error: 'Auction not found' });

    const photoPath = req.file ? `/uploads/players/${req.file.filename}` : null;

    const result = await pool.query(`
      INSERT INTO players (auction_id, name, role, age, base_price, photo_path, nationality, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')
      RETURNING id
    `, [auction.id, name, role || 'Batsman', parseInt(age) || 0, parseFloat(base_price) || 1.0, photoPath, nationality || 'Indian']);

    const newPlayerId = result.rows[0].id;
    await logEvent(auction.id, 'PLAYER_ADDED', `Player "${name}" added manually`, newPlayerId);
    res.json({ success: true, player_id: newPlayerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  PLAYERS — CSV IMPORT
// ══════════════════════════════════════════════════════

router.post('/api/auctions/:id/players/csv',
  csvUpload.fields([{ name: 'csv', maxCount: 1 }, { name: 'images', maxCount: 100 }]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const auctionResult = await client.query('SELECT id FROM auctions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
      const auction = auctionResult.rows[0];
      if (!auction) return res.status(404).json({ error: 'Auction not found' });

      if (!req.files?.csv?.[0])
        return res.status(400).json({ error: 'No CSV file uploaded' });

      const csvPath = req.files.csv[0].path;
      const csvContent = fs.readFileSync(csvPath, 'utf-8');

      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });

      const imageMap = {};
      if (req.files?.images) {
        for (const img of req.files.images) {
          imageMap[img.originalname.toLowerCase()] = img.filename;
        }
      }

      await client.query('BEGIN');
      const added = [];
      for (const row of records) {
        const name = (row.name || row.Name || '').trim();
        if (!name) continue;

        const role        = (row.role || row.Role || 'Batsman').trim();
        const age         = parseInt(row.age || row.Age) || 0;
        const base_price  = parseFloat(row.base_price || row['Base Price'] || row.base || 1.0);
        const nationality = (row.nationality || row.Nationality || 'Indian').trim();
        const imgFile     = (row.image_filename || row.image || row.photo || '').trim().toLowerCase();

        let photoPath = null;
        if (imgFile && imageMap[imgFile]) {
          photoPath = `/uploads/players/${imageMap[imgFile]}`;
        }

        const r = await client.query(`
          INSERT INTO players (auction_id, name, role, age, base_price, photo_path, nationality, source)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'csv')
          RETURNING id
        `, [auction.id, name, role, age, base_price, photoPath, nationality]);
        
        added.push({ id: r.rows[0].id, name });
      }
      await client.query('COMMIT');

      fs.unlinkSync(csvPath);
      await logEvent(auction.id, 'CSV_IMPORT', `${added.length} players imported via CSV`);
      res.json({ success: true, imported: added.length, players: added });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: `CSV import error: ${err.message}` });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/players/:id
router.delete('/api/players/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM players WHERE id = $1', [req.params.id]);
    const player = result.rows[0];
    if (!player) return res.status(404).json({ error: 'Player not found' });
    
    if (player.photo_path) {
      const full = path.join(__dirname, '../public', player.photo_path);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    }
    await pool.query('DELETE FROM players WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  BIDDING API
// ══════════════════════════════════════════════════════

// POST /api/auctions/:id/bid
router.post('/api/auctions/:id/bid', async (req, res) => {
  try {
    const { player_id, team_id, bid_amount } = req.body;
    const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [team_id]);
    const team = teamResult.rows[0];
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if ((team.purse - team.spent) < bid_amount)
      return res.status(400).json({ error: 'Insufficient purse' });

    await pool.query(
      'INSERT INTO bids (auction_id, player_id, team_id, bid_amount) VALUES ($1,$2,$3,$4)',
      [req.params.id, player_id, team_id, bid_amount]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auctions/:id/sell
router.post('/api/auctions/:id/sell', async (req, res) => {
  const client = await pool.connect();
  try {
    const { player_id, team_id, price } = req.body;
    const auctionId = parseInt(req.params.id);

    await client.query('BEGIN');
    await client.query("UPDATE players SET status='sold', sold_to_team_id=$1, sold_price=$2 WHERE id=$3", [team_id, price, player_id]);
    await client.query('UPDATE teams SET spent = spent + $1 WHERE id = $2', [price, team_id]);
    
    // Postgres doesn't allow ORDER BY/LIMIT in UPDATE directly like SQLite in one line easily without a subquery
    await client.query(`
      UPDATE bids SET is_winning=1 WHERE id = (
        SELECT id FROM bids WHERE player_id=$1 AND team_id=$2 ORDER BY id DESC LIMIT 1
      )
    `, [player_id, team_id]);
    
    await client.query('COMMIT');

    const pResult = await pool.query('SELECT name FROM players WHERE id=$1', [player_id]);
    const tResult = await pool.query('SELECT name FROM teams WHERE id=$1', [team_id]);
    const player = pResult.rows[0];
    const team = tResult.rows[0];
    
    await logEvent(auctionId, 'PLAYER_SOLD', `${player?.name} sold to ${team?.name} for ₹${price}Cr`, player_id, team_id, price);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/auctions/:id/unsold
router.post('/api/auctions/:id/unsold', async (req, res) => {
  try {
    const { player_id } = req.body;
    await pool.query("UPDATE players SET status='unsold' WHERE id=$1", [player_id]);
    const pResult = await pool.query('SELECT name FROM players WHERE id=$1', [player_id]);
    const player = pResult.rows[0];
    await logEvent(parseInt(req.params.id), 'PLAYER_UNSOLD', `${player?.name} went unsold`, player_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auctions/:id/reshuffle — reset unsold → pending
router.post('/api/auctions/:id/reshuffle', async (req, res) => {
  try {
    const result = await pool.query("UPDATE players SET status='pending' WHERE auction_id=$1 AND status='unsold'", [req.params.id]);
    await logEvent(parseInt(req.params.id), 'RESHUFFLE', `${result.rowCount} unsold players reshuffled`);
    res.json({ success: true, reshuffled: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auctions/:id/results
router.get('/api/auctions/:id/results', async (req, res) => {
  try {
    const auctionResult = await pool.query('SELECT * FROM auctions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    const auction = auctionResult.rows[0];
    if (!auction) return res.status(404).json({ error: 'Not found' });

    const teamsResult = await pool.query('SELECT * FROM teams WHERE auction_id=$1 ORDER BY spent DESC', [auction.id]);
    const teams = teamsResult.rows;
    
    const results = [];
    for (const t of teams) {
      const playersResult = await pool.query(
        "SELECT * FROM players WHERE sold_to_team_id=$1 ORDER BY sold_price DESC NULLS LAST",
        [t.id]
      );
      results.push({ ...t, players: playersResult.rows });
    }

    const totalRes    = await pool.query('SELECT COUNT(*) AS c FROM players WHERE auction_id=$1', [auction.id]);
    const soldRes     = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='sold'", [auction.id]);
    const unsoldRes   = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='unsold'", [auction.id]);
    const spentRes    = await pool.query('SELECT SUM(spent) AS s FROM teams WHERE auction_id=$1', [auction.id]);
    const maxRes      = await pool.query('SELECT MAX(sold_price) AS m FROM players WHERE auction_id=$1', [auction.id]);
    const costliestRes = await pool.query("SELECT name, sold_price FROM players WHERE auction_id=$1 ORDER BY sold_price DESC LIMIT 1", [auction.id]);

    const stats = {
      total_players: parseInt(totalRes.rows[0].c),
      sold:          parseInt(soldRes.rows[0].c),
      unsold:        parseInt(unsoldRes.rows[0].c),
      total_spent:   parseFloat(spentRes.rows[0].s || 0),
      highest_bid:   parseFloat(maxRes.rows[0].m || 0),
      costliest:     costliestRes.rows[0],
    };

    res.json({ auction, teams: results, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auctions/:id/history
router.get('/api/auctions/:id/history', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT h.*, p.name AS player_name, t.name AS team_name
      FROM auction_history h
      LEFT JOIN players p ON h.player_id = p.id
      LEFT JOIN teams   t ON h.team_id   = t.id
      WHERE h.auction_id = $1
      ORDER BY h.id DESC
      LIMIT 200
    `, [req.params.id]);
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auctions/:id/bids
router.get('/api/auctions/:id/bids', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, p.name AS player_name, t.name AS team_name
      FROM bids b
      JOIN players p ON b.player_id = p.id
      JOIN teams   t ON b.team_id   = t.id
      WHERE b.auction_id = $1
      ORDER BY b.id DESC
      LIMIT 500
    `, [req.params.id]);
    res.json({ bids: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/db/stats — global DB stats
router.get('/api/db/stats', async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*) AS c FROM users');
    const auctions = await pool.query('SELECT COUNT(*) AS c FROM auctions');
    const teams = await pool.query('SELECT COUNT(*) AS c FROM teams');
    const players = await pool.query('SELECT COUNT(*) AS c FROM players');
    const bids = await pool.query('SELECT COUNT(*) AS c FROM bids');
    const history = await pool.query('SELECT COUNT(*) AS c FROM auction_history');
    
    res.json({
      users:    parseInt(users.rows[0].c),
      auctions: parseInt(auctions.rows[0].c),
      teams:    parseInt(teams.rows[0].c),
      players:  parseInt(players.rows[0].c),
      bids:     parseInt(bids.rows[0].c),
      history:  parseInt(history.rows[0].c),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
