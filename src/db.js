const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'sms.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL,      -- loading | ready | running | halted | completed | cancelled | failed
  dry_run       INTEGER NOT NULL DEFAULT 0,
  mode          TEXT NOT NULL DEFAULT 'single',  -- single | bulk | dynamic (endpoint used to send)
  original_name TEXT,
  file_hash     TEXT,
  csms_prefix   TEXT NOT NULL,
  total         INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_hash ON jobs(file_hash);

CREATE TABLE IF NOT EXISTS rows (
  job_id         TEXT NOT NULL,
  n              INTEGER NOT NULL,  -- 1-based row number in the uploaded file
  contact_no     TEXT,
  outlate_name   TEXT,
  cupon_code     TEXT,
  stage          TEXT,              -- required: rendered into the SMS and exported in the result CSV
  msisdn         TEXT,
  status         TEXT NOT NULL,     -- pending | sending | sent | failed | skipped | unknown | dry_run
  response       TEXT,
  message        TEXT,
  sending_time   TEXT,
  PRIMARY KEY (job_id, n)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_rows_status ON rows(job_id, status, n);
`);

// Upgrade a database created by an earlier version (old column names, no stage column).
const rowCols = db.prepare('PRAGMA table_info(rows)').all().map((c) => c.name);
if (rowCols.includes('contact_number')) {
  db.exec(`
    ALTER TABLE rows RENAME COLUMN contact_number TO contact_no;
    ALTER TABLE rows RENAME COLUMN outlet_name TO outlate_name;
    ALTER TABLE rows RENAME COLUMN cupon_id TO cupon_code;
  `);
}
if (!db.prepare('PRAGMA table_info(rows)').all().some((c) => c.name === 'stage')) {
  db.exec('ALTER TABLE rows ADD COLUMN stage TEXT');
}
if (!db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'mode')) {
  db.exec("ALTER TABLE jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'");
}
// Name of the report file on disk. Time-based, so it can only be known once written.
if (!db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'result_file')) {
  db.exec('ALTER TABLE jobs ADD COLUMN result_file TEXT');
}

module.exports = db;
