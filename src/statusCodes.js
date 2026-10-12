// Status codes from "Technical Specification of Push SMS Connectivity API" v3.0.0,
// sections 3.1 (API status code) and 3.2 (SMS status code).
// Every reply has an API-level result; a successful request also carries one smsinfo entry per MSISDN.

const API_STATUS_CODES = {
  200: { status: 'SUCCESS', meaning: 'SUCCESS', description: 'Successful' },
  4001: { status: 'FAILED', meaning: 'Unauthorized', description: 'Invalid API token' },
  4002: { status: 'FAILED', meaning: 'SID/Stakeholder is not permitted', description: 'Stakeholder/SID is not permitted to send SMS' },
  4003: { status: 'FAILED', meaning: 'IP Blacklisted', description: 'Client IP is blacklisted in SSL API gateway' },
  4004: { status: 'FAILED', meaning: 'End point Not Found', description: 'Invalid API URL' },
  4005: { status: 'FAILED', meaning: 'Invalid request format', description: 'Invalid content type or is not valid JSON' },
  4020: { status: 'FAILED', meaning: 'Invalid CSMS ID', description: 'CSMS ID is not valid' },
  4022: { status: 'FAILED', meaning: 'Required Parameter Missing', description: 'A mandatory field has not been filled in the request parameters' },
  4023: { status: 'FAILED', meaning: 'Duplicate CMS ID', description: 'CSMS ID is duplicate in the same day' },
  4025: { status: 'FAILED', meaning: 'Invalid MSISDN', description: 'MSISDN is invalid' },
  4026: { status: 'FAILED', meaning: 'Blocked MSISDN', description: 'MSISDN is blocked' },
  4027: { status: 'FAILED', meaning: 'Message length exceeded', description: 'Maximum message length exceeded' },
  4028: { status: 'FAILED', meaning: 'Invalid message data', description: 'No SMS is successful on a bulk or dynamic request' },
  4029: { status: 'FAILED', meaning: 'Too many requests', description: 'API request limit exceeded' },
  4030: { status: 'FAILED', meaning: 'Limit Exceed', description: 'Max MSISDN exceeded for one request' },
  4031: { status: 'FAILED', meaning: 'TPS Exceeded', description: 'The limit of TPS exceeds' },
  5000: { status: 'FAILED', meaning: 'Unknown Error', description: 'Error for undefined reason' },
};

// Per-message result inside smsinfo (section 3.2).
const SMS_STATUS_CODES = {
  SUCCESS: ['SUCCESS'],
  INVALID: ['Invalid MSISDN', 'Message length exceeded'],
  DUPLICATE: ['Invalid CSMS ID', 'Duplicate CMS ID', 'Duplicate MSISDN'],
};

// Rate/limit/unknown failures that can clear on their own: worth one more attempt with the same
// csms_id (SSL then rejects the duplicate rather than delivering the SMS twice).
const RETRYABLE_API_CODES = new Set([4029, 4031, 5000]);

function describeApiCode(code) {
  const n = Number(code);
  return API_STATUS_CODES[n] || { status: 'FAILED', meaning: `Unknown status code ${code}`, description: 'Unknown status code' };
}

module.exports = { API_STATUS_CODES, SMS_STATUS_CODES, RETRYABLE_API_CODES, describeApiCode };
