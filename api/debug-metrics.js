const https = require('https');
const crypto = require('crypto');
const GA4_PROPERTY_ID = '320415425';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
async function getToken(creds) {
  var now = Math.floor(Date.now()/1000);
  var header = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  var claim = b64url(JSON.stringify({iss:creds.client_email,scope:'https://www.googleapis.com/auth/analytics.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  var sign = crypto.createSign('RSA-SHA256');
  sign.update(header+'.'+claim);
  var sig = sign.sign(creds.private_key,'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  var jwt = header+'.'+claim+'.'+sig;
  var body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='+jwt;
  return new Promise(function(resolve,reject){
    var req = https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},function(res){
      var d=''; res.on('data',function(c){d+=c;}); res.on('end',function(){var j=JSON.parse(d); if(j.error)reject(new Error(j.error)); else resolve(j.access_token);});
    }); req.on('error',reject); req.write(body); req.end();
  });
}
module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  try {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    var token = await getToken(creds);
    var meta = await new Promise(function(resolve,reject){
      var r = https.request({hostname:'analyticsdata.googleapis.com',path:'/v1beta/properties/'+GA4_PROPERTY_ID+'/metadata',method:'GET',headers:{'Authorization':'Bearer '+token}},function(res2){
        var d=''; res2.on('data',function(c){d+=c;}); res2.on('end',function(){resolve(JSON.parse(d));});
      }); r.on('error',reject); r.end();
    });
    // Return ALL metric names so we can find the right one
    var allMetrics = (meta.metrics||[]).map(function(m){return m.apiName;}).sort();
    res.json({ total: allMetrics.length, metrics: allMetrics });
  } catch(e) {
    res.status(500).json({error: e.message});
  }
};
