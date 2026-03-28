require('dotenv').config();
const express    = require('express');
const http       = require('http');
const dbPath = path.join("/data", "auction.db");
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { getDB, logEvent } = require('./db/database');
const { authMiddleware } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const fs = require("fs");

if (!fs.existsSync("/data")) {
  fs.mkdirSync("/data");
}

if (!fs.existsSync(dbPath)) {
  console.log("Creating new database...");
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/auction'));

// Page routes
app.get('/', (req, res) => res.redirect('/login'));
app.get('/dashboard', authMiddleware, (req, res) => res.sendFile('dashboard.html', { root: './public' }));
app.get('/auction/:id', authMiddleware, (req, res) => res.sendFile('auction.html', { root: './public' }));
app.get('/results/:id', authMiddleware, (req, res) => res.sendFile('results.html', { root: './public' }));
app.get('/create', authMiddleware, (req, res) => res.sendFile('create.html', { root: './public' }));
app.get('/logout', (req, res) => { res.clearCookie('token'); res.redirect('/login'); });
// Public viewer routes (no auth required)
app.get('/join', (req, res) => res.sendFile('join.html', { root: './public' }));
app.get('/watch/:id', (req, res) => res.sendFile('watch.html', { root: './public' }));

// ── Socket.io — Real-time bidding ────────────────────────────────────────────
// auctionId → { currentPlayer, currentBid, currentBidder, reshuffleCount }
const auctionRooms = {};

// Helper: count players owned by each team in an auction
function getTeamPlayerCounts(auctionId, db) {
  const rows = db.prepare(`
    SELECT sold_to_team_id AS team_id, COUNT(*) AS count
    FROM players
    WHERE auction_id = ? AND status IN ('sold','retained')
    GROUP BY sold_to_team_id
  `).all(auctionId);
  const map = {};
  rows.forEach(r => { map[r.team_id] = r.count; });
  return map;
}

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Join auction room
  socket.on('join_auction', ({ auctionId }) => {
    socket.join(`auction_${auctionId}`);
    const db = getDB();
    const auction = db.prepare('SELECT * FROM auctions WHERE id=?').get(auctionId);
    const teams   = db.prepare('SELECT * FROM teams WHERE auction_id=? ORDER BY id').all(auctionId);
    const pending = db.prepare("SELECT * FROM players WHERE auction_id=? AND status='pending' ORDER BY RANDOM()").all(auctionId);
    const sold    = db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='sold'").get(auctionId).c;
    const unsold  = db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='unsold'").get(auctionId).c;

    const playerCounts = getTeamPlayerCounts(auctionId, db);

    // Fetch sold/retained players for viewer team rosters
    const soldPlayers = db.prepare(
      `SELECT p.*, t.name AS team_name FROM players p
       JOIN teams t ON t.id = p.sold_to_team_id
       WHERE p.auction_id = ? AND p.status IN ('sold','retained')
       ORDER BY p.id`
    ).all(auctionId);

    socket.emit('auction_state', {
      teams,
      auction,
      playerCounts,
      pending_count: pending.length,
      sold_count: sold,
      unsold_count: unsold,
      room: auctionRooms[auctionId] || null,
      soldPlayers,
    });
    console.log(`📺 Joined auction room ${auctionId}`);
  });

  // Start / next player
  socket.on('next_player', ({ auctionId }) => {
    const db = getDB();
    const auction = db.prepare('SELECT * FROM auctions WHERE id=?').get(auctionId);
    const maxPlayers = auction ? (auction.max_players_per_team || 11) : 11;

    const player = db.prepare("SELECT * FROM players WHERE auction_id=? AND status='pending' ORDER BY RANDOM() LIMIT 1").get(auctionId);

    if (!player) {
      // --- No pending players ---
      const unsoldCount = db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='unsold'").get(auctionId).c;

      if (unsoldCount > 0) {
        // Increment reshuffle counter
        if (!auctionRooms[auctionId]) auctionRooms[auctionId] = { reshuffleCount: 0 };
        auctionRooms[auctionId].reshuffleCount = (auctionRooms[auctionId].reshuffleCount || 0) + 1;
        const reshuffleCount = auctionRooms[auctionId].reshuffleCount;

        if (reshuffleCount >= 2) {
          // ── AUTO-ASSIGN after 2+ reshuffles ──────────────────────────────
          const unsoldPlayers = db.prepare("SELECT * FROM players WHERE auction_id=? AND status='unsold'").all(auctionId);
          const allTeams      = db.prepare('SELECT * FROM teams WHERE auction_id=? ORDER BY id').all(auctionId);
          const playerCounts  = getTeamPlayerCounts(auctionId, db);

          // Teams that still need players (under quota)
          const needyTeams = allTeams.filter(t => (playerCounts[t.id] || 0) < maxPlayers);

          const assignments = [];

          if (needyTeams.length > 0) {
            unsoldPlayers.forEach((p, idx) => {
              const target = needyTeams[idx % needyTeams.length];
              // Assign for free (₹0) — team has no budget obligation in auto-assign
              db.prepare("UPDATE players SET status='sold', sold_to_team_id=?, sold_price=0 WHERE id=?")
                .run(target.id, p.id);
              logEvent(auctionId, 'AUTO_ASSIGN', `${p.name} auto-assigned to ${target.name}`, p.id, target.id, 0);
              assignments.push({ player: p, team: target });
              // Update local count so round-robin distributes evenly
              playerCounts[target.id] = (playerCounts[target.id] || 0) + 1;
            });
          } else {
            // All teams full — just mark remaining unsold as truly unsold (leave them)
            console.log('All teams full, cannot auto-assign remaining unsold players.');
          }

          io.to(`auction_${auctionId}`).emit('auto_assign', { assignments });

          // Mark auction complete
          db.prepare("UPDATE auctions SET status='completed', completed_at=datetime('now','localtime') WHERE id=?").run(auctionId);
          logEvent(auctionId, 'AUCTION_COMPLETE', 'Auction completed (with auto-assign)');
          io.to(`auction_${auctionId}`).emit('auction_complete', getAuctionStats(auctionId, db));

        } else {
          // Normal reshuffle (first time)
          db.prepare("UPDATE players SET status='pending' WHERE auction_id=? AND status='unsold'").run(auctionId);
          logEvent(auctionId, 'RESHUFFLE', `${unsoldCount} unsold players reshuffled (round ${reshuffleCount})`);
          io.to(`auction_${auctionId}`).emit('reshuffle', { count: unsoldCount, reshuffleCount });

          const reshuffled = db.prepare("SELECT * FROM players WHERE auction_id=? AND status='pending' ORDER BY RANDOM() LIMIT 1").get(auctionId);
          if (reshuffled) sendPlayer(auctionId, reshuffled, db);
          else io.to(`auction_${auctionId}`).emit('auction_complete', getAuctionStats(auctionId, db));
        }
      } else {
        // No unsold either — auction is done
        io.to(`auction_${auctionId}`).emit('auction_complete', getAuctionStats(auctionId, db));
        db.prepare("UPDATE auctions SET status='completed', completed_at=datetime('now','localtime') WHERE id=?").run(auctionId);
        logEvent(auctionId, 'AUCTION_COMPLETE', 'Auction completed');
      }
      return;
    }

    sendPlayer(auctionId, player, db);
  });

  function sendPlayer(auctionId, player, db) {
    if (!auctionRooms[auctionId]) auctionRooms[auctionId] = { reshuffleCount: 0 };
    auctionRooms[auctionId] = {
      ...auctionRooms[auctionId],
      currentPlayer: player,
      currentBid: player.base_price,
      currentBidder: null,
      started: true,
    };
    db.prepare("UPDATE auctions SET current_player_id=? WHERE id=?").run(player.id, auctionId);
    io.to(`auction_${auctionId}`).emit('player_up', { player, base_price: player.base_price });
  }

  // Place bid
  socket.on('place_bid', ({ auctionId, teamId, bidAmount }) => {
    const room = auctionRooms[auctionId];
    if (!room) return;

    const db = getDB();
    const team = db.prepare('SELECT * FROM teams WHERE id=?').get(teamId);
    if (!team) return;

    const auction    = db.prepare('SELECT * FROM auctions WHERE id=?').get(auctionId);
    const maxPlayers = auction ? (auction.max_players_per_team || 11) : 11;

    // Guard 1: Team purse check
    const remaining = team.purse - team.spent;
    if (remaining < bidAmount) {
      socket.emit('bid_error', { error: 'Insufficient purse' });
      return;
    }

    // Guard 2: Full squad check
    const playerCounts = getTeamPlayerCounts(auctionId, db);
    const ownedCount   = playerCounts[teamId] || 0;
    if (ownedCount >= maxPlayers) {
      socket.emit('bid_error', { error: `Squad full (${maxPlayers}/${maxPlayers} players)` });
      return;
    }

    // Record bid
    db.prepare('INSERT INTO bids (auction_id, player_id, team_id, bid_amount) VALUES (?,?,?,?)')
      .run(auctionId, room.currentPlayer.id, teamId, bidAmount);

    room.currentBid    = bidAmount;
    room.currentBidder = teamId;

    io.to(`auction_${auctionId}`).emit('bid_placed', {
      teamId,
      teamName: team.name,
      bidAmount,
      player: room.currentPlayer,
    });
  });

  // Confirm sold
  socket.on('confirm_sold', ({ auctionId }) => {
    const room = auctionRooms[auctionId];
    if (!room || !room.currentBidder) return;

    const db = getDB();
    const { currentPlayer, currentBid, currentBidder } = room;
    const team = db.prepare('SELECT * FROM teams WHERE id=?').get(currentBidder);

    db.prepare("UPDATE players SET status='sold', sold_to_team_id=?, sold_price=? WHERE id=?")
      .run(currentBidder, currentBid, currentPlayer.id);
    db.prepare('UPDATE teams SET spent=spent+? WHERE id=?').run(currentBid, currentBidder);
    db.prepare('UPDATE bids SET is_winning=1 WHERE player_id=? AND team_id=? ORDER BY id DESC LIMIT 1')
      .run(currentPlayer.id, currentBidder);

    logEvent(auctionId, 'PLAYER_SOLD', `${currentPlayer.name} → ${team?.name} ₹${currentBid}Cr`, currentPlayer.id, currentBidder, currentBid);

    const updatedPlayerCounts = getTeamPlayerCounts(auctionId, db);

    io.to(`auction_${auctionId}`).emit('player_sold', {
      player: currentPlayer,
      team,
      price: currentBid,
      sold_count: db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='sold'").get(auctionId).c,
      playerCounts: updatedPlayerCounts,
    });

    auctionRooms[auctionId] = { ...room, currentPlayer: null, currentBid: 0, currentBidder: null };
  });

  // Mark unsold
  socket.on('mark_unsold', ({ auctionId }) => {
    const room = auctionRooms[auctionId];
    if (!room?.currentPlayer) return;

    const db = getDB();
    db.prepare("UPDATE players SET status='unsold' WHERE id=?").run(room.currentPlayer.id);
    logEvent(auctionId, 'PLAYER_UNSOLD', `${room.currentPlayer.name} went unsold`, room.currentPlayer.id);

    io.to(`auction_${auctionId}`).emit('player_unsold', {
      player: room.currentPlayer,
      unsold_count: db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='unsold'").get(auctionId).c,
    });

    auctionRooms[auctionId] = { ...room, currentPlayer: null, currentBid: 0, currentBidder: null };
  });

  // Reset bid
  socket.on('reset_bid', ({ auctionId }) => {
    const room = auctionRooms[auctionId];
    if (!room?.currentPlayer) return;
    room.currentBid    = room.currentPlayer.base_price;
    room.currentBidder = null;
    io.to(`auction_${auctionId}`).emit('bid_reset', { base_price: room.currentPlayer.base_price });
  });

  socket.on('disconnect', () => console.log('🔌 Disconnected:', socket.id));
});

function getAuctionStats(auctionId, db) {
  return {
    sold:   db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='sold'").get(auctionId).c,
    unsold: db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='unsold'").get(auctionId).c,
    spent:  db.prepare('SELECT SUM(spent) AS s FROM teams WHERE auction_id=?').get(auctionId).s || 0,
  };
}

// ── Boot ─────────────────────────────────────────────────────────────────────
getDB(); // Initialize DB on startup
server.listen(PORT, () => {
  console.log(`\n🏏 IPL Auction Server running at http://localhost:${PORT}`);
  console.log(`📦 Database: ${path.join(__dirname, 'auction.db')}`);
  console.log(`🗂️  Uploads:  ${path.join(__dirname, 'public/uploads')}\n`);
});
