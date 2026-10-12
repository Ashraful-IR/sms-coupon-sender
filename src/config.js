require('dotenv').config();
const path = require('path');

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const baseUrl = (process.env.SSL_BASE_URL || 'https://smsplus.sslwireless.com').replace(/\/+$/, '');

const config = {
  port: num(process.env.PORT, 3000),
  apiKey: process.env.API_KEY,
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
  // Which Push SMS endpoint the runner uses (see doc/ssl-push-sms-api-v3.md):
  //   single  POST /api/v3/send-sms          one SMS per request
  //   bulk    POST /api/v3/send-sms/bulk     one common body to up to 100 MSISDN
  //   dynamic POST /api/v3/send-sms/dynamic  up to 100 MSISDN, each with its own body
  smsMode: process.env.SMS_MODE || 'single',
  batchSize: num(process.env.BATCH_SIZE, 100),
  // Throughput. In single mode one request = one SMS; in bulk/dynamic mode one request = one batch,
  // so RATE_PER_SECOND is requests per second and a batching mode is up to BATCH_SIZE times faster.
  // 200,000 rows at 10 requests/s = about 5.5 hours single, about 3.5 minutes dynamic (batch 100).
  // Ask SSL Wireless what rate and TPS your account allows.
  concurrency: num(process.env.CONCURRENCY, 10),
  ratePerSecond: num(process.env.RATE_PER_SECOND, 10),
  // Stop the job if this many SMS in a row fail (wrong token, no balance, blocked sender id...)
  failureLimit: num(process.env.CONSECUTIVE_FAILURE_LIMIT, 25),
  autoResume: process.env.AUTO_RESUME !== 'false',
  maxRetries: num(process.env.MAX_RETRIES, 2),
  timeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 15000),
  template: process.env.SMS_TEMPLATE || 'Your coupon {cupon_code} is valid at {outlate_name}.',
  ssl: {
    baseUrl,
    singleUrl: process.env.SSL_URL || `${baseUrl}/api/v3/send-sms`,
    bulkUrl: process.env.SSL_BULK_URL || `${baseUrl}/api/v3/send-sms/bulk`,
    dynamicUrl: process.env.SSL_DYNAMIC_URL || `${baseUrl}/api/v3/send-sms/dynamic`,
    apiToken: process.env.SSL_API_TOKEN,
    sid: process.env.SSL_SID,
  },
};

const SMS_MODES = ['single', 'bulk', 'dynamic'];
if (!SMS_MODES.includes(config.smsMode)) {
  console.error(`SMS_MODE must be one of: ${SMS_MODES.join(', ')} (got "${config.smsMode}")`);
  process.exit(1);
}
// Bulk SMS and Dynamic SMS accept at most 100 MSISDN per request.
config.batchSize = Math.min(Math.max(1, Math.trunc(config.batchSize) || 1), 100);

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
