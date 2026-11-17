'use strict';

(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  // ---------- helpers ----------

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'EngineHouseApp',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }

  let toastTimer;
  function toast(msg, kind = '') {
    toastEl.textContent = msg;
    toastEl.className = `toast ${kind}`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  function mount(tplId) {
    app.replaceChildren(document.getElementById(tplId).content.cloneNode(true));
  }

  const $ = (sel, root = app) => root.querySelector(sel);
  const bind = (name, root = app) => root.querySelector(`[data-bind="${name}"]`);

  function showError(form, err) {
    const el = form.querySelector('.form-error');
    el.textContent = err ? err.message || String(err) : '';
    el.hidden = !err;
  }

  async function withBusy(form, fn) {
    const btns = [...form.querySelectorAll('button[type="submit"]')];
    btns.forEach((b) => { b.disabled = true; });
    showError(form, null);
    try { await fn(); } catch (err) { showError(form, err); } finally { btns.forEach((b) => { b.disabled = !!b.dataset.done; }); }
  }

  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const fmtDateTime = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const CUP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 8h13v5a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V8Zm13 1h1.5a3 3 0 0 1 0 6H16v-2h1.5a1 1 0 0 0 0-2H16V9ZM2 20h16v1.5H2V20ZM7 2.5c.8.9.8 1.9 0 2.8M10 2c.8.9.8 2.3 0 3.3M13 2.5c.8.9.8 1.9 0 2.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill-rule="evenodd"/></svg>';

  function renderStamps(list, card) {
    list.replaceChildren();
    for (let i = 0; i < card.cardSize; i++) {
      const li = document.createElement('li');
      const isFreeSlot = i === card.cardSize - 1;
      li.className = 'stamp';
      if (isFreeSlot) {
        li.classList.add('free');
        if (card.nextIsFree) li.classList.add('ready');
        li.innerHTML = CUP_SVG;
        const lbl = document.createElement('span');
        lbl.className = 'free-label';
        lbl.textContent = 'FREE';
        li.append(lbl);
        li.setAttribute('aria-label', card.nextIsFree ? 'Free coffee ready' : 'Free coffee slot');
      } else if (i < card.currentStamps) {
        li.classList.add('filled');
        li.innerHTML = CUP_SVG;
        li.setAttribute('aria-label', `Stamp ${i + 1} collected`);
      } else {
        li.textContent = String(i + 1);
        li.setAttribute('aria-label', `Stamp ${i + 1} empty`);
      }
      list.append(li);
    }
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function statusText(card) {
    if (card.nextIsFree) {
      return card.stampedToday
        ? '🎉 Card full! Your free coffee is ready on your next visit.'
        : '🎉 Your coffee today is FREE!';
    }
    if (card.todayKind === 'free_coffee') {
      return '☕ Enjoy your free coffee! Your new card starts on your next visit.';
    }
    const left = `${plural(card.visitsUntilFree, 'more visit')} until a free coffee.`;
    return card.stampedToday ? `✅ Today's stamp collected — ${left}` : left;
  }

  // ---------- auth view ----------

  function renderAuth() {
    mount('tpl-auth');
    if (sessionStorage.getItem(PENDING_KEY)) {
      const note = document.createElement('p');
      note.className = 'status free';
      note.textContent = "☕ Sign in or create an account to collect today's stamp.";
      $('.auth h1').after(note);
    }
    const loginForm = $('#login-form');
    const regForm = $('#register-form');

    app.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        app.querySelectorAll('.tab').forEach((t) => {
          const active = t === tab;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', String(active));
        });
        loginForm.hidden = tab.dataset.tab !== 'login';
        regForm.hidden = tab.dataset.tab !== 'register';
      });
    });

    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(loginForm);
      withBusy(loginForm, async () => {
        await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
        await route();
      });
    });

    regForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(regForm);
      withBusy(regForm, async () => {
        await api('/api/auth/register', {
          method: 'POST', body: { name: f.get('name'), email: f.get('email'), password: f.get('password') },
        });
        toast('Welcome! Your stamp card is ready.', 'ok');
        await route();
      });
    });
  }

  // ---------- camera QR scanner (shared) ----------

  let jsQRLoading = null;
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    jsQRLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/jsQR.js';
      s.onload = () => resolve(window.jsQR);
      s.onerror = reject;
      document.head.append(s);
    });
    return jsQRLoading;
  }

  const canScan = () => !!navigator.mediaDevices?.getUserMedia;

  /**
   * Opens the camera inside `scannerEl` and calls onCode(text) with the first
   * QR code found. Uses the built-in BarcodeDetector where available
   * (Chrome/Android) and the jsQR library otherwise (iPhone Safari).
   * Returns a stop() function.
   */
  async function startScanner(scannerEl, onCode) {
    const video = scannerEl.querySelector('video');
    const finder = scannerEl.querySelector('.viewfinder');
    const label = scannerEl.querySelector('.viewfinder-label');
    // iOS Safari only shows a live camera preview for inline, muted video.
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('autoplay', '');

    let stream = null;
    let raf = 0;
    let done = false;
    const stop = () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
      finder.classList.remove('live', 'found');
      scannerEl.hidden = true;
    };

    let detect;
    if ('BarcodeDetector' in window) {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      detect = async () => (await detector.detect(video))[0]?.rawValue;
    } else {
      const jsQR = await loadJsQR();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      detect = async () => {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return null;
        const scale = Math.min(1, 640 / Math.max(w, h));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data;
      };
    }

    // Show the viewfinder *before* starting the camera: iOS won't paint a
    // video that began playing while hidden.
    finder.classList.remove('live', 'found');
    label.textContent = 'Starting camera…';
    scannerEl.hidden = false;
    scannerEl.scrollIntoView({ block: 'center', behavior: 'smooth' });

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      stop();
      throw err;
    }
    finder.classList.add('live');
    label.textContent = 'Point at the QR code';

    const tick = async () => {
      if (done) return;
      try {
        const value = await detect();
        if (value && !done) {
          // Freeze on the frame with a check mark so it's clear what happened.
          done = true;
          video.pause();
          finder.classList.add('found');
          label.textContent = '✓ Got it';
          navigator.vibrate?.(60);
          setTimeout(() => { stop(); onCode(value); }, 700);
          return;
        }
      } catch { /* frame not ready yet */ }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return stop;
  }

  // ---------- self-service stamp ----------

  const PENDING_KEY = 'ehc_pending_stamp';

  /** Pull the token out of a scanned register link ( …/s/<token> ). */
  function tokenFromScan(text) {
    try {
      const url = new URL(text);
      const m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{10,100})$/);
      if (m && url.origin === location.origin) return m[1];
    } catch { /* not a URL */ }
    return null;
  }

  // Opened from the phone's camera app via the sticker link: remember the
  // token (survives signing in), then tidy the address bar.
  {
    const m = location.pathname.match(/^\/s\/([A-Za-z0-9_-]{10,100})$/);
    if (m) {
      sessionStorage.setItem(PENDING_KEY, m[1]);
      history.replaceState(null, '', '/');
    }
  }

  // ---------- free coffee voucher ----------

  let voucherTimer = 0;
  function showVoucher(name, voucher) {
    closeVoucher();
    if (!voucher || voucher.expiresAt <= Date.now()) return;
    document.body.append(document.getElementById('tpl-voucher').content.cloneNode(true));
    const el = document.querySelector('.voucher');
    bind('voucherName', el).textContent = name;
    const t = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    bind('voucherMeta', el).textContent = `Redeemed ${t(voucher.redeemedAt)} · valid until ${t(voucher.expiresAt)}`;
    const clock = bind('voucherClock', el);
    const tickClock = () => {
      if (Date.now() >= voucher.expiresAt) { closeVoucher(); return; }
      // A live clock makes a screenshot easy for the barista to spot.
      clock.textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    };
    tickClock();
    voucherTimer = setInterval(tickClock, 1000);
    el.querySelector('[data-action="close-voucher"]').addEventListener('click', closeVoucher);
  }
  function closeVoucher() {
    clearInterval(voucherTimer);
    document.querySelector('.voucher')?.remove();
  }

  // ---------- customer view ----------

  async function renderCustomer(me) {
    mount('tpl-customer');
    let current = me;
    fillCustomer(me);
    bind('qr').src = '/api/me/qr.svg';
    bind('code').textContent = me.user.memberCode;
    bind('since').textContent = fmtDate(me.user.memberSince);
    wireCommon();

    const pwForm = $('#password-form');
    pwForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(pwForm);
      withBusy(pwForm, async () => {
        await api('/api/auth/password', {
          method: 'POST', body: { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') },
        });
        pwForm.reset();
        toast('Password changed. Other devices have been signed out.', 'ok');
      });
    });

    async function collectStamp(token) {
      try {
        const data = await api('/api/stamp', { method: 'POST', body: { token } });
        current = { ...current, card: data.card };
        fillCustomer(current);
        loadHistory();
        if (data.result.kind === 'free_coffee') {
          showVoucher(current.user.name, data.card.voucher);
        } else {
          const left = data.card.visitsUntilFree;
          toast(left === 0 ? '🎉 Stamp collected! Your next visit is FREE.' : `✅ Stamp collected! ${plural(left, 'more visit')} to a free coffee.`, 'ok');
        }
      } catch (err) {
        if (err.status === 409) toast("You've already collected today's stamp — see you tomorrow!", 'err');
        else toast(err.message, 'err');
        if (err.status === 401) route();
      }
    }

    // Scan the register sticker from inside the app.
    const scanBtn = $('[data-action="scan-register"]');
    const scannerEl = $('.scanner');
    let stopScan = null;
    if (!canScan()) scanBtn.hidden = true;
    scanBtn.addEventListener('click', async () => {
      scanBtn.hidden = true;
      try {
        stopScan = await startScanner(scannerEl, (text) => {
          scanBtn.hidden = false;
          const token = tokenFromScan(text);
          if (token) collectStamp(token);
          else toast("That's not the Engine House register code. Look for the sticker by the register.", 'err');
        });
      } catch {
        scanBtn.hidden = false;
        toast("Couldn't open the camera. Allow camera access, or scan the sticker with your phone's camera app.", 'err');
      }
    });
    $('[data-action="stop-scan"]').addEventListener('click', () => { stopScan?.(); scanBtn.hidden = false; });
    $('[data-action="show-voucher"]').addEventListener('click', () => showVoucher(current.user.name, current.card.voucher));

    // Arrived via the sticker link (phone camera app).
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (pending) {
      sessionStorage.removeItem(PENDING_KEY);
      collectStamp(pending);
    }

    await loadHistory();

    // Keep the card fresh when the app comes back to the foreground.
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || !bind('stamps')) return;
      try {
        current = await api('/api/me');
        fillCustomer(current);
      } catch (err) { if (err.status === 401) route(); }
    };
    document.removeEventListener('visibilitychange', window.__ehcRefresh || (() => {}));
    window.__ehcRefresh = refresh;
    document.addEventListener('visibilitychange', refresh);
    clearInterval(window.__ehcPoll);
    window.__ehcPoll = setInterval(refresh, 30000);
  }

  function fillCustomer(me) {
    const { card } = me;
    bind('name').textContent = me.user.name.split(' ')[0];
    const status = bind('status');
    status.textContent = statusText(card);
    status.classList.toggle('free', card.nextIsFree);
    bind('progress').textContent = `${card.currentStamps} / ${card.cardSize - 1} stamps${card.extraStamps ? ` +${card.extraStamps} extra` : ''}`;
    renderStamps(bind('stamps'), card);
    bind('lifetimePoints').textContent = card.lifetimePoints.toLocaleString();
    bind('lifetimeVisits').textContent = card.lifetimeVisits.toLocaleString();
    bind('freeRedeemed').textContent = card.freeRedeemed.toLocaleString();

    const scanBtn = $('[data-action="scan-register"]');
    if (scanBtn && canScan()) {
      scanBtn.disabled = card.stampedToday;
      scanBtn.textContent = card.stampedToday
        ? "✅ Today's stamp collected"
        : card.nextIsFree ? '📷 Scan to get your FREE coffee' : '📷 Scan the register code';
    }
    const vBtn = $('[data-action="show-voucher"]');
    if (vBtn) vBtn.hidden = !(card.voucher && card.voucher.expiresAt > Date.now());
  }

  async function loadHistory() {
    const list = bind('history');
    if (!list) return;
    const { history } = await api('/api/me/history');
    list.replaceChildren();
    if (!history.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No visits yet — scan the register code on your next visit!';
      list.append(li);
      return;
    }
    for (const h of history.slice(0, 15)) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      const when = document.createElement('span');
      what.textContent = h.kind === 'free_coffee' ? '☕ Free coffee redeemed'
        : h.kind === 'adjustment'
          ? (h.stamps > 0
            ? `🎁 +${plural(h.stamps, 'stamp')} from Engine House`
            : `↩︎ −${plural(-h.stamps, 'stamp')} removed by Engine House`) + (h.note ? ` — ${h.note}` : '')
          : '+1 stamp';
      if (h.kind !== 'stamp') what.className = 'free-row';
      when.className = 'when';
      when.textContent = fmtDateTime(h.at);
      li.append(what, when);
      list.append(li);
    }
  }

  // ---------- staff view ----------

  function renderStaff(me) {
    mount('tpl-staff');
    bind('name').textContent = me.user.name;
    wireCommon();
    app.dataset.tab = 'station';
    if (me.user.isAdmin) setupMembersTab();

    // Someone opened the sticker link while signed in as staff.
    if (sessionStorage.getItem(PENDING_KEY)) {
      sessionStorage.removeItem(PENDING_KEY);
      toast("That's the register code ✓ — customers scan it from their own account.", 'ok');
    }

    // ----- Members database (admin) -----
    function setupMembersTab() {
      const tabs = bind('staffTabs');
      tabs.hidden = false;
      let members = [];
      const showTab = (name) => {
        app.dataset.tab = name;
        tabs.querySelectorAll('.tab').forEach((t) => {
          const on = t.dataset.tab === name;
          t.classList.toggle('active', on);
          t.setAttribute('aria-selected', String(on));
        });
        if (name === 'members') loadMembers();
        window.scrollTo({ top: 0 });
      };
      tabs.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

      async function loadMembers() {
        try {
          const data = await api('/api/admin/members');
          members = data.members;
          const sm = data.summary;
          bind('sumMembers').textContent = sm.members.toLocaleString();
          bind('sumNew').textContent = sm.newThisWeek.toLocaleString();
          bind('sumToday').textContent = sm.visitsToday.toLocaleString();
          bind('sumFree').textContent = sm.freeCoffees.toLocaleString();
          renderMembers();
        } catch (err) { toast(err.message, 'err'); }
      }

      const sorters = {
        joined: (a, b) => b.joined - a.joined,
        lastVisit: (a, b) => (b.lastVisit || 0) - (a.lastVisit || 0),
        lifetimeVisits: (a, b) => b.lifetimeVisits - a.lifetimeVisits,
        name: (a, b) => a.name.localeCompare(b.name),
        closest: (a, b) => (b.currentStamps + b.extraStamps) - (a.currentStamps + a.extraStamps),
      };

      function renderMembers() {
        const q = bind('memberSearch').value.trim().toLowerCase();
        const qCode = q.replace(/[^a-z0-9]/g, '');
        const list = members
          .filter((m) => !q || m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
            || (qCode && m.memberCode.toLowerCase().replace('-', '').includes(qCode)))
          .sort(sorters[bind('memberSort').value] || sorters.joined);

        bind('membersCount').textContent = q
          ? `${list.length} ${list.length === 1 ? 'match' : 'matches'} of ${members.length}`
          : `${plural(members.length, 'member')} · tap one to adjust their stamps`;
        const ul = bind('membersList');
        ul.replaceChildren();
        if (!list.length) {
          const li = document.createElement('li');
          li.className = 'empty';
          li.textContent = members.length ? 'No members match that search.' : 'No one has signed up yet.';
          ul.append(li);
          return;
        }
        const frag = document.createDocumentFragment();
        for (const m of list.slice(0, 500)) {
          const li = document.createElement('li');
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'member-row';
          const span = (cls, text) => { const e = document.createElement('span'); e.className = cls; e.textContent = text; return e; };
          const meta = span('m-meta', '');
          const dots = document.createElement('span');
          dots.className = 'm-dots';
          dots.setAttribute('aria-hidden', 'true');
          for (let i = 0; i < 7; i++) {
            const d = document.createElement('i');
            if (i < m.currentStamps) d.className = m.currentStamps >= 7 ? 'on free' : 'on';
            dots.append(d);
          }
          meta.append(dots, document.createTextNode(
            `${m.currentStamps}/7${m.extraStamps ? ` +${m.extraStamps}` : ''} · ${plural(m.lifetimePoints, 'pt')} · ${plural(m.lifetimeVisits, 'visit')} · ${m.freeRedeemed} free`
            + ` · joined ${fmtDate(m.joined)}${m.lastVisit ? ` · last ${fmtDate(m.lastVisit)}` : ' · no visits yet'}`,
          ));
          row.append(span('m-name', m.name), span('m-code', m.memberCode), span('m-email', m.email), meta);
          row.addEventListener('click', () => {
            showTab('station');
            lookupForm.code.value = m.memberCode;
            lookup(m.memberCode).then(() => bind('memberPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }));
          });
          li.append(row);
          frag.append(li);
        }
        ul.append(frag);
        if (list.length > 500) {
          const li = document.createElement('li');
          li.className = 'empty';
          li.textContent = `Showing the first 500 — search to narrow it down, or download the CSV for everyone.`;
          ul.append(li);
        }
      }
      bind('memberSearch').addEventListener('input', renderMembers);
      bind('memberSort').addEventListener('change', renderMembers);
    }

    // Register sticker
    const loadSign = () => { bind('registerQr').src = `/api/staff/register-qr.svg?t=${Date.now()}`; };
    loadSign();
    $('[data-action="print-sign"]').addEventListener('click', () => {
      document.body.classList.add('printing-sign');
      window.print();
    });
    window.addEventListener('afterprint', () => document.body.classList.remove('printing-sign'));
    $('[data-action="rotate-sign"]').addEventListener('click', async () => {
      if (!confirm('Make a new register code? The sticker currently at the register will stop working right away.')) return;
      try {
        await api('/api/staff/register-qr/rotate', { method: 'POST' });
        loadSign();
        toast('New code ready — print it and replace the old sticker.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    });

    // Manual stamp (backup)
    const lookupForm = $('#lookup-form');
    const stampForm = $('#stamp-form');
    const lookupErr = bind('lookupError');
    const adjustForm = $('#adjust-form');
    const removeBtn = adjustForm.querySelector('button[value="remove"]');
    const undoBtn = $('[data-action="undo-today"]');
    let currentCode = null;

    function showMember(data) {
      currentCode = data.member.memberCode;
      bind('memberPanel').hidden = false;
      bind('memberName').textContent = data.member.name;
      bind('memberCode').textContent = data.member.memberCode;
      renderStamps(bind('stamps'), data.card);
      const { card } = data;
      const s = bind('status');
      const btn = stampForm.querySelector('button[type="submit"]');
      if (card.stampedToday) {
        s.textContent = card.todayKind === 'free_coffee'
          ? '☕ Free coffee redeemed today · new card starts next visit'
          : card.nextIsFree
            ? '✅ Stamped today. Card is full — free coffee on their next visit.'
            : `✅ Already stamped today · ${plural(card.currentStamps, 'stamp')} · ${card.visitsUntilFree} visits until free`;
        btn.textContent = 'Already stamped today';
      } else if (card.nextIsFree) {
        s.textContent = "🎉 Card is full — today's coffee is FREE!";
        btn.textContent = 'Redeem FREE coffee';
      } else {
        s.textContent = `${plural(card.currentStamps, 'stamp')} · ${card.visitsUntilFree} visits until free · ${card.lifetimePoints} lifetime pts`;
        btn.textContent = "Add today's stamp";
      }
      if (card.extraStamps) s.textContent += ` · +${card.extraStamps} extra carry over`;
      s.classList.toggle('free', card.nextIsFree && !card.stampedToday);
      btn.dataset.done = card.stampedToday ? '1' : '';
      btn.disabled = card.stampedToday;
      undoBtn.hidden = !(me.user.isAdmin && card.todayKind === 'stamp');
      removeBtn.dataset.done = card.currentStamps + card.extraStamps === 0 ? '1' : '';
      removeBtn.disabled = !!removeBtn.dataset.done;
    }

    async function lookup(code) {
      lookupErr.hidden = true;
      try {
        showMember(await api(`/api/staff/members/${encodeURIComponent(code)}`));
      } catch (err) {
        bind('memberPanel').hidden = true;
        lookupErr.textContent = err.message;
        lookupErr.hidden = false;
      }
    }

    adjustForm.hidden = !me.user.isAdmin;
    // Track which button was tapped (e.submitter isn't available on older iPhones).
    let adjustAction = null;
    adjustForm.querySelectorAll('button[type="submit"]').forEach((b) => {
      b.addEventListener('click', () => { adjustAction = b.value; });
    });
    adjustForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!currentCode) return;
      const action = e.submitter?.value || adjustAction;
      adjustAction = null;
      if (action !== 'add' && action !== 'remove') return; // e.g. Enter pressed in a field: do nothing
      const count = Number(adjustForm.count.value);
      const name = bind('memberName').textContent;
      withBusy(adjustForm, async () => {
        if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('Enter a number of stamps from 1 to 100.');
        if (action === 'remove' && !confirm(`Remove ${plural(count, 'stamp')} from ${name}'s card?`)) return;
        if (action === 'add' && count >= 10 && !confirm(`Add ${count} stamps to ${name}'s card?`)) return;
        const data = await api(`/api/admin/members/${encodeURIComponent(currentCode)}/stamps`, {
          method: 'POST', body: { count, note: adjustForm.note.value, action },
        });
        showMember(data);
        adjustForm.reset();
        toast(action === 'remove'
          ? `Removed ${plural(data.removed, 'stamp')} from ${data.member.name}'s card`
          : `Added ${plural(data.added, 'stamp')} to ${data.member.name}'s card`, 'ok');
      });
    });

    undoBtn.addEventListener('click', async () => {
      if (!currentCode) return;
      if (!confirm(`Undo today's stamp for ${bind('memberName').textContent}? They'll be able to collect it again today.`)) return;
      undoBtn.disabled = true;
      try {
        const data = await api(`/api/admin/members/${encodeURIComponent(currentCode)}/undo-today`, { method: 'POST' });
        showMember(data);
        toast(`Undid today's stamp for ${data.member.name}`, 'ok');
      } catch (err) {
        showError(adjustForm, err);
      } finally {
        undoBtn.disabled = false;
      }
    });

    lookupForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = lookupForm.code.value.trim();
      showError(stampForm, null);
      showError(adjustForm, null);
      if (code) lookup(code);
    });

    stampForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!currentCode) return;
      withBusy(stampForm, async () => {
        try {
          const data = await api(`/api/staff/members/${encodeURIComponent(currentCode)}/visit`, { method: 'POST', body: {} });
          showMember(data);
          toast(data.result.kind === 'free_coffee'
            ? "FREE coffee redeemed — don't charge for one drink!"
            : "Today's stamp added", 'ok');
        } catch (err) {
          // e.g. the customer scanned the sticker a moment ago — show the latest card.
          if (err.status === 409) lookup(currentCode);
          throw err;
        }
      });
    });

    if (canScan()) {
      const scanBtn = $('[data-action="scan"]');
      const scannerEl = $('.scanner');
      let stopScan = null;
      scanBtn.hidden = false;
      scanBtn.addEventListener('click', async () => {
        scanBtn.hidden = true;
        try {
          stopScan = await startScanner(scannerEl, (value) => {
            scanBtn.hidden = false;
            lookupForm.code.value = value;
            lookup(value);
          });
        } catch {
          scanBtn.hidden = false;
          toast('Camera unavailable — type the member code instead.', 'err');
        }
      });
      $('[data-action="stop-scan"]').addEventListener('click', () => { stopScan?.(); scanBtn.hidden = false; });
    }
  }

  function wireCommon() {
    app.querySelectorAll('[data-action="logout"]').forEach((b) => b.addEventListener('click', async () => {
      clearInterval(window.__ehcPoll);
      closeVoucher();
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      renderAuth();
    }));
  }

  // ---------- routing ----------

  async function route() {
    try {
      const me = await api('/api/me');
      if (me.user.role === 'staff') renderStaff(me);
      else await renderCustomer(me);
    } catch (err) {
      clearInterval(window.__ehcPoll);
      if (err.status === 401) renderAuth();
      else {
        app.innerHTML = '<section class="panel"><p>Can\'t reach Engine House right now. Check your connection and try again.</p><button class="btn" data-action="retry">Retry</button></section>';
        $('[data-action="retry"]').addEventListener('click', route);
      }
    }
  }

  // ---------- install (download) the app ----------

  const installBtn = document.getElementById('install-btn');
  let deferredPrompt = null;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    installBtn.hidden = true;
    toast('Engine House installed on your device!', 'ok');
  });
  if (isIOS && !isStandalone) installBtn.hidden = false;

  installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
    } else if (isIOS) {
      document.querySelector('.sheet')?.remove();
      document.body.append(document.getElementById('tpl-ios-install').content.cloneNode(true));
      document.querySelector('[data-action="close-sheet"]').addEventListener('click', () => {
        document.querySelector('.sheet').remove();
      });
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {}));
    // When a new version takes over, reload once so the page and code match.
    if (navigator.serviceWorker.controller) {
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
    }
  }

  route();
})();
