require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path       = require('path');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { getDB, logEvent } = require('./db/database');
const { authMiddleware } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

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

// ── Socket.io — Real-time bidding ────────────────────────────────────────────
const auctionRooms = {}; // auctionId → { currentPlayer, currentBid, currentBidder, countdown }

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Join auction room
  socket.on('join_auction', ({ auctionId }) => {
    socket.join(`auction_${auctionId}`);
    const db = getDB();
    const teams   = db.prepare('SELECT * FROM teams WHERE auction_id=?').all(auctionId);
    const pending = db.prepare("SELECT * FROM players WHERE auction_id=? AND status='pending' ORDER BY RANDOM()").all(auctionId);
    const sold    = db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='sold'").get(auctionId).c;
    const unsold  = db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='unsold'").get(auctionId).c;

    socket.emit('auction_state', {
      teams,
      pending_count: pending.length,
      sold_count: sold,
      unsold_count: unsold,
      room: auctionRooms[auctionId] || null
    });
    console.log(`📺 Joined auction room ${auctionId}`);
  });

  // Start / next player
  socket.on('next_player', ({ auctionId }) => {
    const db = getDB();
    const player = db.prepare("SELECT * FROM players WHERE auction_id=? AND status='pending' ORDER BY RANDOM() LIMIT 1").get(auctionId);

    if (!player) {
      // Check unsold
      const unsoldCount = db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='unsold'").get(auctionId).c;
      if (unsoldCount > 0) {
        db.prepare("UPDATE players SET status='pending' WHERE auction_id=? AND status='unsold'").run(auctionId);
        logEvent(auctionId, 'RESHUFFLE', `${unsoldCount} unsold players reshuffled`);
        io.to(`auction_${auctionId}`).emit('reshuffle', { count: unsoldCount });

        // Get a player from reshuffled pool
        const reshuffled = db.prepare("SELECT * FROM players WHERE auction_id=? AND status='pending' ORDER BY RANDOM() LIMIT 1").get(auctionId);
        if (reshuffled) sendPlayer(auctionId, reshuffled, db);
        else io.to(`auction_${auctionId}`).emit('auction_complete', getAuctionStats(auctionId, db));
      } else {
        io.to(`auction_${auctionId}`).emit('auction_complete', getAuctionStats(auctionId, db));
        db.prepare("UPDATE auctions SET status='completed', completed_at=datetime('now','localtime') WHERE id=?").run(auctionId);
        logEvent(auctionId, 'AUCTION_COMPLETE', 'Auction completed');
      }
      return;
    }
    sendPlayer(auctionId, player, db);
  });

  function sendPlayer(auctionId, player, db) {
    auctionRooms[auctionId] = {
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

    const remaining = team.purse - team.spent;
    if (remaining < bidAmount) {
      socket.emit('bid_error', { error: 'Insufficient purse' });
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

    io.to(`auction_${auctionId}`).emit('player_sold', {
      player: currentPlayer,
      team,
      price: currentBid,
      sold_count: db.prepare("SELECT COUNT(*) AS c FROM players WHERE auction_id=? AND status='sold'").get(auctionId).c,
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
