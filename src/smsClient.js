const config = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(config.ssl.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
    return { httpStatus: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends one SMS. Never throws. Returns { ok, body } where body is the raw response (or error text).
 * Retries only on network errors / timeouts / 5xx. The same csms_id is reused on retry, so SSL
 * can reject a duplicate instead of sending the SMS twice.
 */
async function sendSms({ msisdn, sms, csmsId }) {
  const payload = {
    api_token: config.ssl.apiToken,
    sid: config.ssl.sid,
    msisdn,
    sms,
    csms_id: csmsId,
  };

  let last = 'UNKNOWN_ERROR';
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const r = await callOnce(payload);
      if (r.httpStatus >= 500) { last = `HTTP_${r.httpStatus}: ${r.text}`; continue; }
      const ok = r.httpStatus === 200 && r.json && r.json.status === 'SUCCESS';
      return { ok, body: r.text };
    } catch (err) {
      last = `NETWORK_ERROR: ${err.name === 'AbortError' ? 'timeout' : err.message}`;
    }
  }
  return { ok: false, body: last };
}

module.exports = { sendSms };
