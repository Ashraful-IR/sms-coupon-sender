# SMS Coupon Sender

Upload a CSV of `contact_no, outlate_name, cupon_code, stage` (100k-200k rows is fine). The service sends each person an SMS through SSL Wireless (SMS Plus API v3) in the background and records every outcome.

Design and decisions: [ARCHITECTURE.md](ARCHITECTURE.md).

## Setup
```bash
npm install
cp .env.example .env   # fill in API_KEY, SSL_API_TOKEN, SSL_SID, SMS_TEMPLATE, RATE_PER_SECOND
npm start
```
Requires Node 18 or newer. Run it under a process manager (systemd or pm2) for long jobs.

## Flow
1. **Upload** `POST /api/jobs` (multipart field `file`). Validates and loads the file, sends nothing. Returns counts, a preview of the first 3 SMS texts and an estimated duration.
2. **Start** `POST /api/jobs/:id/start` with `{"dry_run": true}` first, then `{"dry_run": false}` on a fresh upload for the real send. `dry_run` is mandatory so a real send is never accidental.
3. **Watch** `GET /api/jobs/:id` (status and counts).
4. **Download** `GET /api/jobs/:id/result` for the result CSV (`contact_no, stage, status, response, message, sending_time`, original file order, ISO UTC time). `status` is one of SENT, FAILED, SKIPPED, UNKNOWN, PENDING, SENDING, DRY_RUN.

Also: `POST /api/jobs/:id/cancel`, `GET /api/jobs`. All `/api` routes need `x-api-key`.

## Safety behaviour
- Invalid numbers, missing fields and duplicate rows are skipped, never sent.
- Uploading a file that was already sent returns `409` (use `force=true` to override).
- 25 failures in a row halt the job (bad token, no balance...). Fix it and call start again to continue.
- After a crash or restart, unfinished jobs resume automatically. Rows that were in flight at the crash are marked `unknown` and are **not** resent; check them in the SSL Wireless panel.

## Postman
Import both files from `postman/`, pick the **SMS Coupon Sender - Local** environment and set `api_key`. Run requests 1 to 6 in order; request 1 stores `job_id` automatically.
