const https = require('https');

const LOCATION_NAME = 'locations/1256882118847194377';

function apiGet(hostname, path, token) {
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: hostname, path: path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d.slice(0, 500) }); } });
    });
    req.on('error', reject); req.end();
  });
}

async function getGbpToken() {
  var body = 'grant_type=refresh_token' +
    '&client_id=' + encodeURIComponent(process.env.GBP_CLIENT_ID) +
    '&client_secret=' + encodeURIComponent(process.env.GBP_CLIENT_SECRET) +
    '&refresh_token=' + encodeURIComponent(process.env.GBP_REFRESH_TOKEN);
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, function(res) {
      var d = ''; res.on('data', function(c) { d += c; });
      res.on('end', function() {
        var j = JSON.parse(d);
        if (j.error) reject(new Error(j.error + ': ' + j.error_description));
        else resolve(j.access_token);
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

function sumMetric(data) {
  var total = 0;
  var series = (data.timeSeries && data.timeSeries.datedValues) || [];
  for (var i = 0; i < series.length; i++) {
    total += parseInt(series[i].value || 0);
  }
  return total;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  var startDate = req.query.startDate || '2026-04-01';
  var endDate = req.query.endDate || '2026-04-30';
  var s = startDate.split('-');
  var e = endDate.split('-');
  var dateParams = 'dailyRange.startDate.year=' + s[0] + '&dailyRange.startDate.month=' + parseInt(s[1]) + '&dailyRange.startDate.day=' + parseInt(s[2]) +
    '&dailyRange.endDate.year=' + e[0] + '&dailyRange.endDate.month=' + parseInt(e[1]) + '&dailyRange.endDate.day=' + parseInt(e[2]);

  try {
    var token = await getGbpToken();

    var metrics = [
      'WEBSITE_CLICKS',
      'CALL_CLICKS',
      'DIRECTION_REQUESTS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_CONVERSATIONS'
    ];

    var results = {};
    for (var i = 0; i < metrics.length; i++) {
      var data = await apiGet(
        'businessprofileperformance.googleapis.com',
        '/v1/' + LOCATION_NAME + ':getDailyMetricsTimeSeries?dailyMetric=' + metrics[i] + '&' + dateParams,
        token
      );
      results[metrics[i]] = data.error ? ('ERR: ' + (data.error.message || JSON.stringify(data.error)).slice(0, 100)) : sumMetric(data);
    }

    var interactions = (results['WEBSITE_CLICKS'] || 0) + (results['CALL_CLICKS'] || 0) + (results['DIRECTION_REQUESTS'] || 0);

    res.json({
      dateRange: { startDate, endDate },
      location: LOCATION_NAME,
      metrics: results,
      website_plus_calls_plus_directions: interactions,
      note: 'GA4 shows 86 for Apr, 89 for May — find which combination matches'
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
