require('dotenv').config();
const express    = require('express');
const http       = require('http');
const path = require("path");
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const { pool, logEvent, getDB } = require('./db/database');
const { authMiddleware } = require('./middleware/auth');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.get('/logout', (req, res) => { res.clearCookie('token'); res.redirect('/login'); });

// Public viewer routes (no auth required)
app.get('/join', (req, res) => res.sendFile('join.html', { root: './public' }));
app.get('/watch/:id', (req, res) => res.sendFile('watch.html', { root: './public' }));
app.get('/audience/:id', (req, res) => res.sendFile('audience.html', { root: './public' }));
app.get('/results/:id', (req, res) => res.sendFile('results.html', { root: './public' }));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/auction'));

// Page routes
app.get('/', (req, res) => res.redirect('/login'));
app.get('/dashboard', authMiddleware, (req, res) => res.sendFile('dashboard.html', { root: './public' }));
app.get('/auction/:id', authMiddleware, (req, res) => res.sendFile('auction.html', { root: './public' }));
app.get('/create', authMiddleware, (req, res) => res.sendFile('create.html', { root: './public' }));

// ── Socket.io — Real-time bidding ────────────────────────────────────────────
// auctionId → { currentPlayer, currentBid, currentBidder, reshuffleCount }
const auctionRooms = {};

// Helper: count players owned by each team in an auction
async function getTeamPlayerCounts(auctionId) {
  const result = await pool.query(`
    SELECT sold_to_team_id AS team_id, COUNT(*) AS count
    FROM players
    WHERE auction_id = $1 AND status IN ('sold','retained')
    GROUP BY sold_to_team_id
  `, [auctionId]);
  const map = {};
  result.rows.forEach(r => { map[r.team_id] = parseInt(r.count); });
  return map;
}

io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Join auction room
  socket.on('join_auction', async ({ auctionId, teamId }) => {
    try {
      const auctionRes = await pool.query('SELECT * FROM auctions WHERE id=$1', [auctionId]);
      const auction = auctionRes.rows[0];
      if (!auction) return socket.emit('error', { message: 'Auction not found' });

      // Validate team belongs to auction if teamId is provided
      if (teamId) {
        const teamRes = await pool.query('SELECT id FROM teams WHERE id=$1 AND auction_id=$2', [teamId, auctionId]);
        if (teamRes.rowCount === 0) return socket.emit('error', { message: 'Invalid team for this auction' });
        socket.joinedTeamId = teamId;
      }

      socket.join(`auction_${auctionId}`);
      
      const teamsRes = await pool.query('SELECT * FROM teams WHERE auction_id=$1 ORDER BY id', [auctionId]);
      const pendingRes = await pool.query("SELECT * FROM players WHERE auction_id=$1 AND status='pending'", [auctionId]);
      const soldRes = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='sold'", [auctionId]);
      const unsoldRes = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='unsold'", [auctionId]);

      const playerCounts = await getTeamPlayerCounts(auctionId);

      // Fetch sold/retained players for viewer team rosters
      const soldPlayersRes = await pool.query(
        `SELECT p.*, t.name AS team_name FROM players p
         JOIN teams t ON t.id = p.sold_to_team_id
         WHERE p.auction_id = $1 AND p.status IN ('sold','retained')
         ORDER BY p.id`,
        [auctionId]
      );

      socket.emit('auction_state', {
        teams: teamsRes.rows,
        auction,
        playerCounts,
        pending_count: pendingRes.rowCount,
        sold_count: parseInt(soldRes.rows[0].c),
        unsold_count: parseInt(unsoldRes.rows[0].c),
        room: auctionRooms[auctionId] || { started: false, currentPlayer: null },
        soldPlayers: soldPlayersRes.rows,
      });

      console.log(`📺 Auction ${auctionId} Sync: ${teamsRes.rowCount} teams, ${pendingRes.rowCount} pending players.`);
      if (teamId) console.log(`👉 Joined as Team: ${teamId}`);
      else console.log(`👀 Joined as Spectator`);

    } catch (err) {
      console.error('❌ Socket Join Error:', err);
      socket.emit('error', { message: 'Database error while joining auction' });
    }
  });

  // Start / next player
  socket.on('next_player', async ({ auctionId }) => {
    try {
      const auctionRes = await pool.query('SELECT * FROM auctions WHERE id=$1', [auctionId]);
      const auction = auctionRes.rows[0];
      const maxPlayers = auction ? (auction.max_players_per_team || 11) : 11;

      const playerRes = await pool.query("SELECT * FROM players WHERE auction_id=$1 AND status='pending' ORDER BY RANDOM() LIMIT 1", [auctionId]);
      const player = playerRes.rows[0];

      if (!player) {
        // --- No pending players ---
        const unsoldCountRes = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='unsold'", [auctionId]);
        const unsoldCount = parseInt(unsoldCountRes.rows[0].c);

        if (unsoldCount > 0) {
          if (!auctionRooms[auctionId]) auctionRooms[auctionId] = { reshuffleCount: 0 };
          auctionRooms[auctionId].reshuffleCount = (auctionRooms[auctionId].reshuffleCount || 0) + 1;
          const reshuffleCount = auctionRooms[auctionId].reshuffleCount;

          if (reshuffleCount >= 2) {
            // ── AUTO-ASSIGN after 2+ reshuffles ──────────────────────────────
            const unsoldPlayersRes = await pool.query("SELECT * FROM players WHERE auction_id=$1 AND status='unsold'", [auctionId]);
            const unsoldPlayers = unsoldPlayersRes.rows;
            
            const allTeamsRes = await pool.query('SELECT * FROM teams WHERE auction_id=$1 ORDER BY id', [auctionId]);
            const allTeams = allTeamsRes.rows;
            
            const playerCounts = await getTeamPlayerCounts(auctionId);

            const needyTeams = allTeams.filter(t => (playerCounts[t.id] || 0) < maxPlayers);
            const assignments = [];

            if (needyTeams.length > 0) {
              for (let i = 0; i < unsoldPlayers.length; i++) {
                const p = unsoldPlayers[i];
                const target = needyTeams[i % needyTeams.length];
                await pool.query("UPDATE players SET status='sold', sold_to_team_id=$1, sold_price=0 WHERE id=$2", [target.id, p.id]);
                await logEvent(auctionId, 'AUTO_ASSIGN', `${p.name} auto-assigned to ${target.name}`, p.id, target.id, 0);
                assignments.push({ player: p, team: target });
                playerCounts[target.id] = (playerCounts[target.id] || 0) + 1;
              }
            }

            io.to(`auction_${auctionId}`).emit('auto_assign', { assignments });
            await pool.query("UPDATE auctions SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=$1", [auctionId]);
            await logEvent(auctionId, 'AUCTION_COMPLETE', 'Auction completed (with auto-assign)');
            const stats = await getAuctionStats(auctionId);
            io.to(`auction_${auctionId}`).emit('auction_complete', stats);

          } else {
            // Normal reshuffle
            await pool.query("UPDATE players SET status='pending' WHERE auction_id=$1 AND status='unsold'", [auctionId]);
            await logEvent(auctionId, 'RESHUFFLE', `${unsoldCount} unsold players reshuffled (round ${reshuffleCount})`);
            io.to(`auction_${auctionId}`).emit('reshuffle', { count: unsoldCount, reshuffleCount });

            const reshuffledRes = await pool.query("SELECT * FROM players WHERE auction_id=$1 AND status='pending' ORDER BY RANDOM() LIMIT 1", [auctionId]);
            if (reshuffledRes.rowCount > 0) await sendPlayer(auctionId, reshuffledRes.rows[0]);
            else io.to(`auction_${auctionId}`).emit('auction_complete', await getAuctionStats(auctionId));
          }
        } else {
          // Complete
          io.to(`auction_${auctionId}`).emit('auction_complete', await getAuctionStats(auctionId));
          await pool.query("UPDATE auctions SET status='completed', completed_at=CURRENT_TIMESTAMP WHERE id=$1", [auctionId]);
          await logEvent(auctionId, 'AUCTION_COMPLETE', 'Auction completed');
        }
        return;
      }

      await sendPlayer(auctionId, player);
    } catch (err) { console.error(err); }
  });

  async function sendPlayer(auctionId, player) {
    if (!auctionRooms[auctionId]) auctionRooms[auctionId] = { reshuffleCount: 0 };
    auctionRooms[auctionId] = {
      ...auctionRooms[auctionId],
      currentPlayer: player,
      currentBid: parseFloat(player.base_price),
      currentBidder: null,
      started: true,
    };
    await pool.query("UPDATE auctions SET current_player_id=$1 WHERE id=$2", [player.id, auctionId]);
    io.to(`auction_${auctionId}`).emit('player_up', { player, base_price: player.base_price });
  }

  // Place bid
  socket.on('place_bid', async ({ auctionId, teamId, bidAmount }) => {
    try {
      if (socket.joinedTeamId && socket.joinedTeamId !== teamId) {
        return socket.emit('bid_error', { error: 'Unauthorized' });
      }

      const room = auctionRooms[auctionId];
      if (!room) return;

      const teamRes = await pool.query('SELECT * FROM teams WHERE id=$1 AND auction_id=$2', [teamId, auctionId]);
      const team = teamRes.rows[0];
      if (!team) return socket.emit('bid_error', { error: 'Invalid team' });

      const auctionRes = await pool.query('SELECT * FROM auctions WHERE id=$1', [auctionId]);
      const auction = auctionRes.rows[0];
      const maxPlayers = auction ? (auction.max_players_per_team || 11) : 11;

      if ((team.purse - team.spent) < bidAmount) {
        return socket.emit('bid_error', { error: 'Insufficient purse' });
      }

      const playerCounts = await getTeamPlayerCounts(auctionId);
      if ((playerCounts[teamId] || 0) >= maxPlayers) {
        return socket.emit('bid_error', { error: 'Squad full' });
      }

      await pool.query('INSERT INTO bids (auction_id, player_id, team_id, bid_amount) VALUES ($1,$2,$3,$4)',
        [auctionId, room.currentPlayer.id, teamId, bidAmount]);

      room.currentBid    = bidAmount;
      room.currentBidder = teamId;

      io.to(`auction_${auctionId}`).emit('bid_placed', {
        teamId,
        teamName: team.name,
        bidAmount,
        player: room.currentPlayer,
      });
    } catch (err) { console.error(err); }
  });

  // Confirm sold
  socket.on('confirm_sold', async ({ auctionId }) => {
    try {
      const room = auctionRooms[auctionId];
      if (!room || !room.currentBidder) return;

      const { currentPlayer, currentBid, currentBidder } = room;
      const teamRes = await pool.query('SELECT * FROM teams WHERE id=$1', [currentBidder]);
      const team = teamRes.rows[0];

      await pool.query("UPDATE players SET status='sold', sold_to_team_id=$1, sold_price=$2 WHERE id=$3",
        [currentBidder, currentBid, currentPlayer.id]);
      await pool.query('UPDATE teams SET spent=spent+$1 WHERE id=$2', [currentBid, currentBidder]);
      
      await pool.query(`
        UPDATE bids SET is_winning=1 WHERE id = (
          SELECT id FROM bids WHERE player_id=$1 AND team_id=$2 ORDER BY id DESC LIMIT 1
        )
      `, [currentPlayer.id, currentBidder]);

      await logEvent(auctionId, 'PLAYER_SOLD', `${currentPlayer.name} → ${team?.name} ₹${currentBid}Cr`, currentPlayer.id, currentBidder, currentBid);

      const updatedPlayerCounts = await getTeamPlayerCounts(auctionId);
      const soldCountRes = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='sold'", [auctionId]);

      io.to(`auction_${auctionId}`).emit('player_sold', {
        player: currentPlayer,
        team,
        price: currentBid,
        sold_count: parseInt(soldCountRes.rows[0].c),
        playerCounts: updatedPlayerCounts,
      });

      auctionRooms[auctionId] = { ...room, currentPlayer: null, currentBid: 0, currentBidder: null };
    } catch (err) { console.error(err); }
  });

  // Mark unsold
  socket.on('mark_unsold', async ({ auctionId }) => {
    try {
      const room = auctionRooms[auctionId];
      if (!room?.currentPlayer) return;

      await pool.query("UPDATE players SET status='unsold' WHERE id=$1", [room.currentPlayer.id]);
      await logEvent(auctionId, 'PLAYER_UNSOLD', `${room.currentPlayer.name} went unsold`, room.currentPlayer.id);

      const unsoldCountRes = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='unsold'", [auctionId]);
      
      io.to(`auction_${auctionId}`).emit('player_unsold', {
        player: room.currentPlayer,
        unsold_count: parseInt(unsoldCountRes.rows[0].c),
      });

      auctionRooms[auctionId] = { ...room, currentPlayer: null, currentBid: 0, currentBidder: null };
    } catch (err) { console.error(err); }
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

async function getAuctionStats(auctionId) {
  const soldRes = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='sold'", [auctionId]);
  const unsoldRes = await pool.query("SELECT COUNT(*) AS c FROM players WHERE auction_id=$1 AND status='unsold'", [auctionId]);
  const spentRes = await pool.query('SELECT SUM(spent) AS s FROM teams WHERE auction_id=$1', [auctionId]);
  
  return {
    sold:   parseInt(soldRes.rows[0].c),
    unsold: parseInt(unsoldRes.rows[0].c),
    spent:  parseFloat(spentRes.rows[0].s || 0),
  };
}

// ── Boot ─────────────────────────────────────────────────────────────────────
getDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🏏 IPL Auction Server running at http://localhost:${PORT}`);
    console.log(`🌐 PostgreSQL: connected to cloud cluster`);
    console.log(`🗂️  Uploads:  ${path.join(__dirname, 'public/uploads')}\n`);
  });
}).catch(err => {
  console.error('❌ Failed to connect to DB:', err);
});
