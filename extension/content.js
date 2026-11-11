// Dropomat – skrypt karty. Odpowiada na polecenia z tła tylko w karcie otwartej przez Dropomat.
(() => {
  'use strict';
  let miner = false;
  try {
    if (/#dropomat/.test(location.hash || '')) sessionStorage.setItem('__dropomat', '1');
    miner = sessionStorage.getItem('__dropomat') === '1';
  } catch (e) {}
  if (!miner) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const activated = () => !!(navigator.userActivation && navigator.userActivation.hasBeenActive);

  function mainVideo() {
    const vids = [...document.querySelectorAll('video')];
    if (!vids.length) return null;
    // główny odtwarzacz = największe wideo na stronie
    vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
    return vids[0];
  }

  async function unmute(v, out) {
    if (!activated()) { out.needActivation = true; return; }
    const btn = $('[data-a-target="player-mute-unmute-button"]');
    if (btn) btn.click(); else v.muted = false;
    await sleep(400);
    if (v.muted) v.muted = false;
    if (v.volume < 0.02) v.volume = 0.05;
    await sleep(250);
    if (v.paused) {
      try { await v.play(); } catch (e) {
        v.muted = true;
        try { await v.play(); } catch (e2) {}
        out.needActivation = true;
      }
    }
  }

  async function status(fix) {
    const out = {
      miner: true,
      path: location.pathname,
      channel: (location.pathname.split('/')[1] || '').toLowerCase(),
      loggedOut: !!$('[data-a-target="login-button"]'),
      activated: activated(),
      realHidden: document.hidden, // prawdziwy stan (ten skrypt działa poza podmianą widoczności)
      video: null
    };
    if (fix) {
      const gate = $('[data-a-target="content-classification-gate-overlay-start-watching-button"]');
      if (gate) { gate.click(); out.gate = true; await sleep(300); }
    }
    const v = mainVideo();
    if (!v) return out;
    if (fix) {
      if (v.paused && v.readyState >= 1) {
        try { await v.play(); } catch (e) { out.playErr = e && e.name; }
      }
      if (!v.muted && v.volume < 0.02) v.volume = 0.05;
      if (v.muted) await unmute(v, out);
    }
    const t0 = v.currentTime;
    await sleep(1200);
    const t1 = v.currentTime;
    out.video = {
      paused: v.paused, muted: v.muted, volume: v.volume,
      height: v.videoHeight, ready: v.readyState,
      advancing: t1 > t0 + 0.2
    };
    return out;
  }

  function nav(path) {
    if (location.pathname.toLowerCase() === String(path).toLowerCase()) return { ok: true, same: true };
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return { ok: true };
  }

  // Mały kwadrat w rogu, w który tło „klika” przez debugger – daje karcie
  // jednorazową aktywację użytkownika, bez której Chrome nie puści dźwięku.
  function activator() {
    let el = document.getElementById('dropomat-activator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dropomat-activator';
      el.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px;z-index:2147483647;background:transparent;';
      const done = (e) => { e.preventDefault(); e.stopPropagation(); setTimeout(() => el.remove(), 50); };
      el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
      el.addEventListener('mouseup', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
      el.addEventListener('click', done, true);
      (document.body || document.documentElement).appendChild(el);
      setTimeout(() => el.remove(), 15000);
    }
    return { x: 32, y: 32 };
  }

  // Awaryjnie: pasek z prośbą o jedno kliknięcie (gdy automatyczne odblokowanie nie zadziała).
  function overlay(show, text) {
    let el = document.getElementById('dropomat-overlay');
    if (!show) { if (el) el.remove(); return { ok: true }; }
    if (activated()) return { ok: true, activated: true };
    if (!el) {
      el = document.createElement('div');
      el.id = 'dropomat-overlay';
      el.textContent = text || 'Dropomat: click here once to unlock background playback';
      el.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:2147483647;padding:22px 16px;' +
        'background:#0e0e0f;color:#fff;font:600 16px "Segoe UI",system-ui,sans-serif;text-align:center;' +
        'border-bottom:2px solid #60cdff;cursor:pointer;';
      el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); el.remove(); }, true);
      (document.body || document.documentElement).appendChild(el);
    }
    return { ok: true };
  }

  // Odbieranie: klikamy przyciski „Odbierz” na stronie ekwipunku dropów – tak jak zrobiłby to człowiek.
  function claimButtons() {
    const set = new Set(document.querySelectorAll('button[data-test-selector="DropsCampaignInProgressRewardPresentation-claim-button"]'));
    if (/^\/drops\/inventory/.test(location.pathname)) {
      for (const b of document.querySelectorAll('main button, [role="main"] button')) {
        const t = (b.textContent || '').trim();
        if (/^(odbierz|claim)(\s+(teraz|now|nagrodę|reward))?$/i.test(t)) set.add(b);
      }
    }
    return [...set].filter((b) => !b.disabled);
  }
  async function claim() {
    const btns = claimButtons();
    for (const b of btns) { b.click(); await sleep(700); }
    return { clicked: btns.length, path: location.pathname, loggedOut: !!$('[data-a-target="login-button"]') };
  }

  // Kampanie podejrzane przez inject.js w odpowiedziach, które strona sama pobrała → do tła.
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__dropomat !== 'camps' || !Array.isArray(e.data.list)) return;
    try { chrome.runtime.sendMessage({ to: 'dropomat-bg', op: 'pageCamps', list: e.data.list }).catch(() => {}); } catch (err) {}
  });

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || msg.to !== 'dropomat-tab') return;
    (async () => {
      try {
        if (msg.cmd === 'status') respond(await status(!!msg.fix));
        else if (msg.cmd === 'nav') respond(nav(msg.path));
        else if (msg.cmd === 'activator') respond(activator());
        else if (msg.cmd === 'overlay') respond(overlay(msg.show !== false, msg.text));
        else if (msg.cmd === 'claim') respond(await claim());
        else respond({ error: 'unknown' });
      } catch (e) { respond({ error: String(e && e.message || e) }); }
    })();
    return true;
  });
})();
