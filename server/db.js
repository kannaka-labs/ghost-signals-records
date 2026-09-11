'use strict';
// SQLite, promisified, one file. The schema is created on open and every
// ALTER is guarded, so an older database upgrades in place.
const path = require('node:path');
const fs = require('node:fs');
const sqlite3 = require('sqlite3');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY,
     public_id TEXT UNIQUE NOT NULL,
     state TEXT NOT NULL,
     brief_json TEXT NOT NULL,
     tier TEXT,
     price_cents INTEGER,
     currency TEXT,
     email TEXT,
     principal TEXT,
     origin TEXT NOT NULL DEFAULT 'web',
     stripe_session_id TEXT,
     stripe_payment_intent TEXT,
     checkout_url TEXT,
     checkout_attempt INTEGER NOT NULL DEFAULT 0,
     paid_at TEXT,
     comped_at TEXT,
     refunded_at TEXT,
     disputed_at TEXT,
     build_started_at TEXT,
     delivered_at TEXT,
     failed_reason TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  // Consent to be shown in public, and the one radio spin. Both are the
  // buyer's to give and to take back; nothing is public by default.
  `ALTER TABLE orders ADD COLUMN featured_at TEXT`,
  `ALTER TABLE orders ADD COLUMN share_note TEXT`,
  `ALTER TABLE orders ADD COLUMN radio_track_idx INTEGER`,
  `ALTER TABLE orders ADD COLUMN radio_requested_at TEXT`,
  `ALTER TABLE orders ADD COLUMN radio_aired_at TEXT`,
  `CREATE INDEX IF NOT EXISTS orders_state ON orders(state)`,
  `CREATE INDEX IF NOT EXISTS orders_featured ON orders(featured_at)`,
  `CREATE INDEX IF NOT EXISTS orders_pi ON orders(stripe_payment_intent)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     principal TEXT,
     origin TEXT NOT NULL,
     state_json TEXT NOT NULL,
     order_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_principal ON sessions(principal, origin)`,
  `CREATE TABLE IF NOT EXISTS tracks (
     order_id TEXT NOT NULL,
     idx INTEGER NOT NULL,
     title TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     lyrics TEXT,
     suno_task_id TEXT,
     file TEXT,
     duration_sec REAL,
     error TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (order_id, idx)
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     payload_json TEXT NOT NULL,
     received_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS ledger (
     key TEXT PRIMARY KEY,
     order_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     amount_cents INTEGER NOT NULL,
     currency TEXT NOT NULL,
     ref TEXT,
     created_at TEXT NOT NULL
   )`,
];

class Db {
  constructor(file) { this.file = file; this.db = null; }

  open() {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.db = new sqlite3.Database(this.file, (err) => (err ? reject(err) : resolve()));
    }).then(async () => {
      await this.run('PRAGMA journal_mode=WAL');
      await this.run('PRAGMA busy_timeout=5000');
      for (const s of SCHEMA) {
        // An ALTER that has already been applied is not an error; every other
        // failure still is.
        try {
          await this.run(s);
        } catch (e) {
          if (!/duplicate column name/i.test(String(e.message))) throw e;
        }
      }
      return this;
    });
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function onRun(err) { if (err) reject(err); else resolve({ changes: this.changes, lastID: this.lastID }); });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null))));
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
  }

  close() {
    return new Promise((resolve) => { if (!this.db) return resolve(); this.db.close(() => resolve()); });
  }
}

const now = () => new Date().toISOString();

module.exports = { Db, now };
