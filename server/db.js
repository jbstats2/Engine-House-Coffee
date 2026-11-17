'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name             TEXT NOT NULL,
      password_hash    TEXT NOT NULL,
      role             TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff')),
      member_code      TEXT NOT NULL UNIQUE,
      current_stamps   INTEGER NOT NULL DEFAULT 0,
      lifetime_points  INTEGER NOT NULL DEFAULT 0,
      lifetime_coffees INTEGER NOT NULL DEFAULT 0,
      free_redeemed    INTEGER NOT NULL DEFAULT 0,
      failed_logins    INTEGER NOT NULL DEFAULT 0,
      locked_until     INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      staff_id    INTEGER REFERENCES users(id),
      kind        TEXT NOT NULL CHECK (kind IN ('stamp','free_coffee')),
      day         TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Upgrade databases created before the one-stamp-per-day rule.
  const cols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  if (!cols.includes('day')) db.exec('ALTER TABLE transactions ADD COLUMN day TEXT');
  // One card action per customer per day. Older per-cup rows have day = NULL,
  // which UNIQUE ignores.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_user_day ON transactions(user_id, day)');
  return db;
}

module.exports = { openDb };
