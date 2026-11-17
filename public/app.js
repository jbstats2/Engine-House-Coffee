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
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    showError(form, null);
    try { await fn(); } catch (err) { showError(form, err); } finally { btn.disabled = !!btn.dataset.done; }
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
    if (card.stampedToday && card.currentStamps === 0) {
      return '☕ Enjoy your free coffee! Your new card starts on your next visit.';
    }
    const left = `${plural(card.visitsUntilFree, 'more visit')} until a free coffee.`;
    return card.stampedToday ? `✅ Today's stamp collected — ${left}` : left;
  }

  // ---------- auth view ----------

  function renderAuth() {
    mount('tpl-auth');
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

  // ---------- customer view ----------

  async function renderCustomer(me) {
    mount('tpl-customer');
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

    await loadHistory();

    // Refresh the card when the app comes back to the foreground — e.g. right
    // after the barista stamps it.
    let lastStamps = me.card.currentStamps + me.card.lifetimeVisits * 1000;
    const refresh = async () => {
      if (document.visibilityState !== 'visible' || !bind('stamps')) return;
      try {
        const fresh = await api('/api/me');
        const key = fresh.card.currentStamps + fresh.card.lifetimeVisits * 1000;
        if (key !== lastStamps) {
          lastStamps = key;
          fillCustomer(fresh);
          loadHistory();
        }
      } catch (err) { if (err.status === 401) route(); }
    };
    document.addEventListener('visibilitychange', refresh);
    clearInterval(window.__ehcPoll);
    window.__ehcPoll = setInterval(refresh, 15000);
  }

  function fillCustomer(me) {
    const { card } = me;
    bind('name').textContent = me.user.name.split(' ')[0];
    const status = bind('status');
    status.textContent = statusText(card);
    status.classList.toggle('free', card.nextIsFree);
    bind('progress').textContent = `${card.currentStamps} / ${card.cardSize - 1} stamps`;
    renderStamps(bind('stamps'), card);
    bind('lifetimePoints').textContent = card.lifetimePoints.toLocaleString();
    bind('lifetimeVisits').textContent = card.lifetimeVisits.toLocaleString();
    bind('freeRedeemed').textContent = card.freeRedeemed.toLocaleString();
  }

  async function loadHistory() {
    const list = bind('history');
    if (!list) return;
    const { history } = await api('/api/me/history');
    list.replaceChildren();
    if (!history.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No visits yet — your first stamp is waiting!';
      list.append(li);
      return;
    }
    for (const h of history.slice(0, 15)) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      const when = document.createElement('span');
      what.textContent = h.kind === 'free_coffee' ? '☕ Free coffee redeemed' : '+1 stamp';
      if (h.kind === 'free_coffee') what.className = 'free-row';
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

    const lookupForm = $('#lookup-form');
    const stampForm = $('#stamp-form');
    const lookupErr = bind('lookupError');
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
        s.textContent = card.nextIsFree
          ? '✅ Stamped today. Card is full — free coffee on their next visit.'
          : card.currentStamps === 0
            ? '☕ Free coffee redeemed today · new card starts next visit'
            : `✅ Already stamped today · ${plural(card.currentStamps, 'stamp')} · ${card.visitsUntilFree} visits until free`;
        btn.textContent = 'Already stamped today';
      } else if (card.nextIsFree) {
        s.textContent = "🎉 Card is full — today's coffee is FREE!";
        btn.textContent = 'Redeem FREE coffee';
      } else {
        s.textContent = `${plural(card.currentStamps, 'stamp')} · ${card.visitsUntilFree} visits until free · ${card.lifetimePoints} lifetime pts`;
        btn.textContent = "Add today's stamp";
      }
      s.classList.toggle('free', card.nextIsFree && !card.stampedToday);
      btn.dataset.done = card.stampedToday ? '1' : '';
      btn.disabled = card.stampedToday;
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

    lookupForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = lookupForm.code.value.trim();
      showError(stampForm, null);
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
          // e.g. another barista stamped them a moment ago — show the latest card.
          if (err.status === 409) lookup(currentCode);
          throw err;
        }
      });
    });

    // QR scanning via the built-in BarcodeDetector (Chrome/Android, Safari 17+ behind flag).
    if ('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia) {
      const scanBtn = $('[data-action="scan"]');
      const scanner = $('.scanner');
      const video = $('.scanner video');
      let stream = null;
      let raf = 0;
      scanBtn.hidden = false;

      const stop = () => {
        cancelAnimationFrame(raf);
        stream?.getTracks().forEach((t) => t.stop());
        stream = null;
        scanner.hidden = true;
        scanBtn.hidden = false;
      };

      scanBtn.addEventListener('click', async () => {
        try {
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          video.srcObject = stream;
          await video.play();
          scanner.hidden = false;
          scanBtn.hidden = true;
          const tick = async () => {
            if (!stream) return;
            try {
              const codes = await detector.detect(video);
              if (codes.length) {
                const value = codes[0].rawValue;
                stop();
                lookupForm.code.value = value;
                lookup(value);
                return;
              }
            } catch { /* frame not ready */ }
            raf = requestAnimationFrame(tick);
          };
          tick();
        } catch {
          stop();
          toast('Camera unavailable — type the member code instead.', 'err');
        }
      });
      $('[data-action="stop-scan"]').addEventListener('click', stop);
    }
  }

  function wireCommon() {
    app.querySelectorAll('[data-action="logout"]').forEach((b) => b.addEventListener('click', async () => {
      clearInterval(window.__ehcPoll);
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
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  route();
})();
