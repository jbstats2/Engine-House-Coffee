'use strict';

const path = require('node:path');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'loyalty.db');

const db = openDb(DB_FILE);
const app = createApp({
  db,
  // Set TRUST_PROXY=1 when running behind a reverse proxy / load balancer
  // that terminates HTTPS (Render, Fly, Heroku, nginx...).
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
});

app.listen(PORT, () => {
  console.log(`Engine House Coffee loyalty app running on http://localhost:${PORT}`);
});
