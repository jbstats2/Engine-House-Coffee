'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const QRCode = require('qrcode');

const config = require('./config');
const sec = require('./security');
const { recordVisit, addStamps, removeStamps, undoTodayStamp, cardSummary, shopDay, PAID_STAMPS_FOR_FREE } = require('./loyalty');
const registerQr = require('./registerQr');

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

// CSV cell, with spreadsheet formula injection blocked (a name like
// "=HYPERLINK(...)" is written as text, not run as a formula).
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createApp({ db, secureCookies = process.env.NODE_ENV === 'production', trustProxy = false, authRateLimit = 20 } = {}) {
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
  const requireAdmin = (req, _res, next) =>
    req.user?.role === 'staff' && req.user.is_admin ? next() : next(httpError(req.user ? 403 : 401, 'Admin only.'));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: authRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
  });

  const publicUser = (u) => ({
    name: u.name, email: u.email, role: u.role, isAdmin: u.role === 'staff' && !!u.is_admin,
    memberCode: u.member_code, memberSince: u.created_at,
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
    SELECT kind, created_at, NULL AS stamps, NULL AS note FROM transactions WHERE user_id = ?
    UNION ALL
    SELECT 'adjustment', created_at, stamps, note FROM adjustments WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, userId, limit);

  const historyLabel = (r) => {
    if (r.kind === 'free_coffee') return 'Free coffee redeemed';
    if (r.kind === 'adjustment') {
      const n = Math.abs(r.stamps);
      const verb = r.stamps > 0 ? 'added' : 'removed';
      return `${n} stamp${n === 1 ? '' : 's'} ${verb} by Engine House${r.note ? ` (${r.note})` : ''}`;
    }
    return 'Stamp earned (+1 point)';
  };

  app.get('/api/me/history', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      history: historyRows(req.user.id, 50).map((r) => ({
        kind: r.kind, at: r.created_at, ...(r.kind === 'adjustment' ? { stamps: r.stamps, note: r.note } : {}),
      })),
    });
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
      ...historyRows(u.id, 100000).map((r) => [new Date(r.created_at).toISOString(), historyLabel(r)]),
    ];
    res.set('Cache-Control', 'no-store');
    res.attachment('engine-house-loyalty.csv').type('text/csv')
      .send(lines.map((l) => l.map(csvCell).join(',')).join('\r\n'));
  });

  // ---- Self-service stamp (customer scans the register QR) -------------

  const stampLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many scans. Please wait a few minutes and try again.' },
  });

  app.post('/api/stamp', requireUser, stampLimiter, (req, res) => {
    if (req.user.role !== 'customer') throw httpError(403, 'Staff accounts can\'t collect stamps.');
    if (!registerQr.isValidStampToken(db, req.body?.token)) {
      throw httpError(400, 'That QR code isn\'t valid. Scan the Engine House code at the register.');
    }
    const result = recordVisit(db, { userId: req.user.id, staffId: null });
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ result, card: cardSummary(db, updated) });
  });

  // ---- Staff --------------------------------------------------------------

  // ---- Admin: members database -------------------------------------------

  function memberRows() {
    return db.prepare(`
      SELECT u.name, u.email, u.member_code, u.created_at, u.current_stamps,
             u.lifetime_points, u.lifetime_coffees, u.free_redeemed,
             (SELECT MAX(created_at) FROM transactions t WHERE t.user_id = u.id) AS last_visit
      FROM users u WHERE u.role = 'customer'
      ORDER BY u.created_at DESC
    `).all();
  }

  app.get('/api/admin/members', requireAdmin, (_req, res) => {
    const now = Date.now();
    const rows = memberRows();
    const today = shopDay(now);
    res.set('Cache-Control', 'no-store').json({
      summary: {
        members: rows.length,
        newThisWeek: rows.filter((r) => r.created_at > now - 7 * 24 * 60 * 60 * 1000).length,
        visitsToday: db.prepare(`
          SELECT COUNT(*) AS n FROM transactions t JOIN users u ON u.id = t.user_id
          WHERE t.day = ? AND u.role = 'customer'`).get(today).n,
        freeCoffees: rows.reduce((sum, r) => sum + r.free_redeemed, 0),
        lifetimePoints: rows.reduce((sum, r) => sum + r.lifetime_points, 0),
      },
      members: rows.map((r) => ({
        name: r.name,
        email: r.email,
        memberCode: r.member_code,
        joined: r.created_at,
        lastVisit: r.last_visit,
        currentStamps: Math.min(r.current_stamps, PAID_STAMPS_FOR_FREE),
        extraStamps: Math.max(0, r.current_stamps - PAID_STAMPS_FOR_FREE),
        lifetimePoints: r.lifetime_points,
        lifetimeVisits: r.lifetime_coffees,
        freeRedeemed: r.free_redeemed,
      })),
    });
  });

  app.get('/api/admin/members.csv', requireAdmin, (_req, res) => {
    const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
    const lines = [
      ['Name', 'Email', 'Member code', 'Joined (UTC)', 'Last visit (UTC)', 'Current stamps',
        'Lifetime points', 'Lifetime visits', 'Free coffees redeemed'],
      ...memberRows().map((r) => [
        r.name, r.email, r.member_code, iso(r.created_at), iso(r.last_visit),
        r.current_stamps, r.lifetime_points, r.lifetime_coffees, r.free_redeemed,
      ]),
    ];
    res.set('Cache-Control', 'no-store');
    res.attachment(`engine-house-members-${shopDay()}.csv`).type('text/csv')
      .send(lines.map((l) => l.map(csvCell).join(',')).join('\r\n'));
  });

  // Admin: add any number of stamps (e.g. a missed day), ignoring the daily limit.
  app.post('/api/admin/members/:code/stamps', requireAdmin, (req, res) => {
    const m = findMember(req.params.code);
    const count = Number(req.body?.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) throw httpError(400, 'Enter a number of stamps from 1 to 100.');
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 120) : '';
    const remove = req.body?.action === 'remove';
    (remove ? removeStamps : addStamps)(db, { userId: m.id, adminId: req.user.id, count, note });
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(m.id);
    res.json({
      [remove ? 'removed' : 'added']: count,
      member: { name: updated.name, memberCode: updated.member_code },
      card: cardSummary(db, updated),
    });
  });

  app.post('/api/admin/members/:code/undo-today', requireAdmin, (req, res) => {
    const m = findMember(req.params.code);
    undoTodayStamp(db, { userId: m.id, adminId: req.user.id });
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(m.id);
    res.json({ member: { name: updated.name, memberCode: updated.member_code }, card: cardSummary(db, updated) });
  });

  const registerUrl = (req) => `${req.protocol}://${req.get('host')}/s/${registerQr.getStampToken(db)}`;

  app.get('/api/staff/register-qr', requireStaff, (req, res) => {
    res.set('Cache-Control', 'no-store').json({ url: registerUrl(req) });
  });

  app.get('/api/staff/register-qr.svg', requireStaff, async (req, res, next) => {
    try {
      const svg = await QRCode.toString(registerUrl(req), {
        type: 'svg', margin: 1, errorCorrectionLevel: 'Q', color: { dark: '#2b1a12', light: '#ffffff' },
      });
      res.set('Cache-Control', 'no-store').type('image/svg+xml');
      if (req.query.download) res.attachment('engine-house-register-qr.svg');
      res.send(svg);
    } catch (err) { next(err); }
  });

  // High-resolution PNG for print shops, signs and screens.
  app.get('/api/staff/register-qr.png', requireStaff, async (req, res, next) => {
    try {
      const png = await QRCode.toBuffer(registerUrl(req), {
        type: 'png', width: 1200, margin: 2, errorCorrectionLevel: 'Q', color: { dark: '#2b1a12', light: '#ffffff' },
      });
      res.set('Cache-Control', 'no-store').attachment('engine-house-register-qr.png').type('image/png').send(png);
    } catch (err) { next(err); }
  });

  app.post('/api/staff/register-qr/rotate', requireStaff, (req, res) => {
    registerQr.rotateStampToken(db);
    res.json({ url: registerUrl(req) });
  });

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

  // Health check for the hosting platform: also confirms the database answers.
  app.get('/healthz', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });

  // ---- Static PWA ---------------------------------------------------------

  const pub = path.join(__dirname, '..', 'public');
  // Pure-JS QR reader for browsers without BarcodeDetector (iPhone Safari).
  app.get('/vendor/jsQR.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=86400').sendFile(require.resolve('jsqr/dist/jsQR.js'));
  });
  // The register sticker's link: open the app, which then collects the stamp.
  app.get('/s/:token', (_req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(path.join(pub, 'index.html'));
  });
  app.get('/sw.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache').sendFile(path.join(pub, 'sw.js'));
  });
  // Standalone sticker page: opens in the regular browser (printing is often
  // blocked inside installed home-screen apps), and works as an on-screen
  // display on a tablet at the register.
  app.get('/sticker.html', (_req, res) => res.redirect('/sticker'));
  app.get('/sticker', (req, res) => {
    if (req.user?.role !== 'staff') return res.redirect('/');
    res.set('Cache-Control', 'no-store').sendFile(path.join(pub, 'sticker.html'));
  });

  // App code must never be served stale: browsers revalidate on every load
  // (cheap, via ETag) so an update can't leave old JS running against new HTML.
  // Icons rarely change and can be cached.
  app.use(express.static(pub, {
    index: 'index.html',
    setHeaders(res, file) {
      res.setHeader('Cache-Control', /[\\/]icons[\\/]/.test(file) ? 'public, max-age=86400' : 'no-cache');
    },
  }));

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
