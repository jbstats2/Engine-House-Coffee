# Engine House Coffee — Rewards

A loyalty app with a digital stamp card. **Get one stamp per day you visit. After 7 stamps, your 8th visit's coffee is free.**

- **Secure sign-in.** Passwords are hashed with scrypt. Sessions are random tokens in `HttpOnly`, `SameSite=Strict` cookies (`Secure` in production), and only a hash of each token is stored. The app has CSRF protection, rate limits on sign-in, an account lockout after 5 failed attempts, a strict Content-Security-Policy and Helmet security headers. Changing your password signs out all other devices.
- **Stamp card, one stamp per day.** The card has 8 slots. A customer earns at most **one stamp per calendar day**, however many drinks they buy, so a drip coffee and a latte earn the same. Each stamp is 1 point. Once 7 slots are filled, the coffee on the next visit (on a later day) is free and the card starts over. The free coffee is that day's card action, so it doesn't also earn a stamp.
  - A new day starts at **12:00am Eastern Time**. You can change this with `SHOP_TIMEZONE`.
  - The database also enforces the limit, so two baristas tapping at the same moment can't double-stamp a customer.
- **Lifetime tracking.** Lifetime points, total visits and free coffees redeemed are kept forever, even as cards reset.
- **Downloads:**
  - **Install the app.** It's a Progressive Web App. Tap **⬇ Install app** in Chrome, Edge or Android, or use **Share → Add to Home Screen** on iPhone. It opens full-screen with its own icon.
  - **Download your history.** Customers can download their full loyalty statement as a CSV file.
- **Self-service stamps (no staff needed).** Print the **register QR sticker** from the staff screen and stick it by the register. Customers scan it with the app's **Scan the register code** button (or their phone camera) to collect their stamp, once per day.
  - When their card is full, the scan turns their phone into a live **FREE COFFEE voucher** with a ticking clock, so screenshots are easy to spot. The barista just doesn't charge for one drink.
  - If a photo of the sticker gets shared, tap **Replace sticker** on the staff screen. The old code stops working immediately; print the new one.
- **Barista station (backup).** Staff accounts get a different screen. They scan the customer's QR code with the camera (on supported browsers) or type the member code, then tap **Add today's stamp**. This is for customers who can't scan. When a card is full, the button changes to **Redeem FREE coffee** so staff know not to charge. Once a customer has been stamped that day, the button greys out. Customers can't add stamps to their own cards.

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

### On Render (recommended)

This repo includes a `render.yaml` blueprint. It sets up the web service, HTTPS and a persistent disk for the database.

1. Sign in at [render.com](https://render.com) with GitHub.
2. Click **New → Blueprint** and choose this repository.
3. Fill in the three values it asks for:
   - `STAFF_EMAIL`: your barista/owner login.
   - `STAFF_PASSWORD`: at least 10 characters, with letters and numbers.
   - `STAFF_NAME`: the name shown on the barista screen.
4. Click **Apply**. A few minutes later the app is live at `https://engine-house-coffee.onrender.com` (or similar).
5. Sign in with the staff email to reach the barista station. Customers sign up at the same address and can tap **Install app**.

The staff account is created on first start only. Later restarts never change it, so you can change its password in the app afterwards. To add more baristas, have them sign up as customers, then use Render's **Shell** tab to run `npm run create-staff -- --email them@example.com`.

The blueprint uses Render's paid **Starter** instance because the database needs a persistent disk. On a free instance, all accounts and stamps would be erased whenever the app restarts.

To use your own domain (e.g. `rewards.enginehousecoffee.com`), go to **Settings → Custom Domains** in Render.

### Anywhere else

Any host that runs Node 22.13+ works if it gives the app a persistent disk for `DB_FILE` and serves it over HTTPS.

| Env var       | Purpose                                                             | Default              |
|---------------|---------------------------------------------------------------------|----------------------|
| `PORT`        | HTTP port                                                           | `3000`               |
| `DB_FILE`     | SQLite database path (put this on a persistent disk)                | `./data/loyalty.db`  |
| `NODE_ENV`    | Set to `production` to turn on `Secure` cookies and HSTS            | —                    |
| `TRUST_PROXY` | Set to `1` behind a load balancer or proxy that handles HTTPS       | —                    |
| `SHOP_TIMEZONE` | Time zone used to decide when a new day starts (at midnight) | `America/New_York` (Eastern) |
| `STAFF_EMAIL` / `STAFF_PASSWORD` / `STAFF_NAME` | Creates the first staff account on startup if it doesn't exist | — |

Serve it over **HTTPS** in production. Browsers only allow installing the app, and only send secure cookies, over HTTPS.

## Project layout

```
server/
  app.js        routes, sessions, security middleware
  loyalty.js    stamp-card rules (one stamp per day, the 8th visit is free)
  security.js   password hashing, tokens, member codes
  db.js         SQLite schema
  config.js     card size, session length, lockout settings
public/         installable web app (HTML/CSS/JS, service worker, manifest, icons)
scripts/        create-staff, build-icons
test/           API tests (node:test)
```

To change the reward, for example to make the 10th coffee free, edit `CARD_SIZE` in `server/config.js`.
