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
    iat: now, exp: now + 3600,
  }));
  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  var sig = sign.sign(creds.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  var jwt = header + '.' + claim + '.' + sig;
  var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        var j = JSON.parse(d);
        if (j.error) reject(new Error(j.error_description || j.error));
        else resolve(j.access_token);
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function apiPost(hostname, path, token, payload) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var req = https.request({
      hostname: hostname, path: path, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Bad JSON: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function fetchGscPages(token, start, end) {
  try {
    var siteEncoded = encodeURIComponent(SITE_URL);
    var data = await apiPost(
      'searchconsole.googleapis.com',
      '/webmasters/v3/sites/' + siteEncoded + '/searchAnalytics/query',
      token,
      { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 25000 }
    );
    var out = {};
    var rows = data.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var url = row.keys[0];
      var path;
      try { path = new URL(url).pathname; } catch(e) { path = url; }
      out[path] = {
        clicks: Math.round(row.clicks || 0),
        impressions: Math.round(row.impressions || 0),
        position: Math.round((row.position || 0) * 10) / 10,
        ctr: Math.round((row.ctr || 0) * 1000) / 10,
      };
    }
    return out;
  } catch (e) {
    console.error('GSC pages error:', e.message);
    return {};
  }
}

function getSuggestion(curr, prev) {
  if (!curr && prev) return 'Page lost all visibility — check if removed or deindexed in GSC.';
  if (!curr || !prev) return null;

  var suggestions = [];
  var clickDrop = prev.clicks > 0 ? (prev.clicks - curr.clicks) / prev.clicks : 0;
  var posDrop = curr.position - prev.position;
  var impDrop = prev.impressions > 0 ? (prev.impressions - curr.impressions) / prev.impressions : 0;

  if (curr.position > 20 && prev.position <= 20)
    suggestions.push('Fell off page 1 — strengthen content depth and acquire backlinks.');
  if (posDrop > 5 && prev.clicks > 5)
    suggestions.push('Position dropped by ' + posDrop.toFixed(1) + ' — refresh content, improve internal linking.');
  if (clickDrop > 0.3 && prev.clicks > 10 && posDrop <= 2)
    suggestions.push('Clicks dropped despite stable ranking — A/B test title and meta description for better CTR.');
  if (curr.ctr < 2 && curr.impressions > 500)
    suggestions.push('Low CTR (' + curr.ctr + '%) with high impressions — rewrite title and add power words.');
  if (curr.clicks === 0 && curr.impressions > 100)
    suggestions.push('Zero clicks despite ' + curr.impressions + ' impressions — add FAQ schema markup.');
  if (impDrop > 0.4 && prev.impressions > 200)
    suggestions.push('Impressions dropped ' + Math.round(impDrop * 100) + '% — check GSC for indexing issues or content relevance.');
  if (curr.position >= 11 && curr.position <= 20 && curr.impressions > 200)
    suggestions.push('Position ' + curr.position + ' — just off page 1, needs 2-3 quality backlinks to break in.');
  if (curr.ctr < prev.ctr - 1 && prev.clicks > 10)
    suggestions.push('CTR declined from ' + prev.ctr + '% to ' + curr.ctr + '% — update meta description with a stronger CTA.');

  return suggestions.length > 0 ? suggestions[0] : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  var startDate = req.query.startDate;
  var endDate = req.query.endDate;
  var prevStart = req.query.prevStart;
  var prevEnd = req.query.prevEnd;

  if (!startDate || !endDate || !prevStart || !prevEnd)
    return res.status(400).json({ error: 'startDate, endDate, prevStart, prevEnd all required' });

  try {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    var token = await getToken(creds);

    var results = await Promise.all([
      fetchGscPages(token, startDate, endDate),
      fetchGscPages(token, prevStart, prevEnd),
    ]);

    var currPages = results[0];
    var prevPages = results[1];

    var allPaths = {};
    Object.keys(currPages).forEach(function(p) { allPaths[p] = true; });
    Object.keys(prevPages).forEach(function(p) { allPaths[p] = true; });

    var rows = Object.keys(allPaths).map(function(path) {
      var c = currPages[path] || null;
      var p = prevPages[path] || null;
      return {
        page: path,
        curr: c,
        prev: p,
        clickDelta: (c && p) ? c.clicks - p.clicks : null,
        impDelta: (c && p) ? c.impressions - p.impressions : null,
        posDelta: (c && p) ? Math.round((c.position - p.position) * 10) / 10 : null,
        ctrDelta: (c && p) ? Math.round((c.ctr - p.ctr) * 10) / 10 : null,
        suggestion: getSuggestion(c, p),
      };
    });

    rows.sort(function(a, b) {
      return ((b.curr && b.curr.clicks) || 0) - ((a.curr && a.curr.clicks) || 0);
    });

    res.json({ rows: rows, total: rows.length });
  } catch (err) {
    console.error('Handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
