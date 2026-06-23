const https = require('https');
const crypto = require('crypto');
const GA4_PROPERTY_ID = '320415425';

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function getToken(creds) {
  var now = Math.floor(Date.now() / 1000);
  var header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = b64url(JSON.stringify({ iss: creds.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header + '.' + claim);
  var sig = sign.sign(creds.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  var jwt = header + '.' + claim + '.' + sig;
  var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
  return new Promise(function(resolve, reject) {
    var req = https.request({ hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { var j = JSON.parse(d); if (j.error) reject(new Error(j.error_description)); else resolve(j.access_token); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}
function apiPost(hostname, path, token, payload) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var req = https.request({ hostname: hostname, path: path, method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Bad JSON')); } });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var startDate = req.query.startDate || '2026-05-01';
  var endDate = req.query.endDate || '2026-05-31';
  try {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    var token = await getToken(creds);

    // 1. Try businessProfileInteractions metric directly (no filter)
    var directMetric = await apiPost('analyticsdata.googleapis.com', '/v1beta/properties/' + GA4_PROPERTY_ID + ':runReport', token, {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: 'businessProfileInteractions' }]
    });

    // 2. ALL events for sessionMedium=gmb broken down by eventName
    var eventBreakdown = await apiPost('analyticsdata.googleapis.com', '/v1beta/properties/' + GA4_PROPERTY_ID + ':runReport', token, {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'sessionMedium', stringFilter: { matchType: 'EXACT', value: 'gmb', caseSensitive: false } } },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 50
    });

    // 3. Sessions + users for sessionMedium=gmb
    var sessionData = await apiPost('analyticsdata.googleapis.com', '/v1beta/properties/' + GA4_PROPERTY_ID + ':runReport', token, {
      dateRanges: [{ startDate, endDate }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'sessionMedium', stringFilter: { matchType: 'EXACT', value: 'gmb', caseSensitive: false } } }
    });

    var events = (eventBreakdown.rows || []).map(function(r) {
      return { event: r.dimensionValues[0].value, count: parseInt(r.metricValues[0].value) };
    });
    var totalEventCount = events.reduce(function(s, e) { return s + e.count; }, 0);
    var sessionRow = (sessionData.rows || [])[0];
    var mv = sessionRow ? sessionRow.metricValues : null;

    res.json({
      dateRange: { startDate, endDate },
      businessProfileInteractions_direct: (directMetric.rows || [{ metricValues: [{ value: 'N/A' }] }])[0].metricValues[0].value,
      sessionMedium_gmb: mv ? { sessions: mv[0].value, totalUsers: mv[1].value, newUsers: mv[2].value, totalEventCount: mv[3].value } : null,
      events_by_name: events,
      total_all_events: totalEventCount,
      minus_page_view_and_user_engagement: totalEventCount - (events.find(e => e.event === 'page_view') || {count:0}).count - (events.find(e => e.event === 'user_engagement') || {count:0}).count
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
