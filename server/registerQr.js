'use strict';

// The QR sticker at the register. It encodes  <site>/s/<token> . Customers scan
// it to collect their daily stamp. The token is random and stored in the
// database; staff can replace it (e.g. if someone posts a photo of the sticker
// online), which instantly stops the old sticker from working.

const crypto = require('node:crypto');

function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
}

function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

function newStampToken() {
  return crypto.randomBytes(16).toString('base64url');
}

function getStampToken(db) {
  let token = getSetting(db, 'stamp_token');
  if (!token) {
    token = newStampToken();
    setSetting(db, 'stamp_token', token);
  }
  return token;
}

function rotateStampToken(db) {
  const token = newStampToken();
  setSetting(db, 'stamp_token', token);
  return token;
}

function isValidStampToken(db, candidate) {
  if (typeof candidate !== 'string' || candidate.length > 100) return false;
  const a = Buffer.from(sha(candidate));
  const b = Buffer.from(sha(getStampToken(db)));
  return crypto.timingSafeEqual(a, b);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { getStampToken, rotateStampToken, isValidStampToken };
