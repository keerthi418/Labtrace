const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { init } = require('./db');
const { detect } = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

let db = null; // set after init

// ─── Security middleware ───────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Rate limit exceeded.' },
});

app.use(
  session({
    name: 'loglens.sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    },
  })
);

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/login.html');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function audit(userId, action, details, ip) {
  try {
    db.run(
      'INSERT INTO audit_log (user_id, action, details, ip) VALUES (?, ?, ?, ?)',
      [userId || null, action, details || null, ip || null]
    );
  } catch (_) {}
}

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─── Auth routes ───────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = db.get(
    'SELECT id, username, password_hash, display_name, role FROM users WHERE username = ?',
    [String(username).trim().toLowerCase()]
  );

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    audit(null, 'LOGIN_FAIL', `username=${username}`, req.ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.displayName = user.display_name;
  req.session.role = user.role;

  audit(user.id, 'LOGIN_OK', null, req.ip);
  res.json({
    ok: true,
    user: {
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    },
  });
});

app.post('/api/logout', (req, res) => {
  const uid = req.session?.userId;
  req.session.destroy(() => {
    audit(uid, 'LOGOUT', null, req.ip);
    res.clearCookie('loglens.sid');
    res.json({ ok: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    username: req.session.username,
    displayName: req.session.displayName,
    role: req.session.role,
  });
});

// ─── Protected API ─────────────────────────────────
app.use('/api', apiLimiter, requireAuth);

app.get('/api/settings', (req, res) => {
  const s = db.get('SELECT * FROM lab_settings WHERE id = 1');
  res.json(s || { open_time: '08:30', close_time: '17:30', n_threshold: 3, w_minutes: 5 });
});

app.put('/api/settings', (req, res) => {
  const { open_time, close_time, n_threshold, w_minutes } = req.body || {};
  db.run(
    `UPDATE lab_settings SET
      open_time = COALESCE(?, open_time),
      close_time = COALESCE(?, close_time),
      n_threshold = COALESCE(?, n_threshold),
      w_minutes = COALESCE(?, w_minutes),
      updated_at = datetime('now')
     WHERE id = 1`,
    [
      open_time || null,
      close_time || null,
      n_threshold != null ? parseInt(n_threshold, 10) : null,
      w_minutes != null ? parseInt(w_minutes, 10) : null,
    ]
  );
  audit(req.session.userId, 'SETTINGS_UPDATE', JSON.stringify(req.body), req.ip);
  res.json({ ok: true });
});

app.get('/api/dashboard', (req, res) => {
  const eventCount = db.get('SELECT COUNT(*) as c FROM events').c;
  const caseCount = db.get('SELECT COUNT(*) as c FROM cases').c;
  const toReview = db.get(
    `SELECT COUNT(*) as c FROM cases WHERE priority IN ('PRIORITY','REVIEW') AND status = 'open'`
  ).c;
  const routine = db.get(`SELECT COUNT(*) as c FROM cases WHERE priority = 'ROUTINE'`).c;

  const cases = db.all(
    `SELECT id, case_key, account, computer, department, priority, r1, r2, reason,
            human_check, event_count, status, created_at
     FROM cases
     ORDER BY
       CASE priority WHEN 'PRIORITY' THEN 0 WHEN 'REVIEW' THEN 1 ELSE 2 END,
       id DESC`
  );

  res.json({
    metrics: { events: eventCount, cases: caseCount, toReview, routine },
    cases,
  });
});

app.get('/api/cases/:id', (req, res) => {
  const c = db.get('SELECT * FROM cases WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Case not found' });

  const events = db.all(
    `SELECT event_id, timestamp, event, department_case
     FROM events
     WHERE account = ? AND computer = ?
     ORDER BY timestamp ASC`,
    [c.account, c.computer]
  );

  res.json({
    ...c,
    matched_event_ids: c.matched_event_ids ? JSON.parse(c.matched_event_ids) : [],
    r1_detail: c.r1_detail ? JSON.parse(c.r1_detail) : null,
    r2_detail: c.r2_detail ? JSON.parse(c.r2_detail) : null,
    events,
  });
});

app.post('/api/cases/:id/review', (req, res) => {
  const { status } = req.body || {};
  if (!['confirmed', 'dismissed', 'open'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const result = db.run(
    `UPDATE cases SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`,
    [status, req.session.userId, req.params.id]
  );
  if (result.changes === 0) return res.status(404).json({ error: 'Case not found' });
  audit(req.session.userId, 'CASE_REVIEW', `id=${req.params.id} status=${status}`, req.ip);
  res.json({ ok: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'text/csv' ||
      file.originalname.toLowerCase().endsWith('.csv') ||
      file.mimetype === 'application/vnd.ms-excel'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files allowed'));
    }
  },
});

function processEvents(normalized, userId, batchId) {
  const settings = db.get('SELECT * FROM lab_settings WHERE id = 1');

  db.run('DELETE FROM events');
  db.run('DELETE FROM cases');

  for (const e of normalized) {
    db.run(
      `INSERT INTO events (event_id, timestamp, account, computer, event, department_case, uploaded_by, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        e.event_id,
        e.timestamp,
        e.account,
        e.computer,
        e.event,
        e.department_case,
        userId,
        batchId,
      ]
    );
  }

  const cases = detect(normalized, {
    N: settings.n_threshold,
    W: settings.w_minutes,
    openTime: settings.open_time,
    closeTime: settings.close_time,
  });

  for (const c of cases) {
    db.run(
      `INSERT INTO cases (
        case_key, account, computer, department, priority, r1, r2, reason,
        human_check, event_count, matched_event_ids, r1_detail, r2_detail, batch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.case_key,
        c.account,
        c.computer,
        c.department,
        c.priority,
        c.r1,
        c.r2,
        c.reason,
        c.human_check,
        c.event_count,
        c.matched_event_ids,
        c.r1_detail,
        c.r2_detail,
        batchId,
      ]
    );
  }

  return { events: normalized.length, cases: cases.length };
}

app.post('/api/upload', (req, res) => {
  upload.single('csv')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const text = req.file.buffer.toString('utf8');
      const records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      if (!records.length) return res.status(400).json({ error: 'CSV has no data rows' });

      const normalized = records
        .map((row, i) => {
          const lower = {};
          for (const [k, v] of Object.entries(row)) lower[k.toLowerCase().trim()] = v;
          return {
            event_id: lower.event_id || String(i + 1),
            timestamp: lower.timestamp,
            account: lower.account,
            computer: lower.computer,
            event: (lower.event || '').trim(),
            department_case: lower.department_case || lower.department || '',
          };
        })
        .filter((e) => {
          const t = (e.event || '').toLowerCase();
          return e.timestamp && e.account && e.computer && (t === 'failure' || t === 'success');
        })
        .map((e) => ({
          ...e,
          event: e.event.toLowerCase() === 'failure' ? 'Failure' : 'Success',
        }));

      if (!normalized.length) {
        return res.status(400).json({
          error: 'No valid events. Need columns: timestamp, account, computer, event (Failure|Success)',
        });
      }

      const batchId = crypto.randomBytes(8).toString('hex');
      const result = processEvents(normalized, req.session.userId, batchId);

      audit(
        req.session.userId,
        'CSV_UPLOAD',
        `events=${result.events} cases=${result.cases} batch=${batchId}`,
        req.ip
      );

      res.json({ ok: true, ...result, batchId });
    } catch (e) {
      console.error(e);
      res.status(400).json({ error: e.message || 'Failed to parse CSV' });
    }
  });
});

app.post('/api/demo', (req, res) => {
  const demoPath = path.join(__dirname, 'data', 'sample_lab_logs.csv');
  if (!fs.existsSync(demoPath)) {
    return res.status(500).json({ error: 'Demo CSV missing' });
  }
  const text = fs.readFileSync(demoPath, 'utf8');
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });

  const normalized = records.map((row, i) => ({
    event_id: row.event_id || String(i + 1),
    timestamp: row.timestamp,
    account: row.account,
    computer: row.computer,
    event: row.event,
    department_case: row.department_case || '',
  }));

  const batchId = 'demo-' + crypto.randomBytes(4).toString('hex');
  const result = processEvents(normalized, req.session.userId, batchId);
  audit(req.session.userId, 'DEMO_LOAD', `events=${result.events} cases=${result.cases}`, req.ip);
  res.json({ ok: true, ...result });
});

app.post('/api/replay', (req, res) => {
  const settings = db.get('SELECT * FROM lab_settings WHERE id = 1');
  if (req.body) {
    if (req.body.n_threshold != null) settings.n_threshold = parseInt(req.body.n_threshold, 10);
    if (req.body.w_minutes != null) settings.w_minutes = parseInt(req.body.w_minutes, 10);
    if (req.body.open_time) settings.open_time = req.body.open_time;
    if (req.body.close_time) settings.close_time = req.body.close_time;
    db.run(
      `UPDATE lab_settings SET n_threshold=?, w_minutes=?, open_time=?, close_time=?, updated_at=datetime('now') WHERE id=1`,
      [settings.n_threshold, settings.w_minutes, settings.open_time, settings.close_time]
    );
  }

  const events = db.all(
    'SELECT event_id, timestamp, account, computer, event, department_case FROM events ORDER BY timestamp'
  );

  if (!events.length) {
    return res.status(400).json({ error: 'No events loaded. Upload CSV or load demo first.' });
  }

  const cases = detect(events, {
    N: settings.n_threshold,
    W: settings.w_minutes,
    openTime: settings.open_time,
    closeTime: settings.close_time,
  });

  db.run('DELETE FROM cases');
  const batchId = 'replay-' + Date.now();
  for (const c of cases) {
    db.run(
      `INSERT INTO cases (
        case_key, account, computer, department, priority, r1, r2, reason,
        human_check, event_count, matched_event_ids, r1_detail, r2_detail, batch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.case_key,
        c.account,
        c.computer,
        c.department,
        c.priority,
        c.r1,
        c.r2,
        c.reason,
        c.human_check,
        c.event_count,
        c.matched_event_ids,
        c.r1_detail,
        c.r2_detail,
        batchId,
      ]
    );
  }

  audit(req.session.userId, 'REPLAY', `N=${settings.n_threshold} W=${settings.w_minutes}`, req.ip);
  res.json({ ok: true, cases: cases.length, settings });
});

app.get('/api/audit', requireAdmin, (req, res) => {
  const rows = db.all(
    `SELECT a.id, a.action, a.details, a.ip, a.created_at, u.username
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT 100`
  );
  res.json(rows);
});

app.get('/', (req, res) => {
  if (req.session?.userId) return res.redirect('/dashboard.html');
  res.redirect('/login.html');
});

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ─── Boot ──────────────────────────────────────────
(async () => {
  db = await init();
  app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║   LogLens · LabTrace  —  localhost:' + PORT + '   ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log('  Login credentials:');
    console.log('    admin    /  LabTrace@2025   (supervisor)');
    console.log('    analyst  /  Analyst@2025    (analyst)');
    console.log('');
    console.log('  Open → http://localhost:' + PORT);
    console.log('');
  });
})().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
