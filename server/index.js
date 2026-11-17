'use strict';

const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');
const sec = require('./security');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'loyalty.db');

const db = openDb(DB_FILE);

// Owner (admin) account for hosted deploys, where there may be no shell to
// run `npm run create-staff`. Set STAFF_EMAIL + STAFF_PASSWORD once. If the
// account already exists it is only made sure to be an admin (the password is
// never reset from here), so it's safe to leave these set.
function bootstrapStaff() {
  const email = (process.env.STAFF_EMAIL || '').trim().toLowerCase();
  const password = process.env.STAFF_PASSWORD || '';
  if (!email) return;
  if (!sec.validateEmail(email)) return console.warn('STAFF_EMAIL is not a valid email; skipping.');
  const existing = db.prepare('SELECT id, role, is_admin FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.role === 'staff' && !existing.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
      console.log(`${email} is now an admin.`);
    }
    return;
  }
  const pwErr = sec.validatePassword(password);
  if (pwErr) return console.warn(`STAFF_PASSWORD rejected: ${pwErr} Staff account not created.`);

  let code;
  do code = sec.newMemberCode();
  while (db.prepare('SELECT 1 FROM users WHERE member_code = ?').get(code));
  db.prepare(`
    INSERT INTO users (email, name, password_hash, role, is_admin, member_code, created_at)
    VALUES (?, ?, ?, 'staff', 1, ?, ?)
  `).run(email, process.env.STAFF_NAME || 'Owner', sec.hashPassword(password), code, Date.now());
  console.log(`Created admin account ${email}.`);
}
bootstrapStaff();

const app = createApp({
  db,
  // Set TRUST_PROXY=1 when running behind a reverse proxy / load balancer
  // that terminates HTTPS (Render, Fly, Railway, nginx...).
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
});

app.listen(PORT, () => {
  console.log(`Engine House Coffee loyalty app listening on port ${PORT}`);
});
