'use strict';

// Create a staff (barista) account, or promote an existing account to staff.
//
//   npm run create-staff -- --email barista@example.com --name "Sam"
//
// You'll be prompted for a password (input is hidden).

const path = require('node:path');
const readline = require('node:readline');
const { openDb } = require('../server/db');
const sec = require('../server/security');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const email = (arg('email') || '').trim().toLowerCase();
  const name = (arg('name') || 'Staff').trim();
  if (!sec.validateEmail(email)) {
    console.error('Usage: npm run create-staff -- --email you@example.com [--name "Your Name"]');
    process.exit(1);
  }

  const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'loyalty.db'));
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(existing.id);
    console.log(`${email} is now a staff account.`);
    return;
  }

  const password = process.env.STAFF_PASSWORD || await askHidden('Password for new staff account: ');
  const err = sec.validatePassword(password);
  if (err) { console.error(err); process.exit(1); }

  let code;
  do code = sec.newMemberCode();
  while (db.prepare('SELECT 1 FROM users WHERE member_code = ?').get(code));

  db.prepare(`
    INSERT INTO users (email, name, password_hash, role, member_code, created_at)
    VALUES (?, ?, ?, 'staff', ?, ?)
  `).run(email, name, sec.hashPassword(password), code, Date.now());
  console.log(`Staff account created for ${email}.`);
})();
