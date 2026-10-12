const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify/sync');
const db = require('./db');
const config = require('./config');
const { sendSms } = require('./smsClient');
const { normalizeMsisdn, render } = require('./utils');

// "stage" is optional in the upload; it is carried through to the result CSV.
const REQUIRED_COLUMNS = ['contact_no', 'outlate_name', 'cupon_code'];
const RESULT_COLUMNS = ['contact_no', 'stage', 'status', 'response', 'message', 'sending_time'];
const ROW_STATUSES = ['pending', 'sending', 'sent', 'failed', 'skipped', 'unknown', 'dry_run'];

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const running = new Map(); // jobId -> { cancelled: bool }
const now = () => new Date().toISOString();

/* ---------------------------------------------------------------- views */

function getJob(id) {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!j) return null;
  const counts = Object.fromEntries(ROW_STATUSES.map((s) => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM rows WHERE job_id = ? GROUP BY status').all(id)) {
    counts[r.status] = r.c;
  }
  return {
    id: j.id,
    status: j.status,
    dryRun: !!j.dry_run,
    originalName: j.original_name,
    total: j.total,
    counts,
    remaining: counts.pending + counts.sending,
    error: j.error,
    createdAt: j.created_at,
    startedAt: j.started_at,
    finishedAt: j.finished_at,
  };
}

function listJobs() {
  return db.prepare('SELECT id FROM jobs ORDER BY created_at DESC LIMIT 100').all().map((r) => getJob(r.id));
}

/* --------------------------------------------------------------- upload */

async function createJobFromFile(filePath, originalName, force) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

  if (!force) {
    const dup = db.prepare(
      `SELECT id, status FROM jobs WHERE file_hash = ? AND dry_run = 0 AND status IN ('running','halted','completed') LIMIT 1`
    ).get(hash);
    if (dup) {
      throw new HttpError(409, 'This exact file was already sent (or is being sent). Send "force=true" to upload it again.', { existingJobId: dup.id, existingStatus: dup.status });
    }
  }

  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO jobs (id, status, original_name, file_hash, csms_prefix, created_at) VALUES (?, 'loading', ?, ?, ?, ?)`)
    .run(id, originalName, hash, crypto.randomBytes(5).toString('hex'), now());

  const insertRow = db.prepare(
    `INSERT INTO rows (job_id, n, contact_no, outlate_name, cupon_code, stage, msisdn, status, response) VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const insertMany = db.transaction((batch) => { for (const r of batch) insertRow.run(...r); });

  const seen = new Set();
  const preview = [];
  let batch = [];
  let n = 0;
  let headerChecked = false;

  try {
    const parser = fs.createReadStream(filePath).pipe(
      parse({ columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true })
    );
    for await (const rec of parser) {
      if (!headerChecked) {
        const missing = REQUIRED_COLUMNS.filter((c) => !(c in rec));
        if (missing.length) throw new HttpError(400, `CSV is missing column(s): ${missing.join(', ')}`);
        headerChecked = true;
      }
      n++;
      const msisdn = normalizeMsisdn(rec.contact_no);
      let status = 'pending';
      let response = null;
      if (!msisdn || !rec.outlate_name || !rec.cupon_code) {
        status = 'skipped';
        response = 'SKIPPED: invalid contact_no, outlate_name or cupon_code';
      } else {
        const key = `${msisdn}|${rec.cupon_code}`;
        if (seen.has(key)) {
          status = 'skipped';
          response = 'SKIPPED: duplicate contact_no + cupon_code in this file';
        } else {
          seen.add(key);
        }
      }
      if (status === 'pending' && preview.length < 3) preview.push(render(config.template, rec));
      batch.push([id, n, rec.contact_no ?? '', rec.outlate_name ?? '', rec.cupon_code ?? '', rec.stage ?? '', msisdn, status, response]);
      if (batch.length >= 2000) { insertMany(batch); batch = []; }
    }
    if (n === 0) throw new HttpError(400, 'CSV has no data rows');
    insertMany(batch);
    db.prepare(`UPDATE jobs SET total = ?, status = 'ready' WHERE id = ?`).run(n, id);
  } catch (e) {
    db.prepare('DELETE FROM rows WHERE job_id = ?').run(id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    throw e instanceof HttpError ? e : new HttpError(400, `Could not parse CSV: ${e.message}`);
  }

  const job = getJob(id);
  return {
    job,
    preview,
    estimatedMinutes: Math.ceil(job.counts.pending / config.ratePerSecond / 60),
  };
}

/* ------------------------------------------------------------ lifecycle */

function startJob(id, dryRun) {
  const j = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!j) throw new HttpError(404, 'Job not found');
  if (running.has(id)) throw new HttpError(409, 'Job is already running');
  if (!['ready', 'halted'].includes(j.status)) throw new HttpError(409, `Job is ${j.status}; only "ready" or "halted" jobs can be started`);

  const effectiveDry = j.status === 'halted' ? !!j.dry_run : dryRun; // a resumed job keeps its original mode
  if (!effectiveDry && (!config.ssl.apiToken || !config.ssl.sid)) {
    throw new HttpError(500, 'SSL_API_TOKEN / SSL_SID are not configured on the server');
  }
  db.prepare(`UPDATE jobs SET status = 'running', dry_run = ?, error = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?`)
    .run(effectiveDry ? 1 : 0, now(), id);
  launch(id);
  return getJob(id);
}

function cancelJob(id) {
  const j = db.prepare('SELECT status FROM jobs WHERE id = ?').get(id);
  if (!j) throw new HttpError(404, 'Job not found');
  const ctl = running.get(id);
  if (ctl) {
    ctl.cancelled = true; // runner finishes in-flight requests, then marks the job cancelled
  } else if (['ready', 'halted'].includes(j.status)) {
    db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?`).run(now(), id);
  } else {
    throw new HttpError(409, `Job is ${j.status}; nothing to cancel`);
  }
  return getJob(id);
}

function launch(id) {
  const ctl = { cancelled: false };
  running.set(id, ctl);
  setImmediate(() => {
    runJob(id, ctl)
      .catch((e) => {
        console.error(`Job ${id} crashed`, e);
        db.prepare(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(e.message, now(), id);
      })
      .finally(() => running.delete(id));
  });
}

function makeLimiter(ratePerSecond) {
  const interval = 1000 / ratePerSecond;
  let next = 0;
  return async () => {
    const t = Date.now();
    const at = Math.max(t, next);
    next = at + interval;
    if (at > t) await new Promise((r) => setTimeout(r, at - t));
  };
}

async function runJob(id, ctl) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  const dryRun = !!job.dry_run;

  const pick = db.prepare(`SELECT n, contact_no, outlate_name, cupon_code, stage, msisdn FROM rows WHERE job_id = ? AND status = 'pending' ORDER BY n LIMIT 500`);
  const markSending = db.prepare(`UPDATE rows SET status = 'sending' WHERE job_id = ? AND n = ?`);
  const backToPending = db.prepare(`UPDATE rows SET status = 'pending' WHERE job_id = ? AND n = ?`);
  const finish = db.prepare(`UPDATE rows SET status = ?, response = ?, message = ?, sending_time = ? WHERE job_id = ? AND n = ?`);

  const limiter = makeLimiter(config.ratePerSecond);
  let queue = [];
  let consecutiveFailures = 0;
  let haltReason = null;

  const worker = async () => {
    for (;;) {
      if (ctl.cancelled || haltReason) return;
      if (!queue.length) {
        queue = pick.all(id);
        if (!queue.length) return;
      }
      const row = queue.shift();
      markSending.run(id, row.n); // claimed synchronously, so no other worker can take it

      await limiter();
      if (ctl.cancelled || haltReason) { backToPending.run(id, row.n); return; }

      const message = render(config.template, row);
      const sentAt = now();
      if (dryRun) {
        finish.run('dry_run', 'DRY_RUN: not sent', message, sentAt, id, row.n);
        continue;
      }
      const r = await sendSms({ msisdn: row.msisdn, sms: message, csmsId: `${job.csms_prefix}-${row.n}` });
      finish.run(r.ok ? 'sent' : 'failed', r.body, message, sentAt, id, row.n);
      if (r.ok) {
        consecutiveFailures = 0;
      } else if (++consecutiveFailures >= config.failureLimit && !haltReason) {
        haltReason = `Stopped after ${config.failureLimit} consecutive failures. Last response: ${String(r.body).slice(0, 300)}`;
      }
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, worker));

  if (ctl.cancelled) {
    db.prepare(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ?`).run(now(), id);
  } else if (haltReason) {
    db.prepare(`UPDATE jobs SET status = 'halted', error = ? WHERE id = ?`).run(haltReason, id);
  } else {
    db.prepare(`UPDATE jobs SET status = 'completed', finished_at = ? WHERE id = ?`).run(now(), id);
  }
  console.log(`Job ${id} ->`, getJob(id).status, getJob(id).counts);
}

/* -------------------------------------------------------------- startup */

// A crash can leave rows in "sending": we do NOT know whether SSL accepted them, so they are never auto-resent.
function recoverOnStartup() {
  const lost = db.prepare(`UPDATE rows SET status = 'unknown', response = 'UNKNOWN: server stopped while this SMS was in flight. Check the SSL Wireless panel before resending.' WHERE status = 'sending'`).run();
  if (lost.changes) console.warn(`${lost.changes} row(s) marked "unknown" after unclean shutdown`);

  for (const j of db.prepare(`SELECT id FROM jobs WHERE status = 'loading'`).all()) {
    db.prepare('DELETE FROM rows WHERE job_id = ?').run(j.id);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(j.id);
  }
  for (const j of db.prepare(`SELECT id, dry_run FROM jobs WHERE status = 'running'`).all()) {
    if (config.autoResume && (j.dry_run || (config.ssl.apiToken && config.ssl.sid))) {
      console.log(`Resuming job ${j.id}`);
      launch(j.id);
    } else {
      db.prepare(`UPDATE jobs SET status = 'halted', error = 'Server restarted; call /start to resume' WHERE id = ?`).run(j.id);
    }
  }
}

/* --------------------------------------------------------------- result */

async function streamResult(id, res) {
  const stmt = db.prepare(`SELECT contact_no, stage, status, response, message, sending_time FROM rows WHERE job_id = ? ORDER BY n`);
  const write = async (chunk) => { if (!res.write(chunk)) await once(res, 'drain'); };

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="result-${id}.csv"`);
  await write('\uFEFF' + stringify([RESULT_COLUMNS])); // BOM so Excel shows Bangla correctly

  let buf = [];
  for (const r of stmt.iterate(id)) {
    buf.push([r.contact_no, r.stage ?? '', r.status.toUpperCase(), r.response ?? '', r.message ?? '', r.sending_time ?? '']);
    if (buf.length >= 1000) { await write(stringify(buf)); buf = []; }
  }
  if (buf.length) await write(stringify(buf));
  res.end();
}

module.exports = { createJobFromFile, getJob, listJobs, startJob, cancelJob, recoverOnStartup, streamResult, HttpError };
