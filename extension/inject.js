// Dropomat – skrypt w kontekście strony (MAIN world), uruchamiany przed kodem Twitcha.
// Działa WYŁĄCZNIE w karcie otwartej przez Dropomat (znacznik #dropomat w adresie
// albo flaga w sessionStorage tej karty). Twoje zwykłe karty Twitcha zostają nietknięte.
(() => {
  'use strict';
  let miner = false;
  let quality = '160p30';
  try {
    const m = /#dropomat(?:=([\w]+))?/.exec(location.hash || '');
    if (m) {
      sessionStorage.setItem('__dropomat', '1');
      if (m[1]) sessionStorage.setItem('__dropomat_q', m[1]);
    }
    miner = sessionStorage.getItem('__dropomat') === '1';
    quality = sessionStorage.getItem('__dropomat_q') || quality;
  } catch (e) { /* brak dostępu do storage – nie jesteśmy kartą Dropomatu */ }
  if (!miner) return;

  // 1) Karta ma dla Twitcha zawsze wyglądać na widoczną i aktywną,
  //    także gdy okno jest zminimalizowane albo przykryte grą.
  const def = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { configurable: true, get: () => value }); } catch (e) {}
  };
  def(Document.prototype, 'hidden', false);
  def(Document.prototype, 'webkitHidden', false);
  def(Document.prototype, 'visibilityState', 'visible');
  def(Document.prototype, 'webkitVisibilityState', 'visible');
  try { Document.prototype.hasFocus = function () { return true; }; } catch (e) {}
  const swallow = (e) => { e.stopImmediatePropagation(); };
  for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
    document.addEventListener(type, swallow, true);
    window.addEventListener(type, swallow, true);
  }
  for (const type of ['blur', 'focusout']) {
    window.addEventListener(type, (e) => {
      if (e.target === window || e.target === document) e.stopImmediatePropagation();
    }, true);
  }

  // 2) Ustawienia odtwarzacza tylko dla tej karty: niska jakość, dźwięk NIE wyciszony
  //    w odtwarzaczu (wyciszana jest cała karta – wyciszony odtwarzacz w tle Chrome pauzuje).
  //    Podmieniamy odczyt, nic nie zapisujemy – Twoje własne ustawienia Twitcha się nie zmieniają.
  const fake = { 'volume': '0.05', 'video-muted': '{"default":false}' };
  if (quality && quality !== 'auto') fake['video-quality'] = JSON.stringify({ default: quality });
  try {
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (this === window.localStorage && Object.prototype.hasOwnProperty.call(fake, key)) return fake[key];
      return realGet.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (this === window.localStorage && Object.prototype.hasOwnProperty.call(fake, key)) return;
      return realSet.call(this, key, value);
    };
  } catch (e) {}

  // 3) Chrome wstrzymuje ładowanie wideo w karcie, która nigdy nie była widoczna
  //    i nic jeszcze nie odtwarzała. Krótki, niemy strumień z canvasa „odhacza” ten warunek,
  //    dzięki czemu stream rusza także w zminimalizowanym oknie.
  try {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 2;
    c.getContext('2d').fillRect(0, 0, 2, 2);
    const pv = document.createElement('video');
    pv.muted = true;
    pv.srcObject = c.captureStream(1);
    const p = pv.play();
    if (p && p.catch) p.catch(() => {});
    window.__dropomatPrime = pv;
  } catch (e) {}

  // 4) Lista kampanii: gdy Dropomat otwiera w tle twitch.tv/drops/campaigns, strona sama pobiera pełną listę.
  //    Podglądamy odpowiedzi, które strona i tak dostała, i przekazujemy z nich same kampanie.
  try {
    const realFetch = window.fetch;
    const isCamp = (o) => typeof o.id === 'string' && typeof o.name === 'string' && o.game && typeof o.game === 'object' && (o.startAt || o.endAt);
    const lite = (c) => ({
      id: c.id, name: c.name, status: c.status, startAt: c.startAt, endAt: c.endAt,
      game: { id: c.game.id, slug: c.game.slug, displayName: c.game.displayName || c.game.name, boxArtURL: c.game.boxArtURL },
      self: c.self && typeof c.self === 'object' ? { isAccountConnected: c.self.isAccountConnected } : undefined,
      allow: c.allow && Array.isArray(c.allow.channels)
        ? { isEnabled: c.allow.isEnabled, channels: c.allow.channels.map((ch) => ({ name: ch && (ch.name || ch.displayName) })) } : undefined,
      timeBasedDrops: Array.isArray(c.timeBasedDrops) ? c.timeBasedDrops.map((d) => ({
        id: d.id, name: d.name, requiredMinutesWatched: d.requiredMinutesWatched,
        preconditionDrops: Array.isArray(d.preconditionDrops) ? d.preconditionDrops.map((x) => ({ id: x && x.id })) : null,
        benefitEdges: (d.benefitEdges || []).map((e) => ({ benefit: e && e.benefit ? { id: e.benefit.id, name: e.benefit.name, imageAssetURL: e.benefit.imageAssetURL } : null })),
        self: d.self && typeof d.self === 'object' ? { currentMinutesWatched: d.self.currentMinutesWatched, isClaimed: d.self.isClaimed, hasPreconditionsMet: d.self.hasPreconditionsMet } : undefined
      })) : undefined
    });
    const walk = (node, out, depth) => {
      if (!node || typeof node !== 'object' || depth > 14 || out.length > 800) return;
      if (Array.isArray(node)) { for (const x of node) walk(x, out, depth + 1); return; }
      if (isCamp(node)) out.push(lite(node));
      for (const k in node) { const v = node[k]; if (v && typeof v === 'object') walk(v, out, depth + 1); }
    };
    const wrapped = function (input) {
      const p = realFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('gql.twitch.tv') !== -1) {
          p.then((res) => res.clone().json()).then((json) => {
            const out = [];
            walk(json, out, 0);
            if (out.length) window.postMessage({ __dropomat: 'camps', list: out }, location.origin);
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
    wrapped.toString = () => realFetch.toString();
    window.fetch = wrapped;
  } catch (e) {}
})();
