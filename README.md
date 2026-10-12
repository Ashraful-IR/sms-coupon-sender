# SMS Coupon Sender

A small HTTP service that sends one coupon SMS per recipient through SSL Wireless (Push SMS API v3)
and records the outcome of every single message.

You upload a CSV of people, the service validates it, and then sends in the background - one message
per row, built from a template (`{outlate_name}`, `{cupon_code}` ...). It is built for big lists:
100,000-200,000 rows in one file is a normal run, so a real send can take minutes to hours. Every row
ends up with a definite status, and you download a result CSV when it finishes.

Nothing is sent by accident: uploading never sends, and the send step requires an explicit
`{"dry_run": true|false}`.

Design and decisions: [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md).
Gateway reference (endpoints, parameters, status codes): [doc/ssl-push-sms-api-v3.md](doc/ssl-push-sms-api-v3.md).

## What it does

- Accepts a CSV with `contact_no`, `outlate_name`, `cupon_code` and optional `stage`.
- Validates and normalises every row up front: bad mobile numbers, missing fields and duplicate
  (`contact_no` + `cupon_code`) rows are marked `skipped` and are never sent.
- Renders a per-recipient message from `SMS_TEMPLATE` and sends it with your SSL Wireless credentials.
- Sends in batches, using whichever of the three documented Push SMS endpoints you configure
  (`single`, `bulk` or `dynamic`) - see [Send modes](#send-modes).
- Keeps a durable row-by-row record in SQLite, so status and counts survive a restart.
- Resumes an interrupted job after a crash **without** resending anything that might already have gone out.
- Stops the whole job if messages start failing in a row (wrong token, no balance, blocked sender id).
- Produces a result CSV you can download at any time, in original file order.

## Requirements

- Node.js 18 or newer (Node 20+ recommended).
- An SSL Wireless account with an API token and a registered SID.
- For long runs, a process manager (systemd or pm2) - the send happens inside the Node process.

## Setup and run

```bash
npm install
cp .env.example .env      # then edit .env (see the table below)
npm start                 # or: npm run dev   (restarts on file changes)
```

The service listens on `PORT` (default `3000`) and prints one line when ready:

```
SMS coupon sender on :3000 | rate 10/s, concurrency 10
```

`npm start` runs `node src/server.js` and is the only command you need. Keep it running while a job is
in progress; if it stops, start it again and unfinished jobs resume on their own.

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `API_KEY` | - | **Required.** Guards every `/api` route; sent as the `x-api-key` header |
| `SSL_API_TOKEN` | - | SSL Wireless API token (required for a real send) |
| `SSL_SID` | - | Your registered SID / masking name |
| `SSL_BASE_URL` | `https://smsplus.sslwireless.com` | Gateway host |
| `SSL_URL` / `SSL_BULK_URL` / `SSL_DYNAMIC_URL` | derived from `SSL_BASE_URL` | Per-endpoint overrides |
| `SMS_MODE` | `single` | Which Push SMS endpoint to use: `single`, `bulk` or `dynamic` |
| `BATCH_SIZE` | `100` | Max numbers per request (gateway caps this at 100) |
| `SMS_TEMPLATE` | a sample coupon text | Message body; placeholders `{contact_no}` `{outlate_name}` `{cupon_code}` `{stage}` |
| `RATE_PER_SECOND` | `10` | Requests started per second (**requests**, not SMS) |
| `CONCURRENCY` | `10` | Requests in flight at once |
| `CONSECUTIVE_FAILURE_LIMIT` | `25` | Halt the job after this many failures in a row |
| `AUTO_RESUME` | `true` | Resume a running job automatically after a restart |
| `MAX_RETRIES` | `2` | Retries for network errors, timeouts, 5xx and transient API codes |
| `REQUEST_TIMEOUT_MS` | `15000` | Per-request timeout |
| `MAX_UPLOAD_MB` | `50` | Upload size limit |
| `DATA_DIR` | `./data` | Where the database and uploads live |

## Run a job end to end

There is no UI: the flow is four HTTP calls. The commands below are bash, and assume the service is
running and you are in the project root. `samples/contacts.csv` is a one-row file you can try them with.

Set two shell variables first:

```bash
API_KEY="the-same-value-as-in-.env"
BASE=http://localhost:3000
```

**1. Upload and validate** (sends nothing). `-F` picks the CSV file:

```bash
curl -s -H "x-api-key: $API_KEY" -F "file=@samples/contacts.csv" "$BASE/api/jobs"
```

The response contains `job.id`, per-status counts, a preview of the first 3 rendered messages and an
estimated duration. Keep the id:

```bash
JOB_ID=<the job.id from the response above>
```

**2. Dry run** - renders and records everything but contacts no one:

```bash
curl -s -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"dry_run": true}' "$BASE/api/jobs/$JOB_ID/start"
```

Check the preview and the dry-run result first. Then, on a **fresh** upload (a dry-run job cannot be
reused), start the real send:

```bash
JOB_ID=<id of the new upload>
curl -s -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"dry_run": false}' "$BASE/api/jobs/$JOB_ID/start"
```

**3. Watch it** (status and counts; `remaining` = `pending` + `sending`):

```bash
curl -s -H "x-api-key: $API_KEY" "$BASE/api/jobs/$JOB_ID"
```

**4. Download the result CSV** when `status` is `completed`:

```bash
curl -s -H "x-api-key: $API_KEY" -o "result-$JOB_ID.csv" "$BASE/api/jobs/$JOB_ID/result"
```

Stop a running job at any time (`POST /api/jobs/$JOB_ID/cancel`), and list recent jobs with
`GET /api/jobs`. All `/api` routes need the `x-api-key` header; `/health` does not.

## Where files are stored

Everything lives under `DATA_DIR` (default `./data`, relative to the project root).

| What | Location | Notes |
|---|---|---|
| Database (jobs + every row) | `data/sms.db` | SQLite in WAL mode; `sms.db-wal` and `sms.db-shm` sit next to it. This is the source of truth |
| Uploaded CSV | `data/uploads/<random>.csv` | Temporary. Deleted as soon as the file has been parsed into the database |
| Result CSV | `data/Report- <time>;<date>-<jobId>.csv` | Written automatically when the job finishes; also downloadable at any time through the API |

When a job reaches a terminal state (`completed`, `halted`, `cancelled` or `failed`) the server writes
its report into `data/` by itself, named `Report- <time>;<date>-<jobId>.csv` in local time - for example
`Report- 14-30-05;12-10-2026-5335ed1c.csv`. The time is written with dashes because `:` is not a legal
character in a Windows file name (it would create an NTFS alternate data stream instead of a file), and
the short job id keeps two jobs that finish in the same second from overwriting each other. The report is
built as a `.tmp` file and then renamed, so you can never catch a half-written file, and nothing is
written while the job is still running. `GET /api/jobs/:id` reports the full path as `resultFile`, which
is `null` until the file exists.

The same report is also served at `GET /api/jobs/:id/result`, rebuilt from the database and streamed to
you on each request - it can be requested at any point, even mid-run (unprocessed rows appear with an
empty `response`), and it carries the same file name in its `Content-Disposition`. The two are produced
by the same writer, so the download is byte-identical to the saved file. **You choose where a download lands**: the
`-o "result-$JOB_ID.csv"` in step 4 saves it into the current directory; a browser or Postman's
*Send and Download* will use your download folder instead.

### Result CSV columns

`contact_no, stage, status, response, message, sending_time` - in the original file order, with times
as ISO UTC. The file starts with a UTF-8 BOM so Bangla text opens correctly in Excel.

- `status` is one of `SENT`, `FAILED`, `SKIPPED`, `UNKNOWN`, `PENDING`, `SENDING`, `DRY_RUN`.
- `SKIPPED` rows are included, with the reason (invalid number, missing field, duplicate row).
- `message` is the exact text that was rendered for that row.
- `response` is compact JSON for that row: the API result (`status`, `status_code`, `error_message`)
  plus the SMS result (`sms_status`, `status_message`, `msisdn`, `reference_id`).

Because send results are pulled back out of the database, exporting the same job twice gives the same
file, and restarting the service does not lose results.

## Send modes

`SMS_MODE` chooses which of the three documented endpoints is used; it is fixed on a job when it starts.

| Mode | Endpoint | One request carries |
|---|---|---|
| `single` (default) | `/api/v3/send-sms` | 1 SMS |
| `bulk` | `/api/v3/send-sms/bulk` | up to 100 numbers with one shared body (only rows whose text is identical share a request) |
| `dynamic` | `/api/v3/send-sms/dynamic` | up to 100 numbers, each with its own body |

`RATE_PER_SECOND` is requests per second, so `dynamic` with `BATCH_SIZE=100` sends up to 100x more SMS
per second than `single` at the same rate. Because coupon text differs per row, `dynamic` is the mode
that actually batches here.

## Safety behaviour

- Invalid numbers, missing fields and duplicate rows are skipped, never sent.
- Uploading a file that was already sent returns `409` (use `force=true` to override).
- 25 failures in a row halt the job (bad token, no balance...). Fix it and call start again to continue.
- After a crash or restart, unfinished jobs resume automatically. Rows that were in flight at the crash
  are marked `unknown` and are **not** resent; check them in the SSL Wireless panel.
- A resumed job keeps the send mode it was started with.

## Postman

Import both files from `postman/`, pick the **SMS Coupon Sender - Local** environment and set `api_key`.
Run requests 1 to 6 in order; request 1 stores `job_id` automatically.
