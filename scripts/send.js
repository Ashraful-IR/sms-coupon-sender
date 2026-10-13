#!/usr/bin/env node
/*
 * One-command front end for the running SMS service, so the send flow is an npm
 * script instead of four curl calls. The server must already be running.
 *
 *   npm run send -- samples/contacts.csv        upload + DRY RUN (nothing is sent)
 *   npm run send:live -- samples/contacts.csv   upload + REAL SEND (costs credits)
 *
 * Flags:
 *   --force     allow re-uploading a file that was already sent
 *   --wait      keep polling until the job finishes instead of printing one snapshot
 *   --no-wait   do not wait: print one snapshot and exit (the default for a live send)
 *
 * A dry run waits for the job to finish by itself: the server writes the report CSV into
 * DATA_DIR (default ./data) only once the job is finished, and reviewing that file is the
 * whole point of a dry run. A live send of a large list can take hours, so it prints one
 * snapshot unless you pass --wait. Ctrl+C stops the polling but never the job: it keeps
 * running on the server, and its report is written (or finished at the next startup).
 *
 * SERVICE_URL overrides the target (default http://localhost:$PORT).
 */
const fs = require('fs');
const path = require('path');
// Loading the config also loads .env and refuses to run without API_KEY, so the
// wrapper talks to the same port and uses the same key as the server.
const config = require('../src/config');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

const LIVE = flags.has('--live');
const FORCE = flags.has('--force');
const WAIT = flags.has('--wait') || (!LIVE && !flags.has('--no-wait'));
const file = positional[0] || 'samples/contacts.csv';
const base = (process.env.SERVICE_URL || `http://localhost:${config.port}`).replace(/\/+$/, '');

const die = (msg) => {
  console.error(`\n  x ${msg}\n`);
  process.exit(1);
};

async function request(method, urlPath, body, isJson) {
  const headers = { 'x-api-key': config.apiKey || '' };
  if (isJson) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(base + urlPath, {
      method,
      headers,
      body: isJson ? JSON.stringify(body) : body,
    });
  } catch (e) {
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message;
    die(`Cannot reach the service at ${base} (${why}).\n    Start it first in another terminal, then re-run:  npm start`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* non-JSON error page */ }
  if (!res.ok) die(`HTTP ${res.status}: ${(data && data.error) || text.slice(0, 300)}`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(file)) die(`CSV not found: ${file}`);

  console.log('');
  console.log(`  file     : ${file}`);
  console.log(`  service  : ${base}`);
  console.log(`  mode     : ${LIVE ? 'LIVE SEND - real SMS, costs credits' : 'dry run - nothing is sent'}`);
  console.log('');

  // 1) Upload and validate. Sends nothing.
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  if (FORCE) form.append('force', 'true');
  const up = await request('POST', '/api/jobs', form, false);
  const job = up.job;

  console.log(`  1. uploaded  job ${job.id}`);
  console.log(`     total ${job.total} | pending ${job.counts.pending} | skipped ${job.counts.skipped}`);
  console.log(`     est. ${up.estimatedMinutes} min at the configured rate`);
  if (up.preview.length) console.log(`     preview: ${up.preview[0]}`);
  if (job.counts.pending === 0) console.log('     note: no pending rows - every row was skipped, nothing to send');
  console.log('');

  // 2) Start: the dry-run flag is the only difference between previewing and sending.
  const started = await request('POST', `/api/jobs/${job.id}/start`, { dry_run: !LIVE }, true);
  console.log(`  2. started   status ${started.status} | dryRun ${started.dryRun} | mode ${started.mode}`);
  console.log('');

  // 3) Status. Poll until the job stops running, so the report file is on disk before we exit.
  let cur = started;
  while (WAIT && cur.status === 'running') {
    await sleep(2000);
    cur = await request('GET', `/api/jobs/${job.id}`);
    process.stdout.write(`\r     ... ${cur.remaining} remaining   `);
  }
  if (WAIT) process.stdout.write(`\r${' '.repeat(44)}\r`);

  console.log(`  3. status    ${cur.status}`);
  console.log(`     counts    ${JSON.stringify(cur.counts)}`);
  if (cur.error) console.log(`     error     ${cur.error}`);
  console.log('');
  if (cur.resultFile) {
    const finished = !['running', 'ready'].includes(cur.status);
    console.log(`  Saved on the server : ${cur.resultFile}${finished ? '' : ' (written when the job finishes)'}`);
  } else if (cur.status === 'running') {
    console.log('  No report file yet: it is written into DATA_DIR as soon as the job finishes.');
  } else {
    console.log('  No report file: the server could not write it. Check the server log.');
  }
  console.log('  Download the result CSV:');
  console.log(`    curl -s -H "x-api-key: $API_KEY" -o "result-${job.id}.csv" "${base}/api/jobs/${job.id}/result"`);
  console.log('');
  // With --wait the loop only exits once the job stops running, so this branch
  // is just the "you asked for one snapshot" case.
  if (!WAIT && cur.status === 'running') console.log('  (still running - add --wait to poll, or check it later with the status URL)');
  if (!LIVE) console.log(`  Nothing was sent. For the real send:  npm run send:live -- ${file}`);
  console.log('');

  if (cur.status === 'failed') process.exitCode = 1;
}

main().catch((e) => die(e.stack || e.message));
