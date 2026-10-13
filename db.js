/**
 * SQLite via sql.js (WASM) — no native compile required.
 * Persists to data/loglens.db on disk.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'loglens.db');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db = null;

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function exec(sql) {
  db.run(sql);
}

function run(sql, params = []) {
  db.run(sql, params);
  persist();
  return { changes: db.getRowsModified() };
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'analyst',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lab_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      open_time TEXT NOT NULL DEFAULT '08:30',
      close_time TEXT NOT NULL DEFAULT '17:30',
      n_threshold INTEGER NOT NULL DEFAULT 3,
      w_minutes INTEGER NOT NULL DEFAULT 5,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT,
      timestamp TEXT NOT NULL,
      account TEXT NOT NULL,
      computer TEXT NOT NULL,
      event TEXT NOT NULL,
      department_case TEXT,
      uploaded_by INTEGER,
      batch_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_key TEXT NOT NULL,
      account TEXT NOT NULL,
      computer TEXT NOT NULL,
      department TEXT,
      priority TEXT NOT NULL,
      r1 INTEGER NOT NULL DEFAULT 0,
      r2 INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      human_check TEXT,
      event_count INTEGER DEFAULT 0,
      matched_event_ids TEXT,
      r1_detail TEXT,
      r2_detail TEXT,
      batch_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      reviewed_by INTEGER,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const settings = get('SELECT id FROM lab_settings WHERE id = 1');
  if (!settings) {
    run(`INSERT INTO lab_settings (id, open_time, close_time, n_threshold, w_minutes)
         VALUES (1, '08:30', '17:30', 3, 5)`);
  }

  const userCount = get('SELECT COUNT(*) as c FROM users');
  if (!userCount || userCount.c === 0) {
    const hashAdmin = bcrypt.hashSync('LabTrace@2025', 12);
    const hashAnalyst = bcrypt.hashSync('Analyst@2025', 12);
    run(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)`,
      ['admin', hashAdmin, 'Lab Supervisor', 'admin']
    );
    run(
      `INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)`,
      ['analyst', hashAnalyst, 'Security Analyst', 'analyst']
    );
    console.log('[DB] Seeded users: admin / LabTrace@2025  |  analyst / Analyst@2025');
  }

  persist();
  return { run, get, all, exec, persist };
}

module.exports = { init };
