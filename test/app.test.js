'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const sec = require('../server/security');

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
  const r = await c(`/api/staff/members/${me.data.user.memberCode}/coffees`, { method: 'POST', body: { count: 7 } });
  assert.equal(r.status, 403);
});

test('stamp card: 7 paid coffees, the 8th is free, lifetime totals keep counting', async () => {
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

  let r;
  for (let i = 1; i <= 7; i++) {
    r = await staff(`/api/staff/members/${code}/coffees`, { method: 'POST', body: { count: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.data.card.currentStamps, i);
  }
  assert.equal(r.data.card.nextIsFree, true);

  // 8th coffee: free, card resets.
  r = await staff(`/api/staff/members/${code}/coffees`, { method: 'POST', body: { count: 1 } });
  assert.deepEqual(r.data.result, { stampsAdded: 0, freeCoffees: 1, currentStamps: 0 });
  assert.equal(r.data.card.lifetimePoints, 7);
  assert.equal(r.data.card.lifetimeCoffees, 8);
  assert.equal(r.data.card.freeRedeemed, 1);

  // A big group order spanning a free coffee: 10 coffees = 7 paid + 1 free + 2 paid.
  r = await staff(`/api/staff/members/${code}/coffees`, { method: 'POST', body: { count: 10 } });
  assert.deepEqual(r.data.result, { stampsAdded: 9, freeCoffees: 1, currentStamps: 2 });
  assert.equal(r.data.card.lifetimePoints, 16);
  assert.equal(r.data.card.lifetimeCoffees, 18);
  assert.equal(r.data.card.freeRedeemed, 2);

  const bad = await staff(`/api/staff/members/${code}/coffees`, { method: 'POST', body: { count: 0 } });
  assert.equal(bad.status, 400);

  // Customer sees history and can download it.
  const hist = await customer('/api/me/history');
  assert.equal(hist.data.history.length, 18);
  const csv = await customer('/api/me/history.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.match(csv.data, /Lifetime points,16/);
  assert.match(csv.data, /Free coffee redeemed/);
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
