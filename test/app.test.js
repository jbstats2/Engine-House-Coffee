'use strict';

delete process.env.SHOP_TIMEZONE; // test the built-in default (Eastern)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const sec = require('../server/security');
const { recordVisit, cardSummary, shopDay } = require('../server/loyalty');

let server;
let base;
let db;

before(async () => {
  db = openDb(':memory:');
  const app = createApp({ db });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  db.prepare(`INSERT INTO users (email, name, password_hash, role, member_code, created_at)
              VALUES ('barista@example.com', 'Sam', ?, 'staff', 'STAF-F222', ?)`)
    .run(sec.hashPassword('baristaPass123'), Date.now());
});

after(() => server.close());

function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'X-Requested-With': 'EngineHouseApp',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

test('passwords are hashed with scrypt and verified', () => {
  const h = sec.hashPassword('correct horse 1');
  assert.match(h, /^scrypt\$/);
  assert.ok(sec.verifyPassword('correct horse 1', h));
  assert.ok(!sec.verifyPassword('wrong horse 1', h));
});

test('register, session cookie is HttpOnly + SameSite=Strict', async () => {
  const c = client();
  const r = await c('/api/auth/register', { method: 'POST', body: { name: 'Ada', email: 'ada@example.com', password: 'espresso12345' } });
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const me = await c('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.name, 'Ada');
  assert.equal(me.data.card.currentStamps, 0);
  assert.equal(me.data.card.cardSize, 8);
  assert.equal(me.data.user.password_hash, undefined);
});

test('weak passwords and duplicate emails are rejected', async () => {
  const c = client();
  const weak = await c('/api/auth/register', { method: 'POST', body: { name: 'B', email: 'b@example.com', password: 'short' } });
  assert.equal(weak.status, 400);
  const dup = await c('/api/auth/register', { method: 'POST', body: { name: 'A', email: 'ADA@example.com', password: 'espresso12345' } });
  assert.equal(dup.status, 409);
});

test('state-changing requests without the app header are refused (CSRF)', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'espresso12345' }),
  });
  assert.equal(res.status, 403);
});

test('wrong password fails; account locks after repeated failures', async () => {
  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Lock', email: 'lock@example.com', password: 'lockme123456' } });
  const c2 = client();
  for (let i = 0; i < 5; i++) {
    const r = await c2('/api/auth/login', { method: 'POST', body: { email: 'lock@example.com', password: 'nope12345678' } });
    assert.equal(r.status, 401);
  }
  const locked = await c2('/api/auth/login', { method: 'POST', body: { email: 'lock@example.com', password: 'lockme123456' } });
  assert.equal(locked.status, 429);
});

test('customers cannot award themselves stamps', async () => {
  const c = client();
  await c('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'espresso12345' } });
  const me = await c('/api/me');
  const r = await c(`/api/staff/members/${me.data.user.memberCode}/visit`, { method: 'POST', body: {} });
  assert.equal(r.status, 403);
});

test('API: one stamp per day — a second stamp the same day is refused', async () => {
  const customer = client();
  await customer('/api/auth/register', { method: 'POST', body: { name: 'Grace', email: 'grace@example.com', password: 'latteArt2024' } });
  const code = (await customer('/api/me')).data.user.memberCode;

  const staff = client();
  const login = await staff('/api/auth/login', { method: 'POST', body: { email: 'barista@example.com', password: 'baristaPass123' } });
  assert.equal(login.status, 200);

  // Lookup is forgiving about case and dashes.
  const look = await staff(`/api/staff/members/${code.toLowerCase().replace('-', '')}`);
  assert.equal(look.status, 200);
  assert.equal(look.data.member.name, 'Grace');
  assert.equal(look.data.card.stampedToday, false);

  const first = await staff(`/api/staff/members/${code}/visit`, { method: 'POST', body: {} });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.result, { kind: 'stamp', currentStamps: 1 });
  assert.equal(first.data.card.stampedToday, true);

  const second = await staff(`/api/staff/members/${code}/visit`, { method: 'POST', body: {} });
  assert.equal(second.status, 409);
  assert.match(second.data.error, /Already stamped today/);

  const me = await customer('/api/me');
  assert.equal(me.data.card.currentStamps, 1);
  assert.equal(me.data.card.lifetimePoints, 1);
  assert.equal(me.data.card.stampedToday, true);

  const csv = await customer('/api/me/history.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.match(csv.data, /Lifetime points,1/);
  assert.match(csv.data, /Lifetime visits,1/);
});

test('stamp card over 9 days: 7 stamped days, 8th visit free, then a new card', () => {
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, name, password_hash, member_code, created_at)
    VALUES ('days@example.com', 'Days', 'x', 'DAYS-2222', ?)`).run(now);
  const userId = Number(lastInsertRowid);
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2026, 0, 5, 14); // 9am Eastern
  const user = () => db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  for (let d = 0; d < 7; d++) {
    const r = recordVisit(db, { userId, staffId: null, now: start + d * DAY });
    assert.deepEqual(r, { kind: 'stamp', currentStamps: d + 1 });
    // Ordering a second drink later the same day doesn't add another stamp.
    assert.throws(() => recordVisit(db, { userId, staffId: null, now: start + d * DAY + 3 * 60 * 60 * 1000 }), /Already stamped today/);
  }
  assert.equal(cardSummary(db, user(), start + 7 * DAY).nextIsFree, true);

  // Day 8: the coffee is free and the card starts over.
  assert.deepEqual(recordVisit(db, { userId, staffId: null, now: start + 7 * DAY }), { kind: 'free_coffee', currentStamps: 0 });
  // The same day as the free coffee, no stamp either.
  assert.throws(() => recordVisit(db, { userId, staffId: null, now: start + 7 * DAY + 60 * 1000 }), /Already stamped today/);
  // Day 9: first stamp on the new card.
  assert.deepEqual(recordVisit(db, { userId, staffId: null, now: start + 8 * DAY }), { kind: 'stamp', currentStamps: 1 });

  const card = cardSummary(db, user(), start + 8 * DAY);
  assert.equal(card.lifetimePoints, 8);
  assert.equal(card.lifetimeVisits, 9);
  assert.equal(card.freeRedeemed, 1);
});

test('a new day starts at 12am Eastern, not UTC', () => {
  // Winter (EST, UTC-5): 11:59pm Nov 16 vs 12:00am Nov 17 Eastern.
  assert.equal(shopDay(Date.UTC(2026, 10, 17, 4, 59)), '2026-11-16');
  assert.equal(shopDay(Date.UTC(2026, 10, 17, 5, 0)), '2026-11-17');
  // Summer (EDT, UTC-4): midnight moves with daylight saving time.
  assert.equal(shopDay(Date.UTC(2026, 6, 4, 3, 59)), '2026-07-03');
  assert.equal(shopDay(Date.UTC(2026, 6, 4, 4, 0)), '2026-07-04');
});

test('the database refuses a second stamp on the same day even if app checks are skipped', () => {
  const u = db.prepare("SELECT id FROM users WHERE email = 'days@example.com'").get();
  const day = db.prepare('SELECT day FROM transactions WHERE user_id = ? LIMIT 1').get(u.id).day;
  assert.throws(() => db.prepare("INSERT INTO transactions (user_id, kind, day, created_at) VALUES (?, 'stamp', ?, 0)").run(u.id, day), /UNIQUE/);
});

test('self-scan: customer scans the register QR for one stamp a day; sticker can be replaced', async () => {
  const staff = client();
  await staff('/api/auth/login', { method: 'POST', body: { email: 'barista@example.com', password: 'baristaPass123' } });
  const { data: { url } } = await staff('/api/staff/register-qr');
  assert.match(url, /\/s\/[A-Za-z0-9_-]{20,}$/);
  const token = url.split('/s/')[1];
  const svg = await staff('/api/staff/register-qr.svg');
  assert.match(svg.data, /<svg/);

  // The sticker link opens the app.
  const page = await fetch(`${base}/s/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<!DOCTYPE html>/);

  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Scan Fan', email: 'scan@example.com', password: 'coldbrew2026' } });

  // Must be signed in.
  const anon = await client()('/api/stamp', { method: 'POST', body: { token } });
  assert.equal(anon.status, 401);
  // Wrong code is refused.
  const bad = await c('/api/stamp', { method: 'POST', body: { token: 'not-the-real-code' } });
  assert.equal(bad.status, 400);
  // Staff can't stamp themselves.
  assert.equal((await staff('/api/stamp', { method: 'POST', body: { token } })).status, 403);

  const ok = await c('/api/stamp', { method: 'POST', body: { token } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.result, { kind: 'stamp', currentStamps: 1 });
  assert.equal(ok.data.card.stampedToday, true);
  assert.equal(ok.data.card.voucher, null);

  // Second scan the same day is refused.
  const again = await c('/api/stamp', { method: 'POST', body: { token } });
  assert.equal(again.status, 409);

  // Replacing the sticker invalidates the old code.
  const { data: rotated } = await staff('/api/staff/register-qr/rotate', { method: 'POST' });
  assert.notEqual(rotated.url, url);
  const c2 = client();
  await c2('/api/auth/register', { method: 'POST', body: { name: 'Late', email: 'late@example.com', password: 'mocha123456' } });
  assert.equal((await c2('/api/stamp', { method: 'POST', body: { token } })).status, 400);
  const fresh = await c2('/api/stamp', { method: 'POST', body: { token: rotated.url.split('/s/')[1] } });
  assert.equal(fresh.status, 200);

  // Printable sticker page and PNG for staff.
  const sticker = await staff('/sticker');
  assert.equal(sticker.status, 200);
  assert.match(sticker.data, /Scan for your daily stamp/);
  const png = await staff('/api/staff/register-qr.png');
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.match(png.headers.get('content-disposition'), /attachment/);

  // App code is always revalidated, so updates can't leave stale JS running.
  assert.equal((await fetch(`${base}/app.js`)).headers.get('cache-control'), 'no-cache');
  assert.match((await fetch(`${base}/icons/icon.svg`)).headers.get('cache-control'), /max-age=86400/);

  // Customers can't fetch or replace the sticker.
  assert.equal((await fetch(`${base}/sticker`, { redirect: 'manual' })).status, 302);
  assert.equal((await c('/api/staff/register-qr.png')).status, 403);
  assert.equal((await c('/api/staff/register-qr')).status, 403);
  assert.equal((await c('/api/staff/register-qr/rotate', { method: 'POST' })).status, 403);
});

test('self-scan with a full card redeems the free coffee and returns a voucher', async () => {
  const staff = client();
  await staff('/api/auth/login', { method: 'POST', body: { email: 'barista@example.com', password: 'baristaPass123' } });
  const token = (await staff('/api/staff/register-qr')).data.url.split('/s/')[1];

  const c = client();
  await c('/api/auth/register', { method: 'POST', body: { name: 'Full Card', email: 'full@example.com', password: 'cortado12345' } });
  db.prepare("UPDATE users SET current_stamps = 7 WHERE email = 'full@example.com'").run();

  const r = await c('/api/stamp', { method: 'POST', body: { token } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.result, { kind: 'free_coffee', currentStamps: 0 });
  assert.ok(r.data.card.voucher);
  assert.equal(r.data.card.voucher.expiresAt - r.data.card.voucher.redeemedAt, 30 * 60 * 1000);
  // Voucher is still visible on reopening the app.
  assert.ok((await c('/api/me')).data.card.voucher);
});

test('logout invalidates the session server-side', async () => {
  const c = client();
  await c('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'espresso12345' } });
  assert.equal((await c('/api/me')).status, 200);
  await c('/api/auth/logout', { method: 'POST' });
  assert.equal((await c('/api/me')).status, 401);
});

test('QR code and static app shell are served', async () => {
  const c = client();
  await c('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'espresso12345' } });
  const qr = await c('/api/me/qr.svg');
  assert.equal(qr.status, 200);
  assert.match(qr.data, /<svg/);
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  const home = await fetch(`${base}/`);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
});
