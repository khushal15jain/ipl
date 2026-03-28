const express = require('express');
const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const router = express.Router();
const { getDB, logEvent } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');
const { teamUpload, playerPhotoUpload, csvUpload } = require('../middleware/upload');

// ══════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS (no auth) — for Join Auction flow
// ══════════════════════════════════════════════════════

// GET /api/auctions/public — list all live/draft auctions (id, name, season, status)
router.get('/api/auctions/public', (req, res) => {
  const db = getDB();
  const auctions = db.prepare(
    `SELECT id, name, season, status FROM auctions WHERE status IN ('draft','live') ORDER BY created_at DESC`
  ).all();
  res.json({ auctions });
});

// GET /api/auctions/public/:name/teams — fetch teams for a named auction
router.get('/api/auctions/public/:name/teams', (req, res) => {
  const db = getDB();
  const auction = db.prepare(
    `SELECT id, name, season, status, bid_increment, max_players_per_team, purse_per_team FROM auctions WHERE name = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1`
  ).get(req.params.name);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  const teams = db.prepare('SELECT id, name, emoji, logo_path, purse, spent FROM teams WHERE auction_id = ? ORDER BY id').all(auction.id);
  res.json({ auction, teams });
});

// GET /api/auctions/public/:id/state — full viewer state for a given auction id
router.get('/api/auctions/public/:id/state', (req, res) => {
  const db = getDB();
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Not found' });
  const teams = db.prepare('SELECT * FROM teams WHERE auction_id = ? ORDER BY id').all(auction.id);
  const soldPlayers = db.prepare(
    `SELECT p.*, t.name AS team_name FROM players p
     JOIN teams t ON t.id = p.sold_to_team_id
     WHERE p.auction_id = ? AND p.status IN ('sold','retained')
     ORDER BY p.id`
  ).all(auction.id);
  res.json({ auction, teams, soldPlayers });
});

// All routes below require auth
router.use(authMiddleware);

// ══════════════════════════════════════════════════════
//  AUCTION CRUD
// ══════════════════════════════════════════════════════

// GET /api/auctions — list user's auctions
router.get('/api/auctions', (req, res) => {
  const db = getDB();
  const auctions = db.prepare(`
    SELECT a.*,
      (SELECT COUNT(*) FROM teams   WHERE auction_id = a.id) AS team_count,
      (SELECT COUNT(*) FROM players WHERE auction_id = a.id AND status != 'retained') AS player_count,
      (SELECT COUNT(*) FROM players WHERE auction_id = a.id AND status = 'sold') AS sold_count
    FROM auctions a
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
  `).all(req.user.id);
  res.json({ auctions });
});

// POST /api/auctions — create new auction
router.post('/api/auctions', (req, res) => {
  const { name, season, num_teams, purse_per_team, bid_increment, max_players_per_team } = req.body;
  if (!name) return res.status(400).json({ error: 'Auction name required' });
  const db = getDB();
  const result = db.prepare(`
    INSERT INTO auctions (user_id, name, season, num_teams, purse_per_team, bid_increment, max_players_per_team)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, name, season || '2025', num_teams || 8, purse_per_team || 100, bid_increment || 0.25, max_players_per_team || 11);
  logEvent(result.lastInsertRowid, 'AUCTION_CREATED', `Auction "${name}" created`);
  res.json({ success: true, auction_id: result.lastInsertRowid });
});

// GET /api/auctions/:id — full auction detail
router.get('/api/auctions/:id', (req, res) => {
  const db = getDB();
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  const teams   = db.prepare('SELECT * FROM teams   WHERE auction_id = ? ORDER BY id').all(auction.id);
  const players = db.prepare('SELECT * FROM players WHERE auction_id = ? ORDER BY id').all(auction.id);
  res.json({ auction, teams, players });
});

// PATCH /api/auctions/:id/status — update status
router.patch('/api/auctions/:id/status', (req, res) => {
  const { status } = req.body;
  const db = getDB();
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!auction) return res.status(404).json({ error: 'Not found' });

  const updates = { status };
  if (status === 'live')      updates.started_at   = new Date().toISOString();
  if (status === 'completed') updates.completed_at = new Date().toISOString();

  db.prepare(`UPDATE auctions SET status=?, started_at=COALESCE(?,started_at), completed_at=COALESCE(?,completed_at) WHERE id=?`)
    .run(status, updates.started_at || null, updates.completed_at || null, auction.id);

  logEvent(auction.id, 'STATUS_CHANGE', `Auction status → ${status}`);
  res.json({ success: true });
});

// DELETE /api/auctions/:id
router.delete('/api/auctions/:id', (req, res) => {
  const db = getDB();
  db.prepare('DELETE FROM auctions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
//  TEAMS
// ══════════════════════════════════════════════════════

// POST /api/auctions/:id/teams — add team (with optional logo)
router.post('/api/auctions/:id/teams', teamUpload.single('logo'), (req, res) => {
  const { name, captain, retained_player, emoji } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name required' });

  const db = getDB();
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });

  const teamCount = db.prepare('SELECT COUNT(*) AS c FROM teams WHERE auction_id = ?').get(auction.id).c;
  if (teamCount >= auction.num_teams)
    return res.status(400).json({ error: `Max ${auction.num_teams} teams allowed` });

  const logoPath = req.file ? `/uploads/teams/${req.file.filename}` : null;
  const emojis = ['🦁','🐯','🦅','🐉','🦊','⚡','🔥','🌊','💎','🏆','⭐','🎯'];

  const result = db.prepare(`
    INSERT INTO teams (auction_id, name, logo_path, emoji, captain, retained_player, purse)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(auction.id, name, logoPath, emoji || emojis[teamCount % emojis.length], captain || null, retained_player || null, auction.purse_per_team);

  // If retained player specified, add them as a player record
  if (retained_player) {
    db.prepare(`
      INSERT INTO players (auction_id, name, role, age, base_price, status, sold_to_team_id, sold_price, source)
      VALUES (?, ?, 'Player', 0, 0, 'retained', ?, 0, 'manual')
    `).run(auction.id, retained_player, result.lastInsertRowid);
  }

  logEvent(auction.id, 'TEAM_ADDED', `Team "${name}" added`, null, result.lastInsertRowid);
  res.json({ success: true, team_id: result.lastInsertRowid });
});

// DELETE /api/teams/:teamId
router.delete('/api/teams/:teamId', (req, res) => {
  const db = getDB();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if (team.logo_path) {
    const full = path.join(__dirname, '../public', team.logo_path);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
  db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.teamId);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
//  PLAYERS — MANUAL ADD
// ══════════════════════════════════════════════════════

// POST /api/auctions/:id/players — add single player with photo
router.post('/api/auctions/:id/players', playerPhotoUpload.single('photo'), (req, res) => {
  const { name, role, age, base_price, nationality } = req.body;
  if (!name) return res.status(400).json({ error: 'Player name required' });

  const db = getDB();
  const auction = db.prepare('SELECT id FROM auctions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found' });

  const photoPath = req.file ? `/uploads/players/${req.file.filename}` : null;

  const result = db.prepare(`
    INSERT INTO players (auction_id, name, role, age, base_price, photo_path, nationality, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')
  `).run(auction.id, name, role || 'Batsman', parseInt(age) || 0, parseFloat(base_price) || 1.0, photoPath, nationality || 'Indian');

  logEvent(auction.id, 'PLAYER_ADDED', `Player "${name}" added manually`, result.lastInsertRowid);
  res.json({ success: true, player_id: result.lastInsertRowid });
});

// ══════════════════════════════════════════════════════
//  PLAYERS — CSV IMPORT
//
//  CSV format (with header row):
//  name, role, age, base_price, nationality, image_filename
//
//  Example:
//  name,role,age,base_price,nationality,image_filename
//  Virat Kohli,Batsman,35,20,Indian,virat.jpg
//  Jasprit Bumrah,Bowler,30,15,Indian,bumrah.png
//
//  Upload fields:
//    csv    → the .csv file
//    images → one or more image files matching image_filename column
// ══════════════════════════════════════════════════════

router.post('/api/auctions/:id/players/csv',
  csvUpload.fields([{ name: 'csv', maxCount: 1 }, { name: 'images', maxCount: 100 }]),
  (req, res) => {
    try {
      const db = getDB();
      const auction = db.prepare('SELECT id FROM auctions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
      if (!auction) return res.status(404).json({ error: 'Auction not found' });

      if (!req.files?.csv?.[0])
        return res.status(400).json({ error: 'No CSV file uploaded' });

      const csvPath = req.files.csv[0].path;
      const csvContent = fs.readFileSync(csvPath, 'utf-8');

      // Parse CSV
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });

      // Build a map of uploaded images: originalname → saved filename
      const imageMap = {};
      if (req.files?.images) {
        for (const img of req.files.images) {
          imageMap[img.originalname.toLowerCase()] = img.filename;
        }
      }

      const insert = db.prepare(`
        INSERT INTO players (auction_id, name, role, age, base_price, photo_path, nationality, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'csv')
      `);

      const insertMany = db.transaction((rows) => {
        const results = [];
        for (const row of rows) {
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

          const r = insert.run(auction.id, name, role, age, base_price, photoPath, nationality);
          results.push({ id: r.lastInsertRowid, name });
        }
        return results;
      });

      const added = insertMany(records);

      // Clean up temp CSV
      fs.unlinkSync(csvPath);

      logEvent(auction.id, 'CSV_IMPORT', `${added.length} players imported via CSV`);
      res.json({ success: true, imported: added.length, players: added });
    } catch (err) {
      res.status(500).json({ error: `CSV parse error: ${err.message}` });
    }
  }
);

// DELETE /api/players/:id
router.delete('/api/players/:id', (req, res) => {
  const db = getDB();
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(req.params.id);
  if (!player) return res.status(404).json({ error: 'Player not found' });
  if (player.photo_path) {
    const full = path.join(__dirname, '../public', player.photo_path);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
  db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════
//  BIDDING API (called by socket.io handler too)
// ══════════════════════════════════════════════════════

// POST /api/auctions/:id/bid
router.post('/api/auctions/:id/bid', (req, res) => {
  const { player_id, team_id, bid_amount } = req.body;
  const db = getDB();
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  if (!team) return res.status(404).json({ error: 'Team not found' });
  if ((team.purse - team.spent) < bid_amount)
    return res.status(400).json({ error: 'Insufficient purse' });

  db.prepare('INSERT INTO bids (auction_id, player_id, team_id, bid_amount) VALUES (?,?,?,?)').run(req.params.id, player_id, team_id, bid_amount);
  res.json({ success: true });
});

// POST /api/auctions/:id/sell
router.post('/api/auctions/:id/sell', (req, res) => {
  const { player_id, team_id, price } = req.body;
  const db = getDB();
  const auctionId = parseInt(req.params.id);

  db.prepare("UPDATE players SET status='sold', sold_to_team_id=?, sold_price=? WHERE id=?").run(team_id, price, player_id);
  db.prepare('UPDATE teams SET spent = spent + ? WHERE id = ?').run(price, team_id);
  db.prepare('UPDATE bids SET is_winning=1 WHERE player_id=? AND team_id=? ORDER BY id DESC LIMIT 1').run(player_id, team_id);

  const player = db.prepare('SELECT name FROM players WHERE id=?').get(player_id);
  const team   = db.prepare('SELECT name FROM teams WHERE id=?').get(team_id);
  logEvent(auctionId, 'PLAYER_SOLD', `${player?.name} sold to ${team?.name} for ₹${price}Cr`, player_id, team_id, price);
  res.json({ success: true });
});

// POST /api/auctions/:id/unsold
router.post('/api/auctions/:id/unsold', (req, res) => {
  const { player_id } = req.body;
  const db = getDB();
  db.prepare("UPDATE players SET status='unsold' WHERE id=?").run(player_id);
  const player = db.prepare('SELECT name FROM players WHERE id=?').get(player_id);
  logEvent(parseInt(req.params.id), 'PLAYER_UNSOLD', `${player?.name} went unsold`, player_id);
  res.json({ success: true });
});

// POST /api/auctions/:id/reshuffle — reset unsold → pending
router.post('/api/auctions/:id/reshuffle', (req, res) => {
  const db = getDB();
  const result = db.prepare("UPDATE players SET status='pending' WHERE auction_id=? AND status='unsold'").run(req.params.id);
  logEvent(parseInt(req.params.id), 'RESHUFFLE', `${result.changes} unsold players reshuffled`);
  res.json({ success: true, reshuffled: result.changes });
});

// ══════════════════════════════════════════════════════
//  RESULTS & HISTORY
// ══════════════════════════════════════════════════════

// GET /api/auctions/:id/results
router.get('/api/auctions/:id/results', (req, res) => {
  const db = getDB();
  const auction = db.prepare('SELECT * FROM auctions WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!auction) return res.status(404).json({ error: 'Not found' });

  const teams = db.prepare('SELECT * FROM teams WHERE auction_id=? ORDER BY spent DESC').all(auction.id);
  const results = teams.map(t => {
    const players = db.prepare(
      "SELECT * FROM players WHERE sold_to_team_id=? ORDER BY sold_price DESC NULLS LAST"
    ).all(t.id);
    return { ...t, players };
  });

  const stats = {
    total_players:  db.prepare('SELECT COUNT(*) AS c FROM players WHERE auction_id=?').get(auction.id).c,
    sold:           db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='sold'").get(auction.id).c,
    unsold:         db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='unsold'").get(auction.id).c,
    total_spent:    db.prepare('SELECT SUM(spent) AS s FROM teams WHERE auction_id=?').get(auction.id).s || 0,
    highest_bid:    db.prepare('SELECT MAX(sold_price) AS m FROM players WHERE auction_id=?').get(auction.id).m || 0,
    costliest:      db.prepare("SELECT name, sold_price FROM players WHERE auction_id=? ORDER BY sold_price DESC LIMIT 1").get(auction.id),
  };

  res.json({ auction, teams: results, stats });
});

// GET /api/auctions/:id/history
router.get('/api/auctions/:id/history', (req, res) => {
  const db = getDB();
  const history = db.prepare(`
    SELECT h.*, p.name AS player_name, t.name AS team_name
    FROM auction_history h
    LEFT JOIN players p ON h.player_id = p.id
    LEFT JOIN teams   t ON h.team_id   = t.id
    WHERE h.auction_id = ?
    ORDER BY h.id DESC
    LIMIT 200
  `).all(req.params.id);
  res.json({ history });
});

// GET /api/auctions/:id/bids
router.get('/api/auctions/:id/bids', (req, res) => {
  const db = getDB();
  const bids = db.prepare(`
    SELECT b.*, p.name AS player_name, t.name AS team_name
    FROM bids b
    JOIN players p ON b.player_id = p.id
    JOIN teams   t ON b.team_id   = t.id
    WHERE b.auction_id = ?
    ORDER BY b.id DESC
    LIMIT 500
  `).all(req.params.id);
  res.json({ bids });
});

// GET /api/db/stats — global DB stats
router.get('/api/db/stats', (req, res) => {
  const db = getDB();
  res.json({
    users:    db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
    auctions: db.prepare('SELECT COUNT(*) AS c FROM auctions').get().c,
    teams:    db.prepare('SELECT COUNT(*) AS c FROM teams').get().c,
    players:  db.prepare('SELECT COUNT(*) AS c FROM players').get().c,
    bids:     db.prepare('SELECT COUNT(*) AS c FROM bids').get().c,
    history:  db.prepare('SELECT COUNT(*) AS c FROM auction_history').get().c,
  });
});

module.exports = router;
