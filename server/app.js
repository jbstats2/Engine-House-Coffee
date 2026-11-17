'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const QRCode = require('qrcode');

const config = require('./config');
const sec = require('./security');
const { recordVisit, cardSummary } = require('./loyalty');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createApp({ db, secureCookies = process.env.NODE_ENV === 'production', trustProxy = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: secureCookies ? [] : null,
      },
    },
    hsts: secureCookies,
  }));
  app.use(express.json({ limit: '10kb' }));

  // ---- Sessions -----------------------------------------------------------

  const cookieOpts = (maxAgeMs) => [
    'Path=/', 'HttpOnly', 'SameSite=Strict',
    secureCookies ? 'Secure' : null,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ].filter(Boolean).join('; ');

  function startSession(res, userId) {
    const token = sec.newToken();
    const now = Date.now();
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sec.sha256(token), userId, now + config.SESSION_TTL_MS, now);
    res.setHeader('Set-Cookie', `${config.SESSION_COOKIE}=${token}; ${cookieOpts(config.SESSION_TTL_MS)}`);
  }

  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[config.SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sec.sha256(token));
    res.setHeader('Set-Cookie', `${config.SESSION_COOKIE}=; ${cookieOpts(0)}`);
  }

  app.use((req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[config.SESSION_COOKIE];
    if (token) {
      const row = db.prepare(`
        SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
      `).get(sec.sha256(token), Date.now());
      if (row) req.user = row;
    }
    next();
  });

  // CSRF defence: cookies are SameSite=Strict, and every state-changing API
  // call must be a JSON request carrying a custom header, which browsers
  // won't send cross-origin without a CORS preflight (which we never grant).
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-Requested-With') !== 'EngineHouseApp') return next(httpError(403, 'Forbidden.'));
    const origin = req.get('Origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return next(httpError(403, 'Forbidden.'));
    next();
  });

  const requireUser = (req, _res, next) => (req.user ? next() : next(httpError(401, 'Please sign in.')));
  const requireStaff = (req, _res, next) =>
    req.user?.role === 'staff' ? next() : next(httpError(req.user ? 403 : 401, 'Staff only.'));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  });

  const publicUser = (u) => ({
    name: u.name, email: u.email, role: u.role, memberCode: u.member_code, memberSince: u.created_at,
  });

  // ---- Auth ---------------------------------------------------------------

  app.post('/api/auth/register', authLimiter, (req, res) => {
    const { name, email, password } = req.body || {};
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!cleanName || cleanName.length > 80) throw httpError(400, 'Please enter your name.');
    if (!sec.validateEmail(cleanEmail)) throw httpError(400, 'Please enter a valid email address.');
    const pwErr = sec.validatePassword(password);
    if (pwErr) throw httpError(400, pwErr);

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)) {
      throw httpError(409, 'An account with that email already exists. Try signing in.');
    }

    let code;
    do code = sec.newMemberCode();
    while (db.prepare('SELECT 1 FROM users WHERE member_code = ?').get(code));

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO users (email, name, password_hash, member_code, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(cleanEmail, cleanName, sec.hashPassword(password), code, Date.now());

    startSession(res, Number(lastInsertRowid));
    res.status(201).json({ ok: true });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const { email, password } = req.body || {};
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const pw = typeof password === 'string' ? password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
    const now = Date.now();

    if (user && user.locked_until > now) {
      throw httpError(429, 'Too many failed attempts. Please try again in a few minutes.');
    }

    const ok = sec.verifyPassword(pw, user ? user.password_hash : sec.DUMMY_HASH) && !!user;
    if (!ok) {
      if (user) {
        const fails = user.failed_logins + 1;
        const lock = fails >= config.MAX_FAILED_LOGINS ? now + config.LOCKOUT_MS : 0;
        db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
          .run(lock ? 0 : fails, lock, user.id);
      }
      throw httpError(401, 'Incorrect email or password.');
    }

    db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    startSession(res, user.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    endSession(req, res);
    res.json({ ok: true });
  });

  app.post('/api/auth/password', requireUser, authLimiter, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!sec.verifyPassword(String(currentPassword || ''), req.user.password_hash)) {
      throw httpError(401, 'Current password is incorrect.');
    }
    const pwErr = sec.validatePassword(newPassword);
    if (pwErr) throw httpError(400, pwErr);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(sec.hashPassword(newPassword), req.user.id);
    // Sign out every other device, then issue a fresh session here.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
    startSession(res, req.user.id);
    res.json({ ok: true });
  });

  // ---- Customer -----------------------------------------------------------

  app.get('/api/me', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ user: publicUser(req.user), card: cardSummary(db, req.user) });
  });

  app.get('/api/me/qr.svg', requireUser, async (req, res, next) => {
    try {
      const svg = await QRCode.toString(req.user.member_code, {
        type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#2b1a12', light: '#ffffff' },
      });
      res.set('Cache-Control', 'private, max-age=3600').type('image/svg+xml').send(svg);
    } catch (err) { next(err); }
  });

  const historyRows = (userId, limit) => db.prepare(`
    SELECT kind, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?
  `).all(userId, limit);

  app.get('/api/me/history', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ history: historyRows(req.user.id, 50).map((r) => ({ kind: r.kind, at: r.created_at })) });
  });

  app.get('/api/me/history.csv', requireUser, (req, res) => {
    const u = req.user;
    const lines = [
      ['Engine House Coffee - Loyalty statement'],
      ['Member', u.name],
      ['Member code', u.member_code],
      ['Current stamps', `${u.current_stamps} / ${config.CARD_SIZE}`],
      ['Lifetime points', u.lifetime_points],
      ['Lifetime visits', u.lifetime_coffees],
      ['Free coffees redeemed', u.free_redeemed],
      [],
      ['Date (UTC)', 'Activity'],
      ...historyRows(u.id, 100000).map((r) => [
        new Date(r.created_at).toISOString(),
        r.kind === 'free_coffee' ? 'Free coffee redeemed' : 'Stamp earned (+1 point)',
      ]),
    ];
    const csvCell = (v) => {
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    res.set('Cache-Control', 'no-store');
    res.attachment('engine-house-loyalty.csv').type('text/csv')
      .send(lines.map((l) => l.map(csvCell).join(',')).join('\r\n'));
  });

  // ---- Staff --------------------------------------------------------------

  function findMember(codeParam) {
    const code = sec.normalizeMemberCode(codeParam);
    const member = code && db.prepare("SELECT * FROM users WHERE member_code = ? AND role = 'customer'").get(code);
    if (!member) throw httpError(404, 'No member found with that code.');
    return member;
  }

  app.get('/api/staff/members/:code', requireStaff, (req, res) => {
    const m = findMember(req.params.code);
    res.set('Cache-Control', 'no-store');
    res.json({ member: { name: m.name, memberCode: m.member_code }, card: cardSummary(db, m) });
  });

  app.post('/api/staff/members/:code/visit', requireStaff, (req, res) => {
    const m = findMember(req.params.code);
    const result = recordVisit(db, { userId: m.id, staffId: req.user.id });
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(m.id);
    res.json({ result, member: { name: updated.name, memberCode: updated.member_code }, card: cardSummary(db, updated) });
  });

  // ---- Static PWA ---------------------------------------------------------

  const pub = path.join(__dirname, '..', 'public');
  app.get('/sw.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache').sendFile(path.join(pub, 'sw.js'));
  });
  app.use(express.static(pub, { index: 'index.html', maxAge: '1h' }));

  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

module.exports = { createApp };
