const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const jobs = require('./jobs');

const uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID() + '.csv'),
  }),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  const given = Buffer.from(String(req.header('x-api-key') || ''));
  const expected = Buffer.from(config.apiKey);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Invalid or missing x-api-key header' });
  }
  next();
}

// Express 4 does not catch rejected promises, so wrap async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', requireApiKey);

// 1) Upload + validate. Nothing is sent yet.
app.post('/api/jobs', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new jobs.HttpError(400, 'Attach a CSV as multipart field "file"');
  try {
    const result = await jobs.createJobFromFile(req.file.path, req.file.originalname, String(req.body.force) === 'true');
    res.status(201).json({
      message: 'File validated and loaded. Review the preview, then call POST /api/jobs/:id/start.',
      ...result,
      startUrl: `/api/jobs/${result.job.id}/start`,
    });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}));

// 2) Start (or resume a halted job). dry_run must be stated explicitly to avoid accidental real sends.
app.post('/api/jobs/:id/start', (req, res) => {
  if (typeof req.body?.dry_run !== 'boolean') {
    throw new jobs.HttpError(400, 'Body must be JSON like {"dry_run": true} or {"dry_run": false}');
  }
  res.status(202).json(jobs.startJob(req.params.id, req.body.dry_run));
});

app.post('/api/jobs/:id/cancel', (req, res) => res.status(202).json(jobs.cancelJob(req.params.id)));

app.get('/api/jobs', (_req, res) => res.json(jobs.listJobs()));

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) throw new jobs.HttpError(404, 'Job not found');
  res.json(job);
});

// Result CSV in original file order. Rows not processed yet have empty response/time.
app.get('/api/jobs/:id/result', wrap(async (req, res) => {
  if (!jobs.getJob(req.params.id)) throw new jobs.HttpError(404, 'Job not found');
  await jobs.streamResult(req.params.id, res);
}));

app.use((err, _req, res, _next) => {
  if (err instanceof jobs.HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Internal server error' });
});

jobs.recoverOnStartup();
const server = app.listen(config.port, () => {
  console.log(`SMS coupon sender on :${config.port} | rate ${config.ratePerSecond}/s, concurrency ${config.concurrency}`);
});

// Graceful stop: in-flight rows finish quickly; anything cut off is marked "unknown" on next start.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
