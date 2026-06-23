const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Auth config (set these in DigitalOcean environment variables) ---
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS || 'capline2024';
const SECRET    = process.env.SESSION_SECRET || 'changeme_random_secret';

function makeToken() {
  return crypto.createHmac('sha256', SECRET)
    .update(DASH_USER + ':' + DASH_PASS)
    .digest('hex');
}

function parseCookies(req) {
  var list = {};
  var header = req.headers.cookie;
  if (!header) return list;
  header.split(';').forEach(function(c) {
    var parts = c.split('=');
    list[parts[0].trim()] = (parts[1] || '').trim();
  });
  return list;
}

function isAuthenticated(req) {
  var cookies = parseCookies(req);
  return cookies['dash_token'] === makeToken();
}

function authMiddleware(req, res, next) {
  if (req.path === '/login' || req.path.startsWith('/api/')) return next();
  if (isAuthenticated(req)) return next();
  res.redirect('/login');
}

// --- Login routes ---
app.get('/login', function(req, res) {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', function(req, res) {
  var user = (req.body.username || '').trim();
  var pass = (req.body.password || '').trim();
  if (user === DASH_USER && pass === DASH_PASS) {
    var token = makeToken();
    res.setHeader('Set-Cookie', 'dash_token=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', function(req, res) {
  res.setHeader('Set-Cookie', 'dash_token=; Path=/; Max-Age=0');
  res.redirect('/login');
});

// --- Apply auth to all routes ---
app.use(authMiddleware);

// --- Serve static HTML files ---
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

// --- API routes ---
var apis = [
  'traffic', 'gsc-compare', 'rankings',
  'debug-sources', 'debug-gmb-metrics', 'debug-gbp',
  'accept-gbp-invite', 'service-account-email', 'debug-gbp-locations'
];

apis.forEach(function(name) {
  try {
    var handler = require('./api/' + name);
    app.all('/api/' + name, function(req, res) { handler(req, res); });
  } catch(e) {
    console.warn('Could not load handler:', name, e.message);
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Capline Dashboard running on port ' + PORT);
});
