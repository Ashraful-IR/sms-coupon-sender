const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify/sync');
const db = require('./db');
const config = require('./config');
const { sendSingle, sendBulk, sendDynamic, credentialsConfigured } = require('./smsClient');
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
    mode: j.mode || 'single',
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
  db.prepare(`INSERT INTO jobs (id, status, mode, original_name, file_hash, csms_prefix, created_at) VALUES (?, 'loading', ?, ?, ?, ?, ?)`)
    .run(id, config.smsMode, originalName, hash, crypto.randomBytes(5).toString('hex'), now());

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
  if (!effectiveDry && !credentialsConfigured()) {
    throw new HttpError(500, 'SSL_API_TOKEN / SSL_SID are not configured on the server');
  }
  // A resumed job keeps the endpoint it was started with, so a batch never changes shape mid-run.
  const mode = j.status === 'halted' ? j.mode : config.smsMode;
  db.prepare(`UPDATE jobs SET status = 'running', dry_run = ?, mode = ?, error = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?`)
    .run(effectiveDry ? 1 : 0, mode, now(), id);
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

/* --------------------------------------------------------------- sending */

// Dynamic replies carry our csms_id back; bulk replies only echo the msisdn, so match on that.
const matchKey = (mode, item) => (mode === 'bulk' ? item.msisdn : item.csmsId);

function mapResults(mode, batch, res) {
  const buckets = new Map();
  for (const r of res.results) {
    const key = matchKey(mode, r);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const used = new Set();
  return batch.map((p) => {
    const bucket = buckets.get(matchKey(mode, { msisdn: p.row.msisdn, csmsId: p.csmsId })) || [];
    const hit = bucket.find((r) => !used.has(r)) || null;
    if (hit) used.add(hit);
    return [p, hit];
  });
}

const str = (v) => (v === undefined || v === null ? '' : v);

// Per-row outcome stored in the `response` column, compact so a batch reply is not copied 100 times.
function rowResponse(res, hit) {
  const base = { status: str(res.apiStatus) || 'FAILED', status_code: res.statusCode, error_message: str(res.errorMessage) };
  if (!hit) {
    return JSON.stringify({ ...base, error_message: base.error_message || 'No per-recipient result returned', sms_status: '', status_message: '' });
  }
  return JSON.stringify({ ...base, sms_status: str(hit.smsStatus), status_message: str(hit.statusMessage), msisdn: str(hit.msisdn), reference_id: str(hit.referenceId) });
}

function sendBatch(mode, batch) {
  if (mode === 'dynamic') {
    return sendDynamic({ messages: batch.map((p) => ({ msisdn: p.row.msisdn, sms: p.message, csmsId: p.csmsId })) });
  }
  if (mode === 'bulk') {
    return sendBulk({ msisdns: batch.map((p) => p.row.msisdn), sms: batch[0].message, batchCsmsId: batch[0].csmsId });
  }
  return sendSingle({ msisdn: batch[0].row.msisdn, sms: batch[0].message, csmsId: batch[0].csmsId });
}

/* ------------------------------------------------------------ job runner */

async function runJob(id, ctl) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  const dryRun = !!job.dry_run;
  const mode = job.mode || 'single';

  const pick = db.prepare(`SELECT n, contact_no, outlate_name, cupon_code, stage, msisdn FROM rows WHERE job_id = ? AND status = 'pending' ORDER BY n LIMIT ?`);
  const markSending = db.prepare(`UPDATE rows SET status = 'sending' WHERE job_id = ? AND n = ? AND status = 'pending'`);
  const release = db.prepare(`UPDATE rows SET status = 'pending' WHERE job_id = ? AND n = ? AND status = 'sending'`);
  const finish = db.prepare(`UPDATE rows SET status = ?, response = ?, message = ?, sending_time = ? WHERE job_id = ? AND n = ?`);

  // Claiming runs inside one synchronous transaction, so two workers can never take the same row.
  const claim = db.transaction((rows) => rows.filter((r) => markSending.run(id, r.n).changes));

  // Take the next unit of work: one row (single) or one request-sized batch (bulk / dynamic).
  function claimNext() {
    if (mode === 'single') {
      const rows = pick.all(id, 1);
      return rows.length ? claim(rows) : [];
    }
    const candidates = pick.all(id, config.batchSize);
    if (!candidates.length) return [];
    if (mode === 'dynamic') return claim(candidates);
    // Bulk sends one common body, so only rows that render to the same text share a request.
    const body = render(config.template, candidates[0]);
    return claim(candidates.filter((r) => render(config.template, r) === body));
  }

  const limiter = makeLimiter(config.ratePerSecond);
  let consecutiveFailures = 0;
  let haltReason = null;

  const worker = async () => {
    for (;;) {
      if (ctl.cancelled || haltReason) return;
      const rows = claimNext();
      if (!rows.length) return;

      await limiter();
      if (ctl.cancelled || haltReason) { for (const r of rows) release.run(id, r.n); return; }

      const batch = rows.map((row) => ({ row, message: render(config.template, row), csmsId: `${job.csms_prefix}-${row.n}` }));

      if (dryRun) {
        const at = now();
        for (const p of batch) finish.run('dry_run', 'DRY_RUN: not sent', p.message, at, id, p.row.n);
        continue;
      }

      const res = await sendBatch(mode, batch);
      const at = now();
      for (const [p, hit] of mapResults(mode, batch, res)) {
        const ok = !!(hit && hit.ok);
        finish.run(ok ? 'sent' : 'failed', rowResponse(res, hit), p.message, at, id, p.row.n);
        consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
        if (!haltReason && consecutiveFailures >= config.failureLimit) {
          haltReason = `Stopped after ${config.failureLimit} consecutive failures. Last response: ${String(res.errorMessage || res.raw).slice(0, 300)}`;
        }
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
    if (config.autoResume && (j.dry_run || credentialsConfigured())) {
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
