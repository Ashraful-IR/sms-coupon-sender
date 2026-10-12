const config = require('./config');
const { describeApiCode, RETRYABLE_API_CODES } = require('./statusCodes');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spec: Bulk SMS and Dynamic SMS accept at most 100 MSISDN per request.
const MAX_PER_REQUEST = 100;

async function post(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, {
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

// One smsinfo entry per MSISDN (spec section 4.x.4).
function parseSmsInfo(json) {
  const info = json && Array.isArray(json.smsinfo) ? json.smsinfo : [];
  return info.map((s) => ({
    msisdn: s.msisdn,
    csmsId: s.csms_id,
    ok: String(s.sms_status || '').toUpperCase() === 'SUCCESS',
    smsStatus: s.sms_status,
    statusMessage: s.status_message,
    referenceId: s.reference_id,
  }));
}

/**
 * One request to the gateway, with retries. Never throws.
 * Retries network errors, timeouts, 5xx and the transient API codes (4029 Too many requests,
 * 4031 TPS Exceeded, 5000 Unknown Error). The csms_id / batch_csms_id values are reused on a
 * retry, so SSL rejects the duplicate instead of delivering the SMS twice.
 * Returns { httpStatus, apiStatus, statusCode, errorMessage, raw, results[], ok }.
 */
async function call(url, payload) {
  let last = { httpStatus: 0, text: 'UNKNOWN_ERROR', json: null };

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const r = await post(url, payload);
      const code = r.json ? Number(r.json.status_code) : null;
      const retryable = r.httpStatus >= 500 || RETRYABLE_API_CODES.has(code);
      last = r;
      if (retryable && attempt < config.maxRetries) continue;
      break;
    } catch (err) {
      last = { httpStatus: 0, text: `NETWORK_ERROR: ${err.name === 'AbortError' ? 'timeout' : err.message}`, json: null };
    }
  }

  const json = last.json;
  const api = json ? describeApiCode(json.status_code) : null;
  return {
    httpStatus: last.httpStatus,
    apiStatus: json ? json.status : null,
    statusCode: json ? json.status_code : null,
    // Prefer the gateway's own message; fall back to the code's meaning, then the raw body.
    errorMessage: json ? (json.error_message || (api && api.status === 'FAILED' ? api.description : '')) : last.text,
    raw: last.text,
    results: json ? parseSmsInfo(json) : [],
    ok: !!json && Number(json.status_code) === 200,
  };
}

const auth = () => ({ api_token: config.ssl.apiToken, sid: config.ssl.sid });

/** POST <domain>/api/v3/send-sms - a single SMS to one MSISDN. */
function sendSingle({ msisdn, sms, csmsId }) {
  return call(config.ssl.singleUrl, { ...auth(), msisdn, sms, csms_id: csmsId });
}

/** POST <domain>/api/v3/send-sms/bulk - one common body to an array of MSISDN (max 100). */
function sendBulk({ msisdns, sms, batchCsmsId }) {
  return call(config.ssl.bulkUrl, { ...auth(), msisdn: msisdns, sms, batch_csms_id: batchCsmsId });
}

/** POST <domain>/api/v3/send-sms/dynamic - up to 100 MSISDN, each with its own body. */
function sendDynamic({ messages }) {
  return call(config.ssl.dynamicUrl, {
    ...auth(),
    sms: messages.map((m) => ({ text: m.sms, msisdn: m.msisdn, csms_id: m.csmsId })),
  });
}

function credentialsConfigured() {
  return Boolean(config.ssl.apiToken && config.ssl.sid);
}

module.exports = { sendSingle, sendBulk, sendDynamic, credentialsConfigured, MAX_PER_REQUEST };
