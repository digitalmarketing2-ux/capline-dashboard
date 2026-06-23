const https = require('https');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const SITE_URL = 'https://www.caplinehealthcaremanagement.com/';
const GA4_PROPERTY_ID = '320415425';

// Load manual GMB data from config file (exact numbers from GA4 Business Profile report)
var gmbDataPath = path.join(__dirname, '..', 'gmb-data.json');
var gmbManualData = {};
try { gmbManualData = JSON.parse(fs.readFileSync(gmbDataPath, 'utf8')); } catch(e) {}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getToken(creds) {
  var now = Math.floor(Date.now() / 1000);
  var header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly',
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

function apiGet(hostname, path, token) {
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: hostname, path: path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token },
    }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Bad JSON: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject); req.end();
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

function getMonths(startDate, endDate) {
  var months = [];
  var current = new Date(startDate + 'T00:00:00Z');
  var end = new Date(endDate + 'T00:00:00Z');
  while (current <= end && months.length < 24) {
    var year = current.getUTCFullYear();
    var month = current.getUTCMonth();
    var monthStart = new Date(Date.UTC(year, month, 1));
    var monthEnd = new Date(Date.UTC(year, month + 1, 0));
    var clampedEnd = monthEnd > end ? end : monthEnd;
    var shortLabel = monthStart.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) +
      ' ' + String(year).slice(2);
    months.push({
      start: monthStart.toISOString().split('T')[0],
      end: clampedEnd.toISOString().split('T')[0],
      label: shortLabel,
      partial: clampedEnd < monthEnd,
    });
    current = new Date(Date.UTC(year, month + 1, 1));
  }
  return months.reverse();
}

async function fetchGscTotals(token, month) {
  try {
    var siteEncoded = encodeURIComponent(SITE_URL);
    var data = await apiPost(
      'searchconsole.googleapis.com',
      '/webmasters/v3/sites/' + siteEncoded + '/searchAnalytics/query',
      token,
      { startDate: month.start, endDate: month.end, rowLimit: 1 }
    );
    var row = (data.rows || [])[0] || {};
    return {
      clicks: Math.round(row.clicks || 0),
      impressions: Math.round(row.impressions || 0),
      position: Math.round((row.position || 0) * 10) / 10,
      ctr: Math.round((row.ctr || 0) * 1000) / 10,
    };
  } catch (e) {
    console.error('GSC error', month.start, e.message);
    return { clicks: 0, impressions: 0, position: 0, ctr: 0 };
  }
}

async function fetchGa4Totals(token, month) {
  try {
    var data = await apiPost(
      'analyticsdata.googleapis.com',
      '/v1beta/properties/' + GA4_PROPERTY_ID + ':runReport',
      token,
      {
        dateRanges: [{ startDate: month.start, endDate: month.end }],
        metrics: [
          { name: 'totalUsers' },
          { name: 'newUsers' },
          { name: 'keyEvents' },
          { name: 'averageSessionDuration' },
          { name: 'bounceRate' },
          { name: 'sessions' },
        ],
      }
    );
    var row = (data.rows || [])[0];
    if (!row) return { users: 0, newUsers: 0, returningUsers: 0, keyEvents: 0, avgDuration: 0, bounceRate: 0, sessions: 0 };
    var mv = row.metricValues;
    var users = Math.round(parseFloat(mv[0].value));
    var newU = Math.round(parseFloat(mv[1].value));
    return {
      users: users,
      newUsers: newU,
      returningUsers: Math.max(0, users - newU),
      keyEvents: Math.round(parseFloat(mv[2].value)),
      avgDuration: Math.round(parseFloat(mv[3].value)),
      bounceRate: Math.round(parseFloat(mv[4].value) * 1000) / 10,
      sessions: Math.round(parseFloat(mv[5].value)),
    };
  } catch (e) {
    console.error('GA4 error', month.start, e.message);
    return { users: 0, newUsers: 0, returningUsers: 0, keyEvents: 0, avgDuration: 0, bounceRate: 0, sessions: 0 };
  }
}

async function fetchGa4ReturningUsers(token, month) {
  try {
    var data = await apiPost(
      'analyticsdata.googleapis.com',
      '/v1beta/properties/' + GA4_PROPERTY_ID + ':runReport',
      token,
      {
        dateRanges: [{ startDate: month.start, endDate: month.end }],
        dimensions: [{ name: 'newVsReturning' }],
        metrics: [{ name: 'totalUsers' }],
      }
    );
    var rows = data.rows || [];
    var ret = rows.find(function(r) { return r.dimensionValues[0].value === 'returning'; });
    return ret ? Math.round(parseFloat(ret.metricValues[0].value)) : 0;
  } catch(e) {
    return 0;
  }
}

async function fetchGa4Channels(token, month) {
  try {
    var data = await apiPost(
      'analyticsdata.googleapis.com',
      '/v1beta/properties/' + GA4_PROPERTY_ID + ':runReport',
      token,
      {
        dateRanges: [{ startDate: month.start, endDate: month.end }],
        dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
        metrics: [{ name: 'sessions' }],
        limit: 100,
      }
    );
    var organic = 0, direct = 0, social = 0, referral = 0;
    var rows = data.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var ch = (rows[i].dimensionValues[0].value || '').toLowerCase();
      var s = Math.round(parseFloat(rows[i].metricValues[0].value));
      if (ch === 'organic search') organic += s;
      else if (ch === 'direct') direct += s;
      else if (ch.indexOf('social') >= 0) social += s;
      else if (ch === 'referral') referral += s;
    }
    return { organic: organic, direct: direct, social: social, referral: referral };
  } catch (e) {
    console.error('Channel error', month.start, e.message);
    return { organic: 0, direct: 0, social: 0, referral: 0 };
  }
}

async function fetchGa4Gmb(token, month) {
  try {
    // GA4 "Business Profile Interactions" = all events from GMB sessions
    // EXCLUDING standard automatic GA4 events (page_view, user_engagement, scroll, etc.)
    // Matches GA4 > Reports > Business Profile > Overview > Business Profile Interactions
    var AUTO_EVENTS = [
      'page_view', 'user_engagement', 'scroll', 'click',
      'file_download', 'view_search_results',
      'video_start', 'video_progress', 'video_complete'
    ];
    var data = await apiPost(
      'analyticsdata.googleapis.com',
      '/v1beta/properties/' + GA4_PROPERTY_ID + ':runReport',
      token,
      {
        dateRanges: [{ startDate: month.start, endDate: month.end }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'sessionMedium',
            stringFilter: { matchType: 'EXACT', value: 'gmb', caseSensitive: false }
          }
        },
        limit: 100,
      }
    );
    if (data.error) { console.error('GMB error:', JSON.stringify(data.error)); return 0; }
    var total = 0;
    var rows = data.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var evName = rows[i].dimensionValues[0].value;
      if (AUTO_EVENTS.indexOf(evName) === -1) {
        total += Math.round(parseFloat(rows[i].metricValues[0].value || 0));
      }
    }
    return total;
  } catch (e) {
    console.error('GMB fetch error:', e.message);
    return 0;
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
    var months = getMonths(startDate, endDate);

    var rows = await Promise.all(months.map(async function(month) {
      // Check for manual GMB data first (exact numbers from GA4 Business Profile report)
      var monthKey = month.start.slice(0, 7); // "YYYY-MM"
      var hasManualGmb = gmbManualData.hasOwnProperty(monthKey) && gmbManualData[monthKey] > 0;

      var results = await Promise.all([
        fetchGscTotals(token, month),
        fetchGa4Totals(token, month),
        fetchGa4Channels(token, month),
        hasManualGmb ? Promise.resolve(gmbManualData[monthKey]) : fetchGa4Gmb(token, month),
        fetchGa4ReturningUsers(token, month),
      ]);
      var ga4 = results[1];
      ga4.returningUsers = results[4];
      return {
        month: month.label,
        partial: month.partial,
        gsc: results[0],
        ga4: ga4,
        channels: results[2],
        gmb: results[3],
      };
    }));

    res.json({ rows: rows });
  } catch (err) {
    console.error('Handler error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
