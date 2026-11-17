# Engine House Coffee — Rewards

A loyalty app with a digital stamp card. **Buy 7 coffees and your 8th is free.**

- **Secure sign-in.** Passwords are hashed with scrypt. Sessions are random tokens in `HttpOnly`, `SameSite=Strict` cookies (`Secure` in production), and only a hash of each token is stored. The app has CSRF protection, rate limits on sign-in, an account lockout after 5 failed attempts, a strict Content-Security-Policy and Helmet security headers. Changing your password signs out all other devices.
- **Stamp card.** It has 8 slots. Each paid coffee earns 1 stamp (1 point). Once 7 slots are filled, the next coffee is free and the card starts over. Group orders work too: recording 10 coffees correctly counts 7 paid, 1 free and 2 paid.
- **Lifetime tracking.** Lifetime points, total coffees and free coffees redeemed are kept forever, even as cards reset.
- **Downloads:**
  - **Install the app.** It's a Progressive Web App. Tap **⬇ Install app** in Chrome, Edge or Android, or use **Share → Add to Home Screen** on iPhone. It opens full-screen with its own icon.
  - **Download your history.** Customers can download their full loyalty statement as a CSV file.
- **Barista station.** Staff accounts get a different screen. They scan the customer's QR code with the camera (on supported browsers) or type the member code, then tap **Record coffee**. The app warns staff when a coffee is free so they don't charge for it. Customers can't add stamps to their own cards.

## Run it

Requires **Node.js 22.13+** (uses the built-in SQLite, so there's nothing native to compile).

```bash
npm install
npm start                # http://localhost:3000
```

Create a barista/staff account. You'll be asked for a password:

```bash
npm run create-staff -- --email barista@yourshop.com --name "Sam"
```

Running it with an existing customer's email promotes that account to staff.

Run the tests:

```bash
npm test
```

## Deploying

| Env var       | Purpose                                                             | Default              |
|---------------|---------------------------------------------------------------------|----------------------|
| `PORT`        | HTTP port                                                           | `3000`               |
| `DB_FILE`     | SQLite database path (put this on a persistent disk)                | `./data/loyalty.db`  |
| `NODE_ENV`    | Set to `production` to turn on `Secure` cookies and HSTS            | —                    |
| `TRUST_PROXY` | Set to `1` behind a load balancer or proxy that handles HTTPS       | —                    |

Serve it over **HTTPS** in production. Browsers only allow installing the app, and only send secure cookies, over HTTPS.

## Project layout

```
server/
  app.js        routes, sessions, security middleware
  loyalty.js    stamp-card rules (the 8th coffee is free)
  security.js   password hashing, tokens, member codes
  db.js         SQLite schema
  config.js     card size, session length, lockout settings
public/         installable web app (HTML/CSS/JS, service worker, manifest, icons)
scripts/        create-staff, build-icons
test/           API tests (node:test)
```

To change the reward, for example to make the 10th coffee free, edit `CARD_SIZE` in `server/config.js`.
