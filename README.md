# 🏏 IPL MEGA AUCTION — Full Stack App

Real-time cricket auction platform with **external SQLite database**, CSV player import, JWT auth, Socket.io live bidding.

## 📁 PROJECT STRUCTURE

```
ipl-auction/
├── server.js                  ← Express + Socket.io entry point
├── package.json               ← Dependencies
├── auction.db                 ← SQLite DB file (auto-created on first run)
├── db/
│   └── database.js            ← Schema + DB connection (better-sqlite3)
├── middleware/
│   ├── auth.js                ← JWT auth middleware
│   └── upload.js              ← Multer config (images + CSV)
├── routes/
│   ├── auth.js                ← /api/auth/login|register|logout|me
│   └── auction.js             ← All auction, team, player, bid routes
└── public/
    ├── login.html
    ├── dashboard.html
    ├── create.html            ← Create wizard + CSV import
    ├── auction.html           ← Live bidding (Socket.io)
    ├── results.html
    ├── sample_players.csv     ← Sample CSV for testing
    └── css/main.css
```

## ⚡ QUICK START

### 1. Install Node.js v18+
Download from https://nodejs.org

### 2. Install dependencies
```bash
cd ipl-auction
npm install
```

### 3. Start the server
```bash
npm start
# development with auto-reload:
npm run dev
```

### 4. Open browser
```
http://localhost:3000
```

SQLite database file `auction.db` is **auto-created** in the project root on first run.

---

## 🗄️ DATABASE — auction.db (SQLite)

Open with any SQLite tool:
- **DB Browser for SQLite** (free): https://sqlitebrowser.org
- **DBeaver** (free): https://dbeaver.io
- **TablePlus**: https://tableplus.com
- **CLI**: `sqlite3 auction.db`

### Tables

| Table            | Key Columns |
|------------------|-------------|
| users            | id, name, email, phone, password, created_at, last_login |
| auctions         | id, user_id, name, season, purse_per_team, bid_increment, status |
| teams            | id, auction_id, name, logo_path, captain, retained_player, purse, spent |
| players          | id, auction_id, name, role, age, base_price, photo_path, status, sold_to_team_id, sold_price, source |
| bids             | id, auction_id, player_id, team_id, bid_amount, is_winning, bid_time |
| auction_history  | id, auction_id, event_type, description, player_id, team_id, amount |

### Useful SQL queries
```sql
-- All players with their team
SELECT p.name, p.role, p.sold_price, t.name AS team
FROM players p LEFT JOIN teams t ON p.sold_to_team_id = t.id
WHERE p.auction_id = 1 ORDER BY p.sold_price DESC;

-- Team spending summary
SELECT t.name, t.purse, t.spent, COUNT(p.id) AS players
FROM teams t LEFT JOIN players p ON p.sold_to_team_id = t.id
WHERE t.auction_id = 1 GROUP BY t.id;

-- Full bid history
SELECT b.bid_amount, p.name AS player, t.name AS team, b.bid_time
FROM bids b JOIN players p ON b.player_id=p.id JOIN teams t ON b.team_id=t.id
WHERE b.auction_id=1 ORDER BY b.id DESC;
```

---

## 📥 CSV PLAYER IMPORT

### Format (first row = header)
```csv
name,role,age,base_price,nationality,image_filename
Virat Kohli,Batsman,35,20,Indian,virat.jpg
Jasprit Bumrah,Bowler,30,15,Indian,bumrah.png
AB de Villiers,All-Rounder,38,8,South African,
```

### Steps
1. Create Auction → Step 3 Players → click **📥 IMPORT CSV**
2. Upload your `.csv` file
3. Optionally upload matching image files (names must match `image_filename` column)
4. Click **IMPORT PLAYERS** — saved to SQLite instantly

---

## 🔴 LIVE AUCTION FLOW

1. Register / Login
2. Create Auction → Set up teams → Add players (manually or CSV)
3. Click START AUCTION
4. Players appear randomly, 30-second countdown per player
5. Click BID buttons for each team
6. SOLD / UNSOLD / RESET controls
7. Unsold players auto-reshuffled at end
8. Results page shows all squads + event history log

---

## 🔐 API ROUTES

```
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout

GET    /api/auctions
POST   /api/auctions
GET    /api/auctions/:id
PATCH  /api/auctions/:id/status
DELETE /api/auctions/:id
GET    /api/auctions/:id/results
GET    /api/auctions/:id/history
GET    /api/auctions/:id/bids

POST   /api/auctions/:id/teams        (multipart: logo image)
DELETE /api/teams/:id

POST   /api/auctions/:id/players      (multipart: photo)
POST   /api/auctions/:id/players/csv  (multipart: csv + images[])
DELETE /api/players/:id
```

---

## 📦 DEPENDENCIES

```
express         — web server
better-sqlite3  — SQLite database (external file auction.db)
bcryptjs        — password hashing
jsonwebtoken    — JWT authentication
multer          — file uploads (images + CSV)
csv-parse       — CSV parsing
socket.io       — real-time live bidding
```
