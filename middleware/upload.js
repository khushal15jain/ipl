const multer = require('multer');
const path = require('path');
const fs = require('fs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Team logos ──────────────────────────────────────────────────────────────
const teamStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '../public/uploads/teams');
    ensureDir(dir);
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `team_${Date.now()}${ext}`);
  }
});

const teamUpload = multer({
  storage: teamStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── Player photos ────────────────────────────────────────────────────────────
const playerPhotoStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(__dirname, '../public/uploads/players');
    ensureDir(dir);
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `player_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const playerPhotoUpload = multer({
  storage: playerPhotoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  }
});

// ── CSV + bundled player images (memory for CSV, disk for images) ────────────
const csvStorage = multer.diskStorage({
  destination(req, file, cb) {
    if (file.fieldname === 'csv') {
      const dir = path.join(__dirname, '../public/uploads/csv_temp');
      ensureDir(dir);
      cb(null, dir);
    } else {
      // player images bundled with CSV
      const dir = path.join(__dirname, '../public/uploads/players');
      ensureDir(dir);
      cb(null, dir);
    }
  },
  filename(req, file, cb) {
    if (file.fieldname === 'csv') {
      cb(null, `import_${Date.now()}.csv`);
    } else {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `player_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
    }
  }
});

const csvUpload = multer({
  storage: csvStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.fieldname === 'csv') {
      cb(null, ['.csv', '.txt'].includes(path.extname(file.originalname).toLowerCase()));
    } else {
      const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
      cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
    }
  }
});

module.exports = { teamUpload, playerPhotoUpload, csvUpload };
