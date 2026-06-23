const https = require('https');
const crypto = require('crypto');
const GA4_PROPERTY_ID = '320415425';

function b64url(i){return Buffer.from(i).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');}
async function getToken(creds){
  var now=Math.floor(Date.now()/1000);
  var h=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
  var c=b64url(JSON.stringify({iss:creds.client_email,scope:'https://www.googleapis.com/auth/analytics.readonly',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600}));
  var s=crypto.createSign('RSA-SHA256'); s.update(h+'.'+c);
  var sig=s.sign(creds.private_key,'base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  var body='grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion='+h+'.'+c+'.'+sig;
  return new Promise((resolve,reject)=>{
    var req=https.request({hostname:'oauth2.googleapis.com',path:'/token',method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)}},res=>{
      var d='';res.on('data',c=>d+=c);res.on('end',()=>{var j=JSON.parse(d);j.error?reject(new Error(j.error)):resolve(j.access_token);});
    });req.on('error',reject);req.write(body);req.end();
  });
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  try {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    var token = await getToken(creds);
    var body = JSON.stringify({
      dateRanges:[{startDate:'2026-04-01',endDate:'2026-04-30'}],
      dimensions:[
        {name:'sessionSource'},
        {name:'sessionMedium'},
        {name:'sessionCampaignName'},
        {name:'sessionDefaultChannelGrouping'}
      ],
      metrics:[{name:'sessions'}],
      orderBys:[{metric:{metricName:'sessions'},desc:true}],
      limit:50
    });
    var data = await new Promise((resolve,reject)=>{
      var r=https.request({hostname:'analyticsdata.googleapis.com',path:'/v1beta/properties/'+GA4_PROPERTY_ID+':runReport',method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res2=>{
        var d='';res2.on('data',c=>d+=c);res2.on('end',()=>resolve(JSON.parse(d)));
      });r.on('error',reject);r.write(body);r.end();
    });
    var rows=(data.rows||[]).map(r=>({
      source:r.dimensionValues[0].value,
      medium:r.dimensionValues[1].value,
      campaign:r.dimensionValues[2].value,
      channel:r.dimensionValues[3].value,
      sessions:r.metricValues[0].value
    }));
    res.json({rows});
  } catch(e){res.status(500).json({error:e.message});}
};
