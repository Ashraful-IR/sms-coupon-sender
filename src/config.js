require('dotenv').config();
const path = require('path');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3000),
  apiKey: process.env.API_KEY,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
  // Throughput: at most RATE_PER_SECOND SMS requests start per second, CONCURRENCY in flight at once.
  // 200,000 rows at 10/s = about 5.5 hours; at 50/s = about 67 minutes. Ask SSL Wireless what your account allows.
  concurrency: num(process.env.CONCURRENCY, 10),
  ratePerSecond: num(process.env.RATE_PER_SECOND, 10),
  // Stop the job if this many SMS in a row fail (wrong token, no balance, blocked sender id...)
  failureLimit: num(process.env.CONSECUTIVE_FAILURE_LIMIT, 25),
  autoResume: process.env.AUTO_RESUME !== 'false',
  maxRetries: num(process.env.MAX_RETRIES, 2),
  timeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 15000),
  template: process.env.SMS_TEMPLATE || 'Your coupon {cupon_code} is valid at {outlate_name}.',
  ssl: {
    url: process.env.SSL_URL || 'https://smsplus.sslwireless.com/api/v3/send-sms',
    apiToken: process.env.SSL_API_TOKEN,
    sid: process.env.SSL_SID,
  },
};

const ALLOWED_PLACEHOLDERS = ['contact_no', 'outlate_name', 'cupon_code', 'stage'];
const unknown = [...config.template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !ALLOWED_PLACEHOLDERS.includes(k));
if (unknown.length) {
  console.error(`SMS_TEMPLATE uses unknown placeholder(s): ${unknown.map((k) => '{' + k + '}').join(', ')}. Allowed: ${ALLOWED_PLACEHOLDERS.map((k) => '{' + k + '}').join(', ')}`);
  process.exit(1);
}

if (!config.apiKey) {
  console.error('Missing API_KEY in environment (.env). Refusing to start unprotected.');
  process.exit(1);
}

module.exports = config;
