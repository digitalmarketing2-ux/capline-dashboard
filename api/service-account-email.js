module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    var creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    res.json({ service_account_email: creds.client_email });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
};
