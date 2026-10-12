# SSL Wireless Push SMS Connectivity API v3 - reference

Source: `Technical Specification of Push SMS Connectivity API`, v3.0.0 (SSL Wireless / Software Shop
Limited). Kept here as text so the implementation in `src/smsClient.js` and `src/statusCodes.js` can be
checked against it without the PDF.

- Transport: HTTP/HTTPS, `GET` or `POST`, `Content-Type: application/json`, JSON response.
- Authentication: `api_token` (from SSL) plus `sid` (the brand / masking name) in every request.
- `csms_id` is the client's own reference for one SMS and must be unique **for the same day**; a repeat
  is rejected as a duplicate rather than delivered twice.

## 1. Single SMS

`POST <domain>/api/v3/send-sms`

| Name | Mandatory | Type | Length | Description |
|---|---|---|---|---|
| `api_token` | Yes | Alphanumeric | 50 | Provided by SSL for authentication |
| `sid` | Yes | Alphanumeric | 20 | Unique id for the brand/masking name |
| `msisdn` | Yes | Numeric | 16 | Recipient mobile number |
| `sms` | Yes | Alphanumeric | 1000 | SMS body (length differs for Unicode) |
| `csms_id` | Yes | Alphanumeric | 20 | Client reference id, unique per day |

```json
{ "api_token": "1279-98d2bb25-...", "sid": "ENGINEERING", "msisdn": "88019XXXXXXXX", "sms": "Message Body", "csms_id": "4473433434pZ684333392" }
```

## 2. Bulk SMS

`POST <domain>/api/v3/send-sms/bulk` - one common body to many recipients. **MSISDN limit per request: 100.**

| Name | Mandatory | Type | Description |
|---|---|---|---|
| `api_token` | Yes | Alphanumeric | Provided by SSL |
| `sid` | Yes | Alphanumeric | Brand/masking name |
| `msisdn` | Yes | Numeric array | Recipient numbers (array) |
| `sms` | Yes | Alphanumeric | Common SMS body |
| `batch_csms_id` | Yes | Alphanumeric | One reference id for the whole request |

```json
{ "api_token": "...", "sid": "ENGINEERING", "msisdn": ["019XXXXXXXX", "017XXXXXXXX"], "sms": "Message Body", "batch_csms_id": "4437343343P3Z684333392" }
```

## 3. Dynamic SMS

`POST <domain>/api/v3/send-sms/dynamic` - many recipients, each with its own body.
**SMS limit per request: 100.**

| Name | Mandatory | Type | Description |
|---|---|---|---|
| `api_token` | Yes | Alphanumeric | Provided by SSL |
| `sid` | Yes | Alphanumeric | Brand/masking name |
| `sms` | Yes | Array | One object per SMS, each with `text`, `msisdn`, `csms_id` |

```json
{ "api_token": "...", "sid": "ENGINEERING",
  "sms": [ { "text": "Message Body 1", "msisdn": "019XXXXXXXX", "csms_id": "234444343222" },
           { "text": "Message Body 2", "msisdn": "017XXXXXXXX", "csms_id": "222334242244" } ] }
```

## 4. Response

All three endpoints answer with the same shape.

```json
{ "status": "SUCCESS", "status_code": 200, "error_message": "",
  "smsinfo": [ { "sms_status": "SUCCESS", "status_message": "Success", "msisdn": "88019XXXXXXXX",
                 "sms_type": "EN", "sms_body": "Message Body", "csms_id": "4473433434pZ684333392",
                 "reference_id": "5da2f0b5ba3a2248110" } ] }
```

- `status` / `status_code` / `error_message` are the API-level result (one per request).
- `smsinfo` has one object per SMS: `sms_status`, `status_message`, `msisdn`, `sms_type` (`EN`, or `BN`
  when the body is Unicode), `sms_body`, `csms_id`, `reference_id` (SSL's id for the SMS).
- On a bulk request every `smsinfo` entry repeats the same `batch_csms_id`; on dynamic and single
  requests `csms_id` is the per-SMS value that was sent.
- If the API-level request fails, `smsinfo` is empty and the reason is in `error_message`.

## 5. API status codes (section 3.1)

| Code | Meaning | Description |
|---|---|---|
| 200 | SUCCESS | Successful |
| 4001 | Unauthorized | Invalid API token |
| 4002 | SID/Stakeholder is not permitted | Stakeholder/SID is not permitted to send SMS |
| 4003 | IP Blacklisted | Client IP is blacklisted in SSL API gateway |
| 4004 | End point Not Found | Invalid API URL |
| 4005 | Invalid request format | Invalid content type or is not valid JSON |
| 4020 | Invalid CSMS ID | CSMS ID is not valid |
| 4022 | Required Parameter Missing | A mandatory field has not been filled in |
| 4023 | Duplicate CMS ID | CSMS ID is duplicate in the same day |
| 4025 | Invalid MSISDN | MSISDN is invalid |
| 4026 | Blocked MSISDN | MSISDN is blocked |
| 4027 | Message length exceeded | Maximum message length exceeded |
| 4028 | Invalid message data | No SMS is successful on a bulk or dynamic request |
| 4029 | Too many requests | API request limit exceeded |
| 4030 | Limit Exceed | Max MSISDN exceeded for one request |
| 4031 | TPS Exceeded | The limit of TPS exceeds |
| 5000 | Unknown Error | Error for undefined reason |

`RETRYABLE_API_CODES` in `src/statusCodes.js` marks 4029, 4031 and 5000 as transient, so the client
retries them (reusing the same `csms_id`). Every other code is a hard rejection.

## 6. SMS status codes (section 3.2)

| Status | Message |
|---|---|
| SUCCESS | SUCCESS |
| INVALID | Invalid MSISDN / Message length exceeded |
| DUPLICATE | Invalid CSMS ID / Duplicate CMS ID / Duplicate MSISDN |
