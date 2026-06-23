const https = require('https');
const crypto = require('crypto');

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getToken(creds, scope) {
  var now = Math.floor(Date.now() / 1000);
  var header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = b64url(JSON.stringify({ iss: creds.client_email, scope: scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  var sig = sign.sign(creds.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  var jwt = header + '.' + claim + '.' + sig;
  var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
  return new Promise(function(resolve, reject) {
    var req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { var j = JSON.parse(d); if (j.error) reject(new Error(j.error_description || j.error)); else resolve(j.access_token); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function apiGet(hostname, path, token) {
  return new Promise(function(resolve, reject) {
    var req = https.request({ hostname: hostname, path: path, method: 'GET', headers: { 'Authorization': 'Bearer ' + token } }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d.slice(0, 500) }); } });
    });
    req.on('error', reject); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    var token = await getToken(creds, 'https://www.googleapis.com/auth/business.manage');

    // Try listing accounts via mybusiness API
    var accounts = await apiGet('mybusinessaccountmanagement.googleapis.com', '/v1/accounts', token);

    // Also try the older mybusiness API
    var accountsV4 = await apiGet('mybusiness.googleapis.com', '/v4/accounts', token);

    res.json({ accounts_v1: accounts, accounts_v4: accountsV4 });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
