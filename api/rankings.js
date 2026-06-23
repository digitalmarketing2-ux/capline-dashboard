const https = require('https');
const crypto = require('crypto');

const SITE_URL = 'https://www.caplinehealthcaremanagement.com/';

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getToken(creds) {
  var now = Math.floor(Date.now() / 1000);
  var header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  var sig = sign.sign(creds.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  var jwt = header + '.' + claim + '.' + sig;
  var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        var j = JSON.parse(d);
        if (j.error) reject(new Error(j.error_description || j.error));
        else resolve(j.access_token);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function apiPost(hostname, path, token, payload) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var req = https.request({
      hostname: hostname,
      path: path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Bad JSON: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getWeeks(startDate, endDate) {
  var weeks = [];
  var current = new Date(startDate + 'T00:00:00Z');
  var end = new Date(endDate + 'T00:00:00Z');
  while (current <= end && weeks.length < 12) {
    var weekEnd = new Date(current);
    weekEnd.setDate(weekEnd.getDate() + 6);
    if (weekEnd > end) weekEnd.setTime(end.getTime());
    var s = current.toISOString().split('T')[0];
    var e = weekEnd.toISOString().split('T')[0];
    var label = new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      + ' - ' + new Date(e + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    weeks.push({ start: s, end: e, label: label });
    current.setDate(current.getDate() + 7);
  }
  return weeks;
}

async function fetchWeek(token, week) {
  try {
    var siteEncoded = encodeURIComponent(SITE_URL);
    var data = await apiPost(
      'searchconsole.googleapis.com',
      '/webmasters/v3/sites/' + siteEncoded + '/searchAnalytics/query',
      token,
      { startDate: week.start, endDate: week.end, dimensions: ['query'], rowLimit: 25000 }
    );
    var out = {};
    var rows = data.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      out[row.keys[0].toLowerCase()] = {
        position: Math.round((row.position || 0) * 10) / 10,
        impressions: row.impressions || 0,
        clicks: row.clicks || 0,
      };
    }
    return out;
  } catch (e) {
    console.error('Week fetch error', week.start, e.message);
    return {};
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var startDate = req.query.startDate;
  var endDate = req.query.endDate;
  if (!startDate || !endDate)
    return res.status(400).json({ error: 'startDate and endDate required' });

  try {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    var token = await getToken(creds);
    var weeks = getWeeks(startDate, endDate);
    var weekData = [];
    for (var i = 0; i < weeks.length; i++) {
      weekData.push(await fetchWeek(token, weeks[i]));
    }
    res.json({ weeks: weeks, data: weekData });
  } catch (err) {
    console.error('Handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
};