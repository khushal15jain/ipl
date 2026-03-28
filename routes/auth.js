const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('../db/database');
const { generateToken } = require('../middleware/auth');

// GET /login
router.get('/login', (req, res) => {
  if (req.cookies?.token) return res.redirect('/dashboard');
  res.sendFile('login.html', { root: './public' });
});

// POST /api/auth/register
router.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password)
      return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existingResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingResult.rows.length > 0)
      return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'INSERT INTO users (name, email, phone, password) VALUES ($1, $2, $3, $4)',
      [name, email, phone, hash]
    );

    res.json({ success: true, message: 'Account created! Please login.' });
  } catch (err) {
    console.error('❌ Registration error:', err);
    res.status(500).json({ error: 'Registration failed', details: err.message, stack: err.stack });
  }
});

// POST /api/auth/login
router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = userResult.rows[0];
    
    if (!user)
      return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ error: 'Invalid email or password' });

    // Update last_login
    await pool.query('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    
    const token = generateToken(user);
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: 'Login failed', details: err.message, stack: err.stack });
  }
});

// POST /api/auth/logout
router.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/api/auth/me', (req, res) => {
  const jwt = require('jsonwebtoken');
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET || 'ipl_auction_super_secret_2025');
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
