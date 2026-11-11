// Dropomat – logika w tle (service worker).
// Cały stan trzymany jest w chrome.storage, a praca napędzana alarmem, więc uśpienie
// albo restart service workera przez przeglądarkę niczego nie gubi – po wybudzeniu leci dalej.
'use strict';
importScripts('config.js', 'i18n.js', 'locales/a.js', 'locales/b.js', 'locales/c.js');

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // publiczny identyfikator strony twitch.tv
const GQL_URL = 'https://gql.twitch.tv/gql';

const DEF_SETTINGS = {
  lang: 'auto',        // język interfejsu
  minimized: true,     // okno ze streamem startuje zminimalizowane
  quality: '160p30',   // jakość streama w oknie Dropomatu
  autoTrack: true,     // śledzone gry: samoczynny start przy nowych dropach
  trackMin: 30,        // co ile minut sprawdzać nowe kampanie, gdy kolejka stoi
  checkMin: 5,         // co ile minut sprawdzać postęp dropów podczas oglądania
  stallMin: 15,        // po ilu minutach bez postępu zmienić stream
  notify: true,        // powiadomienia systemowe
  autoUnmute: true,    // samoczynne odblokowanie dźwięku (krótki pasek „debugowanie”)
  autoClaim: false,    // samoczynne odbieranie wbitych dropów (klik „Odbierz” w ekwipunku Twitcha)
  fallbackHours: 6     // limit na grę, gdy nie da się odczytać postępu
};

// Czasy w ms (nadpisywane tylko w testach przez klucz __t w storage).
const T = {
  fast: 4000,              // szybkie kroki przy wybieraniu/ładowaniu streama
  loadWait: 9000,          // ile dać streamowi na start przed pierwszym sprawdzeniem
  loadTimeout: 60000,      // po tym czasie bez odtwarzania – następny stream
  live: 50000,             // co ile sprawdzać, czy stream dalej trwa
  retryNoStreams: 600000,  // ponowna próba gry bez streamów z dropami
  retryStuck: 10800000,    // ponowna próba gry, w której postęp nie rósł
  bad: 1800000,            // na ile odstawić stream, który nie działał
  docMax: 28800000,        // co ile przeładować kartę w całości (higiena pamięci)
  claimEvery: 600000,      // najwyżej co tyle próbować odebrać dropy
  scanEvery: 1200000,      // pełny przegląd publicznych kampanii
  pageEvery: 1800000,      // odczyt listy kampanii ze strony Twitcha
  pageWait: 16000,         // ile czekać na stronę kampanii
  updateEvery: 43200000,   // co ile sprawdzać, czy jest nowsza wersja
  check: 0, track: 0, stall: 0, // 0 = z ustawień
  loop: 0, bgTab: 0, noMute: 0 // tylko testy
};

const checkMs = (st) => T.check || Math.max(1, st.settings.checkMin) * 60000;
const trackMs = (st) => T.track || Math.max(5, st.settings.trackMin) * 60000;
const stallMs = (st) => T.stall || Math.max(5, st.settings.stallMin) * 60000;
const lc = (s) => String(s || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameGame = (a, b) => !!((a.gameId && a.gameId === b.gameId) || (a.slug && a.slug === b.slug));
const cleanLogin = (s) => lc(s).replace(/^.*twitch\.tv\//, '').replace(/[^a-z0-9_]/g, '');
const fixArt = (u) => String(u || '').replace('{width}', '52').replace('{height}', '72');
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

// ───────────────────────── stan ─────────────────────────

async function load() {
  const d = await chrome.storage.local.get(['st', '__t']);
  const st = d.st || {};
  st.games = st.games || [];
  st.settings = Object.assign({}, DEF_SETTINGS, st.settings || {});
  st.run = st.run || { running: false };
  st.camps = st.camps || {};
  st.claimed = st.claimed || {};
  st.log = st.log || [];
  st.tracked = st.tracked || [];
  for (const g of st.games) { // starszy zapis: śledzenie było cechą pozycji w kolejce
    if (g.track && !st.tracked.some((t) => sameGame(t, g))) st.tracked.push({ gameId: g.gameId || '', slug: g.slug, name: g.name, icon: g.icon || '', seen: g.seen || [] });
    delete g.track;
  }
  if (d.__t) Object.assign(T, d.__t);
  return st;
}
const save = (st) => chrome.storage.local.set({ st });

// Teksty w języku wybranym w ustawieniach.
const langOf = (st) => resolveLang(st.settings.lang);
const L = (st, key, vars) => tr(langOf(st), key, vars);

// Wpis w dzienniku: klucz + zmienne (okienko pokazuje go w aktualnym języku) i gotowy tekst na zapas.
function log(st, key, vars) {
  st.log.push({ t: Date.now(), k: key, v: vars || null, m: L(st, key, vars) });
  if (st.log.length > 80) st.log.splice(0, st.log.length - 80);
}

function notify(st, titleKey, bodyKey, vars) {
  if (!st.settings.notify) return;
  try {
    chrome.notifications.create('dropomat-' + Date.now(), {
      type: 'basic', iconUrl: 'icons/128.png', title: L(st, titleKey, vars), message: L(st, bodyKey, vars)
    }, () => void chrome.runtime.lastError);
  } catch (e) {}
}

// Wszystkie operacje na stanie idą jedna po drugiej.
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ───────────────────────── Twitch GQL ─────────────────────────

async function getToken() {
  try {
    const c = await chrome.cookies.get({ url: 'https://www.twitch.tv/', name: 'auth-token' });
    return c && c.value ? c.value : null;
  } catch (e) { return null; }
}

async function post(body, token) {
  const headers = { 'Client-Id': CLIENT_ID, 'Content-Type': 'text/plain;charset=UTF-8' };
  if (token) headers.Authorization = 'OAuth ' + token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(GQL_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
    return { status: r.status, json: await r.json() };
  } finally { clearTimeout(timer); }
}

async function gql(query, token) {
  const { status, json: j } = await post({ query }, token);
  if (j && j.error) { const e = new Error(j.message || j.error); e.status = j.status || status; throw e; }
  if (j && j.errors && !j.data) throw new Error((j.errors[0] && j.errors[0].message) || 'GQL');
  return (j && j.data) || {};
}

// Wiele zapytań w jednym żądaniu (tak samo robi strona Twitcha). Zwraca tablicę `data` – {} tam, gdzie był błąd.
async function gqlBatch(queries, token) {
  const out = [];
  for (const part of chunk(queries, 30)) {
    let arr = null;
    try { const res = await post(part.map((query) => ({ query })), token); arr = Array.isArray(res.json) ? res.json : null; } catch (e) {}
    for (let i = 0; i < part.length; i++) out.push((arr && arr[i] && arr[i].data) || {});
  }
  return out;
}

// Zapytanie, które nigdy nie rzuca: { data } albo { err, status }.
async function tryGql(query, token) {
  try { return { data: await gql(query, token) }; } catch (e) { return { err: String((e && e.message) || e), status: e && e.status }; }
}

// Zapytania są celowo „chude”: pola `self` (postęp, połączenie konta) Twitch potrafi zwrócić z błędem,
// a wtedy z odpowiedzi wypada cała kampania. Dlatego listy kampanii pobieramy bez nich,
// a postęp osobnymi zapytaniami, których błąd niczego innego nie psuje.
// Uwaga: Twitch pozwala na najwyżej 15 aliasów na najwyższym poziomie jednego zapytania.
const GAME_LITE = 'game{ id slug displayName boxArtURL(width:52, height:72) }';
const CAMP_LITE = 'id name status startAt endAt ' + GAME_LITE;
const DROP_LITE = 'timeBasedDrops{ id name requiredMinutesWatched preconditionDrops{ id } benefitEdges{ benefit{ id name imageAssetURL } } }';
const DROP_SELF = 'timeBasedDrops{ id self{ currentMinutesWatched isClaimed hasPreconditionsMet dropInstanceID } }';
const Q_ME = '{ currentUser{ id login } }';
const Q_CAMPS = `{ currentUser{ id login dropCampaigns{ ${CAMP_LITE} } } }`;
const Q_INV = `{ currentUser{ inventory{ gameEventDrops{ id lastAwardedAt } dropCampaignsInProgress{ ${CAMP_LITE} ${DROP_LITE} } } } }`;
const Q_PROG = `{ currentUser{ inventory{ dropCampaignsInProgress{ id ${DROP_SELF} } } } }`;
const Q_CONN = '{ currentUser{ dropCampaigns{ id self{ isAccountConnected } } } }';
const qDetail = (ids) => '{ currentUser{ ' + ids.map((id, i) =>
  `c${i}: dropCampaign(id:${JSON.stringify(id)}){ ${CAMP_LITE} allow{ isEnabled channels{ id name displayName } } ${DROP_LITE} }`).join(' ') + ' } }';
const qProgCamps = (ids) => '{ currentUser{ ' + ids.map((id, i) =>
  `p${i}: dropCampaign(id:${JSON.stringify(id)}){ id ${DROP_SELF} }`).join(' ') + ' } }';
// Kampanie, które Twitch pokazuje pod danym streamem – to samo źródło, z którego korzysta panel dropów na stronie kanału.
const qChanCamps = (ids) => '{ ' + ids.map((id, i) =>
  `h${i}: channel(id:${JSON.stringify(String(id))}){ id viewerDropCampaigns{ ${CAMP_LITE} ${DROP_LITE} } }`).join(' ') + ' }';
const qUsers = (logins) => '{ ' + logins.map((l, i) =>
  `u${i}: user(login:${JSON.stringify(l)}){ id login stream{ id type game{ id slug } } }`).join(' ') + ' }';
const gameArg = (g) => (g.gameId ? `id:${JSON.stringify(String(g.gameId))}` : `slug:${JSON.stringify(g.slug || '')}`);
const qDir = (g) => `{ game(${gameArg(g)}){ id slug displayName streams(first:50, options:{systemFilters:[DROPS_ENABLED]})` +
  '{ edges{ node{ id viewersCount broadcaster{ id login } } } } } }';
const qGameInfo = (g) => `{ game(${gameArg(g)}){ id slug displayName boxArtURL(width:52, height:72) } }`;
const qSession = (channelId) => `{ currentUser{ dropCurrentSession(channelID:${JSON.stringify(String(channelId))})` +
  '{ dropID currentMinutesWatched requiredMinutesWatched game{ id displayName } channel{ id name } } } }';

// Lista dropów kampanii + to, co wiemy o postępie (świeże `self`, a gdy go brak – poprzedni odczyt).
function mapDrops(list, selfMap, oldDrops) {
  const oldById = {};
  for (const d of oldDrops || []) oldById[d.id] = d;
  return (list || []).filter((d) => d && d.requiredMinutesWatched > 0).map((d) => {
    const self = (selfMap && selfMap[d.id]) || d.self;
    const old = oldById[d.id];
    const out = {
      id: d.id, name: d.name || ((d.benefitEdges || []).map((e) => e && e.benefit && e.benefit.name).filter(Boolean)[0]) || (old && old.name) || '', req: d.requiredMinutesWatched,
      hasSelf: false, cur: 0, claimed: false, preMet: undefined,
      pre: (d.preconditionDrops || []).map((p) => p && p.id).filter(Boolean),
      benefits: (d.benefitEdges || []).map((e) => e && e.benefit && e.benefit.id).filter(Boolean),
      img: ((d.benefitEdges || []).map((e) => e && e.benefit && e.benefit.imageAssetURL).filter(Boolean)[0]) || (old && old.img) || ''
    };
    if (self) {
      out.hasSelf = true; out.cur = self.currentMinutesWatched || 0;
      out.claimed = !!self.isClaimed; out.preMet = self.hasPreconditionsMet;
      out.selfAt = Date.now(); // kiedy ostatnio widzieliśmy świeży postęp
    } else if (old && old.hasSelf) {
      out.hasSelf = true; out.cur = old.cur; out.claimed = old.claimed; out.preMet = old.preMet; out.selfAt = old.selfAt || 0;
    }
    return out;
  });
}

function baseCamp(c, old) {
  return {
    id: c.id, name: c.name || (old && old.name) || '', status: c.status || '',
    startAt: Date.parse(c.startAt) || 0, endAt: Date.parse(c.endAt) || 0,
    gameId: (c.game && c.game.id) || (old && old.gameId) || '', gameSlug: (c.game && c.game.slug) || (old && old.gameSlug) || '',
    gameName: (c.game && c.game.displayName) || (old && old.gameName) || '',
    gameIcon: fixArt(c.game && c.game.boxArtURL) || (old && old.gameIcon) || '',
    connected: old ? old.connected : undefined, // true/false, a gdy nie wiemy – undefined
    drops: old ? old.drops : null,
    channels: old ? old.channels : null,
    detail: !!(old && old.detail), detailTries: (old && old.detailTries) || 0,
    inInv: false, src: ''
  };
}

// O aktywności decydują daty (status z listy sprzed kilkunastu minut mógł jeszcze brzmieć „nadchodząca”).
const isActive = (c, now) => c.status !== 'EXPIRED' && (c.startAt ? c.startAt <= now : (!c.status || c.status === 'ACTIVE')) && (!c.endAt || c.endAt > now);
const matches = (c, g) => (g.gameId && c.gameId === g.gameId) || (g.slug && c.gameSlug === g.slug) ||
  (g.name && lc(c.gameName) === lc(g.name));
const gameCamps = (st, g, now) => Object.values(st.camps).filter((c) => isActive(c, now) && matches(c, g));
// Kampania gry z choć jednym dropem „za oglądanie” – kampanie kanałów (bez gry) i same odznaki nas nie interesują.
const realCamp = (c) => !!(c && c.id && c.game && (c.game.id || c.game.displayName));
const hasTimed = (c) => !Array.isArray(c.timeBasedDrops) || c.timeBasedDrops.some((d) => d && d.requiredMinutesWatched > 0);

// ── Publiczny przegląd: gry z dropami wśród 100 najpopularniejszych kategorii oraz w przekrojach
//    streamów z włączonymi dropami (różne języki i sortowania). Nie wymaga logowania.
const SCAN_LANGS = ['EN', 'DE', 'FR', 'ES', 'PT', 'RU', 'JA', 'KO', 'ZH', 'PL', 'IT', 'TR', 'UK', 'CS', 'NL', 'AR', 'TH', 'SV', 'HU', 'ID'];
const SCAN_SORTS = ['VIEWER_COUNT', 'VIEWER_COUNT_ASC', 'RECENT'];
async function scanPublic(st, now) {
  const qs = ['{ games(first:100){ edges{ node{ id slug displayName } } } }'];
  for (const l of SCAN_LANGS) for (const s of SCAN_SORTS) {
    qs.push(`{ streams(first:30, options:{systemFilters:[DROPS_ENABLED], broadcasterLanguages:[${l}], sort:${s}}){ edges{ node{ game{ id } broadcaster{ id } } } } }`);
  }
  const res = await gqlBatch(qs);
  const byGame = new Map();
  const add = (gid, ch) => { if (!gid || !ch) return; const set = byGame.get(gid) || new Set(); if (set.size < 3) set.add(ch); byGame.set(gid, set); };
  const top = ((res[0].games && res[0].games.edges) || []).map((e) => e && e.node).filter((n) => n && n.id);
  for (const r of res.slice(1)) {
    for (const e of (r.streams && r.streams.edges) || []) {
      const n = e && e.node;
      if (n && n.game && n.broadcaster) add(n.game.id, n.broadcaster.id);
    }
  }
  const gq = chunk(top, 15).map((part) => '{ ' + part.map((g, k) =>
    `g${k}: game(id:${JSON.stringify(g.id)}){ id streams(first:3, options:{systemFilters:[DROPS_ENABLED]}){ edges{ node{ broadcaster{ id } } } } }`).join(' ') + ' }');
  const res2 = await gqlBatch(gq);
  chunk(top, 15).forEach((part, bi) => part.forEach((g, k) => {
    const x = res2[bi] && res2[bi]['g' + k];
    for (const e of (x && x.streams && x.streams.edges) || []) if (e && e.node && e.node.broadcaster) add(g.id, e.node.broadcaster.id);
  }));
  const chans = [];
  byGame.forEach((set) => set.forEach((id) => chans.push(id)));
  const ids = [...new Set(chans)].slice(0, 600);
  const res3 = await gqlBatch(chunk(ids, 15).map(qChanCamps));
  const camps = {};
  let seenAny = false;
  for (const d of res3) {
    for (const ch of Object.values(d || {})) {
      for (const c of (ch && ch.viewerDropCampaigns) || []) {
        seenAny = true;
        if (realCamp(c) && hasTimed(c)) camps[c.id] = c;
      }
    }
  }
  if (!seenAny && st.pub && Object.keys(st.pub.camps || {}).length) { st.pub.at = now - T.scanEvery + 120000; return; } // nieudany przegląd – zostaje poprzedni, ponowimy za 2 min
  st.pub = { at: now, camps };
}

// ── Lista kampanii ze strony twitch.tv/drops/campaigns: otwieramy ją na chwilę w tle i czytamy to,
//    co strona sama pobrała (to pełna lista – także kampanie, których kanały akurat nie nadają).
let pageBuf = null; // zbierane przez nasłuch wiadomości, poza kolejką operacji
async function capturePage(st, now) {
  const url = 'https://www.twitch.tv/drops/campaigns#dropomat';
  let tabId = null;
  pageBuf = { list: [], at: 0 };
  try {
    if (st.run.windowId != null && (await getTab(st))) tabId = (await chrome.tabs.create({ windowId: st.run.windowId, url, active: false })).id;
    else {
      let wins = [];
      try { wins = await chrome.windows.getAll({ windowTypes: ['normal'] }); } catch (e) {}
      const w = wins.find((x) => x.focused) || wins[0];
      if (w) tabId = (await chrome.tabs.create({ windowId: w.id, url, active: false })).id;
      else {
        const nw = await chrome.windows.create({ url, focused: false, type: 'normal', state: 'minimized' });
        tabId = nw.tabs && nw.tabs[0] ? nw.tabs[0].id : null;
      }
    }
    if (tabId != null) { try { await chrome.tabs.update(tabId, { muted: true }); } catch (e) {} }
    const t0 = Date.now();
    while (Date.now() - t0 < T.pageWait) {
      await sleep(500);
      if (pageBuf.at && Date.now() - pageBuf.at > 2500) break;
    }
  } catch (e) {} finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  }
  const camps = {};
  for (const c of pageBuf.list) if (realCamp(c) && hasTimed(c)) camps[c.id] = Object.assign({}, camps[c.id] || {}, c);
  pageBuf = null;
  st.page = { at: now, camps, n: Object.keys(camps).length };
}

// Pobiera kampanie i postęp. Zwraca true, gdy dane z konta są wiarygodne.
async function refreshDrops(st) {
  const now = Date.now();
  st.dropsAt = now; st.dirty = false;
  const token = await getToken();
  const old = st.camps || {};
  const camps = {};
  const selfMap = {};
  const diag = { page: 0, scan: 0, api: 0, inv: 0, streams: 0 };
  const merge = (c, src) => {
    if (!c || !c.id) return null;
    let b = camps[c.id];
    if (!b) { b = camps[c.id] = baseCamp(c, old[c.id]); b.src = src; diag[src]++; }
    else { // uzupełniamy to, czego brakowało (np. slug gry albo okładka)
      if (src !== 'page' && src !== 'scan') { // źródła pobierane przy każdym odczycie są świeższe niż zapamiętane listy
        if (c.status) b.status = c.status;
        if (Date.parse(c.startAt)) b.startAt = Date.parse(c.startAt);
        if (Date.parse(c.endAt)) b.endAt = Date.parse(c.endAt);
      }
      if (!b.gameSlug && c.game && c.game.slug) b.gameSlug = c.game.slug;
      if (!b.gameIcon && c.game && c.game.boxArtURL) b.gameIcon = fixArt(c.game.boxArtURL);
    }
    if (!b.rawDrops && Array.isArray(c.timeBasedDrops)) b.rawDrops = c.timeBasedDrops;
    if (c.self && typeof c.self.isAccountConnected === 'boolean') b.connected = c.self.isAccountConnected;
    if (c.allow && Array.isArray(c.allow.channels) && c.allow.isEnabled !== false) {
      b.channels = c.allow.channels.map((ch) => lc(ch && ch.name)).filter(Boolean); b.detail = true;
    }
    return b;
  };
  const finish = () => {
    const claimed = st.claimed || {};
    for (const c of Object.values(camps)) {
      if (c.rawDrops) c.drops = mapDrops(c.rawDrops, selfMap, old[c.id] && old[c.id].drops);
      else if (c.drops) c.drops = c.drops.map((d) => (selfMap[d.id] ? Object.assign({}, d, {
        hasSelf: true, cur: selfMap[d.id].currentMinutesWatched || 0, claimed: !!selfMap[d.id].isClaimed, preMet: selfMap[d.id].hasPreconditionsMet
      }) : d));
      delete c.rawDrops;
      // Kampania zniknęła z „w toku” albo nie mamy świeżego postępu dropa: uznajemy go za odebrany, gdy jego
      // nagrody są w ekwipunku – o ile był wbity do końca, nie mamy o nim własnych danych, albo nagrodę
      // przyznano już po naszym ostatnim odczycie (dobity i odebrany między sprawdzeniami).
      for (const d of c.drops || []) {
        if (d.claimed || !d.benefits.length) continue;
        if (c.inInv && d.hasSelf && selfMap[d.id]) continue;
        const awarded = (since) => d.benefits.every((b) => claimed[b] && claimed[b] >= since);
        if (!awarded(c.startAt)) continue;
        if (!d.hasSelf || d.cur >= d.req || awarded((d.selfAt || 0) - 60000)) d.claimed = true;
      }
    }
    st.camps = camps;
    st.diag = diag;
  };

  // 0) źródła listy kampanii: strona Twitcha (pełna lista, wymaga logowania) i publiczny przegląd
  if (token && (!st.page || now - st.page.at >= T.pageEvery)) await capturePage(st, now);
  if (!st.pub || now - st.pub.at >= T.scanEvery) { try { await scanPublic(st, now); } catch (e) {} }
  for (const c of Object.values((st.page && st.page.camps) || {})) merge(c, 'page');
  for (const c of Object.values((st.pub && st.pub.camps) || {})) merge(c, 'scan');

  // 0b) gry z kolejki i śledzone (publiczne, bez logowania): uzupełnienie danych gry + kampanie widoczne pod ich streamami z dropami
  const mine = [];
  for (const g of [...st.games, ...st.tracked]) if (!mine.some((x) => sameGame(x, g))) mine.push(g);
  const infoNeed = mine.filter((g) => !g.icon || !g.slug || !g.gameId);
  if (infoNeed.length) {
    const info = await gqlBatch(infoNeed.map(qGameInfo));
    infoNeed.forEach((g, i) => {
      const x = info[i] && info[i].game;
      if (!x) return;
      for (const y of [...st.games, ...st.tracked]) {
        if (!sameGame(y, g)) continue;
        if (!y.icon) y.icon = x.boxArtURL || '';
        if (!y.gameId) y.gameId = x.id || '';
        if (!y.slug) y.slug = x.slug || '';
      }
    });
  }
  if (mine.length) {
    const dirs = await gqlBatch(mine.map(qDir));
    const tops = mine.map((g, i) => ((dirs[i].game && dirs[i].game.streams && dirs[i].game.streams.edges) || [])
      .map((e) => e && e.node && e.node.broadcaster && e.node.broadcaster.id).filter(Boolean).slice(0, 6));
    const withStreams = tops.map((ids, i) => ({ ids, i })).filter((x) => x.ids.length);
    const res = await gqlBatch(withStreams.map((x) => qChanCamps(x.ids)));
    res.forEach((d) => {
      for (const ch of Object.values(d || {})) for (const c of (ch && ch.viewerDropCampaigns) || []) if (realCamp(c) && hasTimed(c)) merge(c, 'streams');
    });
  }

  if (!token) { st.auth = 'nologin'; finish(); return false; }
  const transient = (res) => {
    st.authErr = res.err || '';
    if (res.status === 401) { st.auth = 'nologin'; finish(); return false; }
    // Chwilowy błąd sieci nie kasuje tego, co już wiemy o dropach.
    st.authFail = (st.authFail || 0) + 1;
    if (st.auth !== 'ok' || st.authFail >= 6) st.auth = 'error';
    return false;
  };

  // 1) kto jest zalogowany + lista kampanii z konta
  const a = await tryGql(Q_CAMPS, token);
  if (a.err && a.status === 401) return transient(a);
  let me = a.data && a.data.currentUser;
  if (!me) {
    const b = await tryGql(Q_ME, token);
    if (b.err) return transient(b);
    me = b.data.currentUser;
    if (!me) { st.auth = 'nologin'; finish(); return false; }
  }
  st.auth = 'ok'; st.authFail = 0; st.authErr = '';
  st.login = me.login || '';
  st.userId = me.id || '';
  for (const c of me.dropCampaigns || []) if (realCamp(c)) merge(c, 'api');

  // 2) ekwipunek: kampanie w toku i odebrane nagrody; 3) postęp (osobno, żeby błąd nie psuł listy)
  const invRes = await tryGql(Q_INV, token);
  const inv = (invRes.data && invRes.data.currentUser && invRes.data.currentUser.inventory) || {};
  const progRes = await tryGql(Q_PROG, token);
  const progList = progRes.data && progRes.data.currentUser && progRes.data.currentUser.inventory &&
    progRes.data.currentUser.inventory.dropCampaignsInProgress;
  let progKnown = Array.isArray(progList);
  const addSelf = (drops) => { for (const d of drops || []) if (d && d.id && d.self) selfMap[d.id] = d.self; };
  for (const c of progList || []) if (c) addSelf(c.timeBasedDrops);
  for (const c of inv.dropCampaignsInProgress || []) {
    if (!realCamp(c)) continue;
    const b = merge(c, 'inv');
    b.inInv = true;
    if (Array.isArray(c.timeBasedDrops)) b.rawDrops = c.timeBasedDrops;
  }
  if (Array.isArray(inv.gameEventDrops)) {
    const claimed = {};
    for (const e of inv.gameEventDrops) if (e && e.id) claimed[e.id] = Date.parse(e.lastAwardedAt) || 0;
    st.claimed = claimed;
  }

  // 5) szczegóły (dozwolone kanały, lista dropów) – tylko dla gier z kolejki/śledzonych, raz na kampanię
  const relevant = Object.values(camps).filter((c) => isActive(c, now) && mine.some((g) => matches(c, g)));
  const need = relevant.filter((c) => !c.detail && c.detailTries < 3).slice(0, 24);
  for (const part of chunk(need, 8)) {
    const res = await tryGql(qDetail(part.map((c) => c.id)), token);
    const d = (res.data && res.data.currentUser) || {};
    part.forEach((c, k) => {
      const x = d['c' + k];
      c.detailTries++;
      if (!x) return;
      const allow = x.allow || {};
      c.channels = allow.isEnabled === false ? [] : (allow.channels || []).map((ch) => lc(ch && ch.name)).filter(Boolean);
      if (!c.rawDrops) c.rawDrops = x.timeBasedDrops;
      c.detail = true;
    });
  }

  // 6) gdy zbiorczy odczyt postępu zawiódł – próbujemy kampania po kampanii
  if (!progKnown && relevant.length) {
    const part = relevant.slice(0, 10);
    const res = await tryGql(qProgCamps(part.map((c) => c.id)), token);
    const d = (res.data && res.data.currentUser) || {};
    part.forEach((c, k) => { const x = d['p' + k]; if (x) { addSelf(x.timeBasedDrops); progKnown = true; } });
  }

  // 7) czy konto gry jest połączone (tylko do ostrzeżenia)
  const conn = await tryGql(Q_CONN, token);
  for (const c of (conn.data && conn.data.currentUser && conn.data.currentUser.dropCampaigns) || []) {
    if (c && c.id && camps[c.id] && c.self && typeof c.self.isAccountConnected === 'boolean') camps[c.id].connected = c.self.isAccountConnected;
  }

  st.progKnown = progKnown;
  finish();
  return true;
}

async function liveStatus(logins) {
  const out = {};
  for (const part of chunk(logins, 15)) {
    const d = await gql(qUsers(part));
    part.forEach((l, k) => {
      const u = d['u' + k];
      const s = u && u.stream;
      out[l] = u ? {
        id: u.id, live: !!(s && (!s.type || s.type === 'live')),
        gameId: (s && s.game && s.game.id) || '', gameSlug: (s && s.game && s.game.slug) || ''
      } : null;
    });
  }
  return out;
}
const gameMatch = (s, g) => (g.gameId && s.gameId === g.gameId) || (g.slug && s.gameSlug === g.slug);

async function dirStreams(g) {
  const d = await gql(qDir(g));
  const edges = (d.game && d.game.streams && d.game.streams.edges) || [];
  return edges.map((e) => e && e.node).filter((n) => n && n.broadcaster && n.broadcaster.login)
    .map((n) => ({ login: lc(n.broadcaster.login), id: n.broadcaster.id, viewers: n.viewersCount || 0 }));
}

async function sessionProg(channelId) {
  const token = await getToken();
  if (!token || !channelId) return null;
  const d = await gql(qSession(channelId), token);
  const s = d.currentUser && d.currentUser.dropCurrentSession;
  if (!s) return null;
  return { dropId: s.dropID || '', cur: s.currentMinutesWatched || 0, req: s.requiredMinutesWatched || 0 };
}

// ───────────────────────── ocena gier ─────────────────────────

function assess(st, g, now) {
  if (g.limitHit) return { watchable: false, status: 'limit' };
  const cap = (st.settings.fallbackHours || 0) * 3600000;
  const capped = cap && (g.watchedMs || 0) >= cap;
  const camps = gameCamps(st, g, now);
  if (!camps.length) {
    // Kampanii nie znamy, ale użytkownik sam podał kanały z opisu dropa – próbujemy na nich (z weryfikacją pod streamem).
    if ((g.channels || []).length) return capped ? { watchable: false, status: 'limit', fallback: true } : { watchable: true, status: 'pending', fallback: true };
    const next = Object.values(st.camps).filter((c) => matches(c, g) && c.startAt > now)
      .sort((a, b) => a.startAt - b.startAt)[0];
    return { watchable: false, status: 'nodrops', nextAt: next ? next.startAt : 0 };
  }
  const blind = st.auth !== 'ok' || !st.progKnown; // nie umiemy odczytać postępu z konta
  if (blind && capped) return { watchable: false, status: 'limit', fallback: true };
  const claimedIds = new Set();
  for (const c of camps) for (const d of c.drops || []) if (d.claimed) claimedIds.add(d.id);
  const a = { watchable: false, status: 'done', total: 0, claimed: 0, toClaim: 0, current: null, notConnected: false, camps: camps.length,
    campNames: camps.map((c) => c.name).filter(Boolean).slice(0, 3), fallback: blind };
  let unknown = false;
  for (const c of camps) {
    if (c.connected === false) a.notConnected = true;
    if (!c.drops) { unknown = true; continue; }
    for (const d of c.drops) {
      a.total++;
      if (d.claimed) { a.claimed++; continue; }
      if (d.cur >= d.req) { a.toClaim++; if (!a.claimName) a.claimName = d.name; continue; }
      const blocked = d.preMet === false || (d.preMet === undefined && d.pre.some((id) => !claimedIds.has(id)));
      if (blocked) continue;
      a.watchable = true;
      if (!a.current || d.cur / d.req > a.current.cur / a.current.req) a.current = { name: d.name, cur: d.cur, req: d.req, camp: c.name };
    }
  }
  if (unknown) a.watchable = true;
  a.status = a.watchable ? 'pending' : (a.toClaim ? 'claim' : 'done');
  return a;
}

const gameMinutes = (st, g, now) => gameCamps(st, g, now)
  .reduce((n, c) => n + (c.drops || []).reduce((m, d) => m + d.cur + (d.claimed ? 1e6 : 0), 0), 0);

function selectItem(st, now) {
  for (const g of st.games) {
    if (g.retryAt && g.retryAt > now) continue;
    if (assess(st, g, now).watchable) return g;
  }
  return null;
}

// Czy kampania o tym id jest jeszcze do wbijania (nieznana = tak).
function wanted(st, id, now) {
  const c = st.camps[id];
  if (!c) return true;
  if (!isActive(c, now)) return false;
  if (!c.drops) return true;
  return c.drops.some((d) => !d.claimed && d.cur < d.req);
}

// Z listy kanałów zostawia te, pod którymi Twitch naprawdę pokazuje kampanię tej gry.
// (Sam znacznik „Dropy włączone” nie wystarcza – streamerzy miewają własne dropy kanału w dowolnej kategorii.)
async function offering(st, g, list, now, enough) {
  const out = [];
  for (const part of chunk(list, 12)) {
    const d = await gql(qChanCamps(part.map((c) => c.id)));
    part.forEach((c, k) => {
      const x = d['h' + k];
      const ok = ((x && x.viewerDropCampaigns) || []).some((vc) => vc && vc.game &&
        ((g.gameId && vc.game.id === g.gameId) || (g.slug && vc.game.slug === g.slug)) && hasTimed(vc) && wanted(st, vc.id, now));
      if (ok) out.push(c);
    });
    if (out.length >= (enough || 5)) break;
  }
  return out;
}

// Lista streamów, na których lecą dropy dla gry: ręcznie podane kanały, streamy
// z filtrem „Dropy włączone” w kategorii, kanały wymienione w opisie kampanii – sprawdzone pod kątem kampanii tej gry.
async function candidates(st, g, now) {
  const camps = gameCamps(st, g, now);
  const allowed = new Set();
  camps.forEach((c) => (c.channels || []).forEach((l) => allowed.add(l)));
  const manual = (g.channels || []).map(cleanLogin).filter(Boolean);
  const toCheck = [...new Set([...manual, ...[...allowed].slice(0, 60)])];
  const live = toCheck.length ? await liveStatus(toCheck) : {};
  const dir = await dirStreams(g);
  const list = [];
  const seen = new Set();
  const push = (login, id) => { if (login && id && !seen.has(login)) { seen.add(login); list.push({ login, id }); } };
  for (const l of manual) { const s = live[l]; if (s && s.live && gameMatch(s, g)) push(l, s.id); }
  for (const l of allowed) { const s = live[l]; if (s && s.live && gameMatch(s, g)) push(l, s.id); }
  for (const d of dir) push(d.login, d.id);
  const bad = st.run.bad || {};
  const fresh = list.filter((c) => !(bad[c.login] && bad[c.login] > now - T.bad));
  if (!fresh.length) return [];
  return offering(st, g, fresh.slice(0, 48), now);
}

function newGame(game) {
  return { id: 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36), gameId: game.gameId || '', slug: game.slug || '',
    name: game.name || game.slug || '', icon: game.icon || '', channels: [], limitMin: 0, watchedMs: 0 };
}

// Nowe kampanie w śledzonych grach: gra trafia na koniec kolejki. Zwraca gry, dla których coś doszło.
function detectNew(st, now) {
  const fresh = [];
  for (const t of st.tracked) {
    t.seen = t.seen || [];
    let isNew = false;
    for (const c of gameCamps(st, t, now)) {
      if (!t.seen.includes(c.id)) { t.seen.push(c.id); isNew = true; }
    }
    if (t.seen.length > 60) t.seen.splice(0, t.seen.length - 60);
    if (!isNew) continue;
    let g = st.games.find((x) => sameGame(x, t));
    if (!g) { g = newGame(t); st.games.push(g); log(st, 'bTrackedNew', { game: t.name }); }
    g.retryAt = 0; g.retryStatus = '';
    if (assess(st, g, now).watchable) fresh.push(g);
  }
  return fresh;
}

// ───────────────────────── karta ze streamem ─────────────────────────

function tabMsg(tabId, msg, timeout) {
  if (tabId == null) return Promise.resolve(null);
  return Promise.race([
    chrome.tabs.sendMessage(tabId, Object.assign({ to: 'dropomat-tab' }, msg), { frameId: 0 }).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), timeout || 6000))
  ]);
}

async function getTab(st) {
  const r = st.run;
  if (r.tabId == null) return null;
  try { return await chrome.tabs.get(r.tabId); } catch (e) { r.tabId = null; r.windowId = null; return null; }
}

async function openTab(st, login, forceFull) {
  const r = st.run;
  const now = Date.now();
  const url = `https://www.twitch.tv/${login}#dropomat=${st.settings.quality || '160p30'}`;
  const tab = await getTab(st);
  if (tab) {
    const stale = !r.docSince || now - r.docSince > T.docMax;
    if (!forceFull && !stale) {
      const res = await tabMsg(r.tabId, { cmd: 'nav', path: '/' + login });
      if (res && res.ok) return;
    }
    const samePath = lc((tab.url || '').split('#')[0]).replace(/\/$/, '') === `https://www.twitch.tv/${login}`;
    await chrome.tabs.update(r.tabId, { url });
    if (samePath) await chrome.tabs.reload(r.tabId);
    r.docSince = now; r.activTried = 0;
    return;
  }
  if (T.bgTab) { // test: karta w tle, nigdy niewidoczna (tak jak zminimalizowane okno)
    const t = await chrome.tabs.create({ url, active: false });
    r.windowId = null; r.tabId = t.id; r.docSince = now; r.activTried = 0; r.needClick = false;
    if (!T.noMute) await chrome.tabs.update(t.id, { muted: true, autoDiscardable: false });
    return;
  }
  const opts = { url, focused: false, type: 'normal' };
  if (st.settings.minimized) opts.state = 'minimized'; else { opts.width = 620; opts.height = 460; }
  let w;
  try { w = await chrome.windows.create(opts); } catch (e) {
    w = await chrome.windows.create({ url, focused: false, type: 'normal', width: 620, height: 460 });
    if (st.settings.minimized) { try { await chrome.windows.update(w.id, { state: 'minimized' }); } catch (e2) {} }
  }
  r.windowId = w.id;
  r.tabId = w.tabs && w.tabs[0] ? w.tabs[0].id : null;
  r.docSince = now; r.activTried = 0; r.needClick = false; r.shownForClick = false;
  if (r.tabId != null) {
    try { await chrome.tabs.update(r.tabId, { muted: true, autoDiscardable: false }); } catch (e) {}
  }
}

async function closeTab(st) {
  const id = st.run.tabId;
  st.run.tabId = null; st.run.windowId = null;
  if (id != null) { try { await chrome.tabs.remove(id); } catch (e) {} }
}

// Przeglądarka wymaga „aktywacji użytkownika”, żeby strona mogła grać z dźwiękiem (dźwięk i tak jest wyciszony
// na karcie). Zwykle Twitch ma to z automatu; gdy nie – nadajemy ją karcie przez debugger.
async function debuggerActivate(tabId) {
  const target = { tabId };
  try { await chrome.debugger.attach(target, '1.3'); } catch (e) { return 'attach: ' + String((e && e.message) || e); }
  try {
    const r = await chrome.debugger.sendCommand(target, 'Runtime.evaluate',
      { expression: 'navigator.userActivation.hasBeenActive', userGesture: true, returnByValue: true });
    if (r && r.result && r.result.value === true) return '';
    // zapas: prawdziwe kliknięcie w pusty kwadrat w rogu strony
    const pos = await tabMsg(tabId, { cmd: 'activator' });
    if (!pos || pos.x == null) return 'no page';
    const base = { x: pos.x, y: pos.y, button: 'left', clickCount: 1 };
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', buttons: 1 }, base));
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', buttons: 0 }, base));
    return '';
  } catch (e) { return String((e && e.message) || e); } finally {
    try { await chrome.debugger.detach(target); } catch (e) {}
  }
}

async function handleMuted(st) {
  const r = st.run;
  r.activTried = (r.activTried || 0) + 1;
  if (st.settings.autoUnmute && r.activTried <= 3) {
    r.activErr = await debuggerActivate(r.tabId);
    return;
  }
  if (!r.needClick) {
    r.needClick = true;
    await tabMsg(r.tabId, { cmd: 'overlay', show: true, text: L(st, 'overlay') });
    if (r.windowId != null) { try { await chrome.windows.update(r.windowId, { state: 'normal', focused: false }); } catch (e) {} }
    log(st, 'bNeedClickLog');
    notify(st, 'bNeedClickTitle', 'bNeedClickBody');
  }
}

async function clearNeedClick(st) {
  const r = st.run;
  if (!r.needClick) return;
  r.needClick = false;
  await tabMsg(r.tabId, { cmd: 'overlay', show: false });
  if (st.settings.minimized && r.windowId != null) {
    try { await chrome.windows.update(r.windowId, { state: 'minimized' }); } catch (e) {}
  }
}

// ───────────────────────── odbieranie dropów (opcja) ─────────────────────────
// Twitch przyjmuje odbiór tylko ze swojej strony, więc robimy to tak jak człowiek:
// otwieramy w tle ekwipunek i klikamy przyciski „Odbierz”. Potem sprawdzamy na koncie, czy się udało.

// Dropy gotowe do odebrania. Odbieramy tylko tam, gdzie Twitch potwierdza połączenie konta gry –
// odebranie bez połączonego konta potrafi skończyć się tym, że nagroda nigdzie nie trafia.
function claimables(st, now) {
  const list = [], blocked = [];
  for (const c of Object.values(st.camps)) {
    if (!isActive(c, now) || !st.games.some((g) => matches(c, g))) continue;
    for (const d of c.drops || []) {
      if (d.claimed || !d.hasSelf || d.cur < d.req) continue;
      if (c.connected !== true) { blocked.push({ id: c.id, game: c.gameName || c.name }); continue; }
      if (!(st.claimFail && st.claimFail[d.id])) list.push({ id: d.id, name: d.name });
    }
  }
  return { list, blocked };
}

async function claimViaPage(st) {
  const url = 'https://www.twitch.tv/drops/inventory#dropomat';
  let tabId = null;
  try {
    if (st.run.windowId != null && (await getTab(st))) tabId = (await chrome.tabs.create({ windowId: st.run.windowId, url, active: false })).id;
    else if (T.bgTab) tabId = (await chrome.tabs.create({ url, active: false })).id;
    else {
      let w;
      try { w = await chrome.windows.create({ url, focused: false, type: 'normal', state: 'minimized' }); } catch (e) {
        w = await chrome.windows.create({ url, focused: false, type: 'normal', width: 620, height: 460 });
        try { await chrome.windows.update(w.id, { state: 'minimized' }); } catch (e2) {}
      }
      tabId = w.tabs && w.tabs[0] ? w.tabs[0].id : null;
    }
    if (tabId == null) return 0;
    try { await chrome.tabs.update(tabId, { muted: true }); } catch (e) {}
    let clicked = 0;
    for (let i = 0; i < 11; i++) {
      await sleep(T.claimPoll || 2000);
      const r = await tabMsg(tabId, { cmd: 'claim' }, 9000);
      if (r && r.clicked) {
        clicked += r.clicked;
        await sleep(T.claimPoll || 2500);
        const r2 = await tabMsg(tabId, { cmd: 'claim' }, 9000);
        if (r2 && r2.clicked) clicked += r2.clicked;
        await sleep(1500);
        break;
      }
    }
    return clicked;
  } catch (e) { return 0; } finally {
    if (tabId != null) { try { await chrome.tabs.remove(tabId); } catch (e) {} }
  }
}

async function autoClaim(st, now) {
  // rozliczenie poprzedniej próby – po świeżym odczycie z konta
  if (st.claimPending) {
    const byId = {};
    for (const c of Object.values(st.camps)) for (const d of c.drops || []) byId[d.id] = d;
    for (const p of st.claimPending) {
      const d = byId[p.id];
      if (d && d.claimed) { log(st, 'bClaimed', { name: p.name }); continue; }
      st.claimTries = st.claimTries || {};
      st.claimTries[p.id] = (st.claimTries[p.id] || 0) + 1;
      if (st.claimTries[p.id] >= 2) {
        st.claimFail = st.claimFail || {};
        st.claimFail[p.id] = true;
        log(st, 'bClaimFail', { name: p.name });
        notify(st, 'bClaimFailTitle', 'bClaimFail', { name: p.name });
      }
    }
    st.claimPending = null;
  }
  if (!st.settings.autoClaim || st.auth !== 'ok') { st.claimBlocked = []; return; }
  const { list, blocked } = claimables(st, now);
  st.claimBlocked = [...new Set(blocked.map((b) => b.game))];
  st.claimWarned = st.claimWarned || {};
  for (const b of blocked) {
    if (st.claimWarned[b.id]) continue;
    st.claimWarned[b.id] = true;
    log(st, 'bClaimNoLink', { game: b.game });
    notify(st, 'bClaimNoLinkTitle', 'bClaimNoLink', { game: b.game });
  }
  if (!list.length) return;
  if (st.claimAt && now - st.claimAt < T.claimEvery) return;
  st.claimAt = now;
  const n = await claimViaPage(st);
  st.claimPending = list;
  if (n) log(st, 'bClaiming', { n, names: list.map((x) => x.name).join(', ') }); else log(st, 'bClaimNoBtn');
  st.run.forceCheck = true;
}

// ───────────────────────── sprawdzanie nowej wersji ─────────────────────────
// Rozszerzenie ładowane z folderu nie aktualizuje się samo, więc tylko dajemy znać, że jest co pobrać.
function newer(a, b) { // czy wersja a jest nowsza od b
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
  return false;
}
async function checkUpdate(st, now, force) {
  const url = T.updateUrl || DROPOMAT_UPDATE_URL;
  if (!url) { st.update = null; return; }
  if (!force && st.updAt && now - st.updAt < T.updateEvery) return;
  st.updAt = now;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();
    const v = j && j.version;
    if (v && newer(v, chrome.runtime.getManifest().version)) {
      st.update = { v: String(v), page: (j.page || url.replace(/version\.json.*$/, '')) };
      if (st.updNotified !== st.update.v) { st.updNotified = st.update.v; log(st, 'updAvail', { v: st.update.v }); notify(st, 'updAvail', 'updGet', { v: st.update.v }); }
    } else st.update = null;
  } catch (e) { /* brak sieci – spróbujemy następnym razem */ }
}

// ───────────────────────── kolejka ─────────────────────────

function startRun(st, auto) {
  const keepTab = st.run.tabId, keepWin = st.run.windowId, keepDoc = st.run.docSince;
  st.run = { running: true, phase: 'pick', itemId: null, channel: null, bad: {}, forceCheck: true,
    tabId: keepTab == null ? null : keepTab, windowId: keepWin == null ? null : keepWin, docSince: keepDoc || 0, startedAt: Date.now() };
  if (!auto) {
    for (const g of st.games) { g.retryAt = 0; g.retryStatus = ''; g.limitHit = false; g.watchedMs = 0; }
    st.claimFail = {}; st.claimTries = {}; st.claimAt = 0; st.claimWarned = {};
  }
  log(st, auto ? 'bStartAuto' : 'bStart');
}

async function stopRun(st, key, vars) {
  await closeTab(st);
  st.run = { running: false, msg: key ? L(st, key, vars) : '', msgK: key ? { k: key, v: vars || null } : null };
  if (key) log(st, key, vars);
}

function markBad(st, g, reasonKey) {
  const r = st.run;
  if (r.channel) {
    r.bad = r.bad || {};
    r.bad[r.channel] = Date.now();
    log(st, 'bBadStream', { channel: r.channel, reason: '@' + reasonKey });
  }
  r.phase = 'pick'; r.channel = null; r.channelId = null; r.session = null; r.playing = null;
}

function statusKey(a, g, now) {
  const s = g && g.retryAt && g.retryAt > now ? g.retryStatus : a.status;
  return ({ done: 'stDone', claim: 'stClaim', nodrops: 'stNodrops', limit: 'stLimit', nostreams: 'stNostreams', stuck: 'stStuck', pending: 'stPending' })[s] || 'stPending';
}

async function tick(st) {
  const now = Date.now();
  const r = st.run;
  st.aliveAt = now;
  await checkUpdate(st, now, false);

  if (!r.running) {
    if (!st.settings.autoTrack || !st.tracked.length) return;
    if (st.dropsAt && now - st.dropsAt < trackMs(st)) return;
    await refreshDrops(st);
    const fresh = detectNew(st, now);
    if (fresh.length) {
      notify(st, 'bNewTitle', 'bNewBody', { games: fresh.map((g) => g.name).join(', ') });
      startRun(st, true);
    }
    return;
  }

  const needCheck = r.forceCheck || !st.dropsAt || now - st.dropsAt >= checkMs(st);
  if (needCheck) {
    r.forceCheck = false;
    await refreshDrops(st);
    const fresh = detectNew(st, now);
    if (fresh.length && r.phase === 'wait') notify(st, 'bNewTitle', 'bNewBody', { games: fresh.map((g) => g.name).join(', ') });
    if (st.auth === 'nologin') {
      await stopRun(st, 'bStopNoLogin');
      notify(st, 'bStoppedTitle', 'bStopNoLogin');
      return;
    }
    await autoClaim(st, now);
  }

  // Która gra teraz? Zawsze pierwsza z listy, w której da się coś wbić.
  let g = st.games.find((x) => x.id === r.itemId) || null;
  const best = selectItem(st, now);
  if (!best) {
    const later = st.games.some((x) => (x.retryAt && x.retryAt > now) || assess(st, x, now).status === 'claim');
    await closeTab(st);
    r.itemId = null; r.channel = null; r.session = null; r.playing = null;
    if (!later) {
      const had = st.games.length;
      await stopRun(st, had ? 'bQueueDone' : 'bQueueEmpty');
      if (had) notify(st, 'bQueueDoneTitle', 'bQueueDone');
      return;
    }
    if (r.phase !== 'wait') log(st, 'bWaiting');
    r.phase = 'wait';
    return;
  }
  if (!g || best.id !== g.id) {
    if (g && r.phase === 'watch') log(st, 'bMoveOn', { game: g.name, status: '@' + statusKey(assess(st, g, now), g, now) });
    g = best;
    r.itemId = g.id; r.phase = 'pick'; r.channel = null; r.channelId = null; r.session = null; r.playing = null;
    r.stallSwitches = 0;
    log(st, 'bGame', { game: g.name });
  }
  if (r.phase === 'wait' || !r.phase) r.phase = 'pick';

  if (r.phase === 'pick') {
    let cands;
    try { cands = await candidates(st, g, now); } catch (e) {
      r.msgK = { k: 'bNoNet', v: null }; r.msg = L(st, 'bNoNet');
      return;
    }
    r.msg = ''; r.msgK = null;
    if (!cands.length) {
      g.retryAt = now + T.retryNoStreams; g.retryStatus = 'nostreams';
      log(st, 'bNoStreams', { game: g.name });
      r.itemId = null;
      return;
    }
    const c = cands[0];
    r.channel = c.login; r.channelId = c.id; r.phase = 'load'; r.since = now;
    r.badPlay = 0; r.noResp = 0; r.progAt = now; r.progSig = null; r.session = null; r.liveAt = now; r.playing = null;
    log(st, 'bWatching', { game: g.name, channel: c.login });
    await openTab(st, c.login, false);
    return;
  }

  if (r.phase === 'load') {
    if (now - r.since < T.loadWait) return;
    if (!(await getTab(st))) { await openTab(st, r.channel, true); r.since = now; return; }
    const s = await tabMsg(r.tabId, { cmd: 'status', fix: true });
    if (s && (s.needActivation || (s.video && s.video.muted))) await handleMuted(st);
    if (s && s.video && s.video.advancing && s.channel === r.channel) {
      r.phase = 'watch'; r.lastTick = now; r.badPlay = 0;
      r.playing = { muted: s.video.muted, height: s.video.height, hidden: !!s.realHidden };
      if (!s.video.muted) await clearNeedClick(st);
      return;
    }
    if (now - r.since > T.loadTimeout) {
      if (!s && !r.reloaded) { r.reloaded = true; r.since = now; await openTab(st, r.channel, true); return; }
      r.reloaded = false;
      markBad(st, g, 'rNoStart');
    }
    return;
  }

  if (r.phase === 'watch') {
    const dt = Math.max(0, Math.min(now - (r.lastTick || now), 90000));
    r.lastTick = now;

    if (now - (r.liveAt || 0) >= T.live) {
      r.liveAt = now;
      try {
        const s = (await liveStatus([r.channel]))[r.channel];
        if (!s || !s.live) return markBad(st, g, 'rEnded');
        if (!gameMatch(s, g)) return markBad(st, g, 'rGameChanged');
        r.channelId = s.id;
      } catch (e) { /* chwilowy brak sieci – sprawdzimy w następnym kroku */ }
    }

    if (!(await getTab(st))) { r.phase = 'load'; r.since = now; await openTab(st, r.channel, true); return; }
    const s = await tabMsg(r.tabId, { cmd: 'status', fix: true });
    if (!s) {
      r.noResp = (r.noResp || 0) + 1;
      if (r.noResp >= 3) { r.noResp = 0; r.phase = 'load'; r.since = now; await openTab(st, r.channel, true); }
      return;
    }
    r.noResp = 0;
    if (s.channel !== r.channel) return markBad(st, g, 'rRedirect');
    if (s.needActivation || (s.video && s.video.muted)) await handleMuted(st);
    else await clearNeedClick(st);
    if (!s.video || !s.video.advancing) {
      r.badPlay = (r.badPlay || 0) + 1;
      if (r.badPlay === 3) { r.phase = 'load'; r.since = now; await openTab(st, r.channel, true); return; }
      if (r.badPlay >= 6) return markBad(st, g, 'rStalled');
      return;
    }
    r.badPlay = 0;
    r.playing = { muted: s.video.muted, height: s.video.height, hidden: !!s.realHidden };
    g.watchedMs = (g.watchedMs || 0) + dt;

    if (g.limitMin && g.watchedMs >= g.limitMin * 60000) {
      g.limitHit = true;
      log(st, 'bLimit', { game: g.name });
      return;
    }

    if (needCheck) {
      if (st.auth === 'ok') {
        try { r.session = await sessionProg(r.channelId); } catch (e) {}
        const readable = st.progKnown || !!r.session;
        const sig = gameMinutes(st, g, now) + '|' + (r.session ? r.session.dropId + ':' + r.session.cur : '');
        if (!readable) { r.progSig = null; r.progAt = now; }
        else if (r.progSig == null) r.progSig = sig;
        else if (sig !== r.progSig) { r.progSig = sig; r.progAt = now; r.progOk = now; r.stallSwitches = 0; }
        else if (now - r.progAt >= stallMs(st)) {
          r.stallSwitches = (r.stallSwitches || 0) + 1;
          if (r.stallSwitches >= 3) {
            g.retryAt = now + T.retryStuck; g.retryStatus = 'stuck';
            log(st, 'bStuck', { game: g.name });
            notify(st, 'bStuckTitle', 'bStuckBody', { game: g.name });
            r.itemId = null; r.phase = 'pick'; r.channel = null;
            return;
          }
          return markBad(st, g, 'rNoProgress');
        }
      }
      try {
        const still = await offering(st, g, [{ login: r.channel, id: r.channelId }], now, 1);
        if (!still.length) return markBad(st, g, 'rDropsOff');
      } catch (e) {}
    }
  }
}

// Po dodaniu gry dociągamy jej dropy w tle – jedno odświeżenie na serię kliknięć.
let dirtyTimer = null;
function refreshSoon() {
  if (dirtyTimer) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    dirtyTimer = null;
    locked(async () => {
      const st = await load();
      if (!st.dirty) return;
      await refreshDrops(st);
      detectNew(st, Date.now());
      await save(st);
    });
  }, T.dirtyWait || 1200);
}

let fastTimer = null;
function runTick() {
  return locked(async () => {
    const st = await load();
    try { await tick(st); } catch (e) { log(st, 'bError', { msg: String((e && e.message) || e) }); }
    await save(st);
    const r = st.run;
    if (fastTimer) { clearTimeout(fastTimer); fastTimer = null; }
    const quick = r.running && (r.phase === 'pick' || r.phase === 'load' || !r.itemId) && r.phase !== 'wait';
    const delay = quick ? T.fast : T.loop;
    if (delay) fastTimer = setTimeout(() => { fastTimer = null; runTick(); }, delay);
  });
}

// ───────────────────────── zdarzenia ─────────────────────────

async function ensureAlarm() {
  try {
    const a = await chrome.alarms.get('tick');
    if (!a) await chrome.alarms.create('tick', { periodInMinutes: 0.5 });
  } catch (e) {}
}

async function setupRules() {
  // Zapytania rozszerzenia do Twitcha idą z takim samym nagłówkiem Origin jak ze strony twitch.tv.
  const rule = {
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [
      { header: 'Origin', operation: 'set', value: 'https://www.twitch.tv' },
      { header: 'Referer', operation: 'set', value: 'https://www.twitch.tv/' }] },
    condition: { urlFilter: '||gql.twitch.tv/gql', initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] }
  };
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [rule] }); } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); setupRules(); });
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm(); setupRules();
  locked(async () => {
    const st = await load();
    // Okno znikło razem z zamknięciem przeglądarki (a nie przez Stop) – po starcie wznawiamy.
    if (!st.run.running && st.run.autoStopped && (st.aliveAt || 0) <= st.run.closedAt && st.games.length) {
      startRun(st, true);
      log(st, 'bResumed');
    } else if (st.run.running) { st.run.tabId = null; st.run.windowId = null; st.run.phase = 'pick'; st.run.channel = null; st.run.forceCheck = true; }
    await save(st);
  }).then(runTick);
});
ensureAlarm();
setupRules();

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') runTick(); });

chrome.tabs.onRemoved.addListener((tabId) => {
  locked(async () => {
    const st = await load();
    if (st.run.tabId !== tabId) return;
    st.run.tabId = null; st.run.windowId = null;
    if (st.run.running) {
      await stopRun(st, 'bWindowClosed');
      st.run.autoStopped = true; st.run.closedAt = Date.now();
    }
    await save(st);
  });
});

chrome.notifications.onClicked.addListener(() => {
  locked(async () => {
    const st = await load();
    if (st.run.windowId != null) { try { await chrome.windows.update(st.run.windowId, { state: 'normal', focused: true }); } catch (e) {} }
  });
});

// Dropy gry do pokazania w kolejce (ikona + stan).
function dropList(st, g, now) {
  const camps = gameCamps(st, g, now);
  const claimedIds = new Set();
  for (const c of camps) for (const d of c.drops || []) if (d.claimed) claimedIds.add(d.id);
  const out = [];
  for (const c of camps) {
    for (const d of c.drops || []) {
      const blocked = d.preMet === false || (d.preMet === undefined && d.pre.some((id) => !claimedIds.has(id)));
      const state = d.claimed ? 'claimed' : d.cur >= d.req ? 'ready' : blocked ? 'locked' : 'progress';
      out.push({ name: d.name, img: d.img || '', cur: Math.min(d.cur, d.req), req: d.req, state, camp: c.name });
    }
  }
  return out.slice(0, 16);
}

// Otwarte kampanie pogrupowane po grze – do zakładki „Kampanie”.
function campaignGroups(st, now) {
  const groups = new Map();
  for (const c of Object.values(st.camps)) {
    if (!isActive(c, now) || !(c.gameId || c.gameSlug)) continue;
    if (c.drops && !c.drops.length) continue; // same odznaki, nic do wbicia oglądaniem
    const key = c.gameId || c.gameSlug;
    let gr = groups.get(key);
    if (!gr) { gr = { gameId: c.gameId, slug: c.gameSlug, name: c.gameName || c.gameSlug, icon: c.gameIcon || '', camps: [], endAt: 0 }; groups.set(key, gr); }
    if (!gr.icon && c.gameIcon) gr.icon = c.gameIcon;
    if (!gr.slug && c.gameSlug) gr.slug = c.gameSlug;
    gr.camps.push({ id: c.id, name: c.name, endAt: c.endAt });
    gr.endAt = Math.max(gr.endAt, c.endAt || 0);
  }
  const out = [...groups.values()];
  for (const gr of out) {
    gr.pos = st.games.findIndex((g) => sameGame(g, gr)) + 1;
    gr.tracked = st.tracked.some((t) => sameGame(t, gr));
    gr.camps.sort((a, b) => a.endAt - b.endAt);
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function view(st) {
  const now = Date.now();
  return {
    now, auth: st.auth || '', login: st.login || '', authErr: st.authErr || '', dropsAt: st.dropsAt || 0, lang: langOf(st),
    settings: st.settings, run: st.run, log: st.log.slice(-40), diag: st.diag || null, progKnown: !!st.progKnown,
    update: st.update || null, version: chrome.runtime.getManifest().version,
    campaigns: campaignGroups(st, now), claimBlocked: st.settings.autoClaim ? (st.claimBlocked || []) : [],
    tracked: st.tracked.map((t) => ({ gameId: t.gameId, slug: t.slug, name: t.name, icon: t.icon || '', active: gameCamps(st, t, now).length,
      queued: st.games.some((g) => sameGame(g, t)) })),
    games: st.games.map((g) => {
      const a = assess(st, g, now);
      let status = a.status;
      if (g.retryAt && g.retryAt > now && a.watchable) status = g.retryStatus || status;
      if (st.run.running && st.run.itemId === g.id && (st.run.phase === 'watch' || st.run.phase === 'load')) status = 'watching';
      return { id: g.id, name: g.name, slug: g.slug, gameId: g.gameId || '', icon: g.icon || '', track: st.tracked.some((t) => sameGame(t, g)), channels: g.channels || [], limitMin: g.limitMin || 0,
        watchedMs: g.watchedMs || 0, retryAt: g.retryAt || 0, status, a, drops: dropList(st, g, now) };
    })
  };
}

async function searchGames(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const out = [];
  const add = (n) => { if (n && n.slug && !out.some((x) => x.slug === n.slug)) out.push({ gameId: n.id, slug: n.slug, name: n.displayName || n.slug, icon: n.boxArtURL || '' }); };
  const m = /directory\/category\/([^/?#]+)/.exec(q);
  try {
    if (m) add((await gql(qGameInfo({ slug: decodeURIComponent(m[1]) }))).game);
    else {
      const d = await gql(`{ searchCategories(query:${JSON.stringify(q)}, first:6){ edges{ node{ id slug displayName boxArtURL(width:52, height:72) } } } }`);
      ((d.searchCategories && d.searchCategories.edges) || []).forEach((e) => add(e && e.node));
    }
  } catch (e) {}
  return out;
}

const validGame = (game) => !!(game && (game.slug || game.gameId));

const OPS = {
  async get(st) { return view(st); },
  async refresh(st) { await checkUpdate(st, Date.now(), false); await refreshDrops(st); detectNew(st, Date.now()); return view(st); },
  // Pełne odświeżenie listy kampanii na żądanie.
  async rescan(st) { st.page = null; st.pub = null; await refreshDrops(st); detectNew(st, Date.now()); return view(st); },
  // Dodanie gry do kolejki (z wyszukiwarki). Szybkie – dane o dropach dociągają się chwilę później.
  async add(st, msg) {
    const game = msg.game || {};
    if (!validGame(game)) return { error: 'no game' };
    if (st.games.some((g) => sameGame(g, game))) return Object.assign(view(st), { error: L(st, 'eAlready') });
    st.games.push(newGame(game));
    st.dirty = true;
    return view(st);
  },
  // Kliknięcie kampanii: nie ma w kolejce → na koniec; jest → wypada.
  async toggleQueue(st, msg) {
    const game = msg.game || {};
    if (!validGame(game)) return { error: 'no game' };
    const i = st.games.findIndex((g) => sameGame(g, game));
    if (i >= 0) {
      const g = st.games[i];
      st.games.splice(i, 1);
      if (st.run.itemId === g.id) { st.run.itemId = null; st.run.phase = 'pick'; st.run.channel = null; }
    } else { st.games.push(newGame(game)); st.dirty = true; }
    return view(st);
  },
  // Śledzenie gry: nowe kampanie same trafiają do kolejki. Kampanie istniejące w chwili zaznaczenia liczą się jako znane.
  async track(st, msg) {
    const game = msg.game || {};
    if (!validGame(game)) return { error: 'no game' };
    const i = st.tracked.findIndex((t) => sameGame(t, game));
    const on = 'on' in msg ? !!msg.on : i < 0;
    if (!on) { if (i >= 0) st.tracked.splice(i, 1); return view(st); }
    if (i < 0) {
      const t = { gameId: game.gameId || '', slug: game.slug || '', name: game.name || game.slug || '', icon: game.icon || '', seen: [] };
      t.seen = gameCamps(st, t, Date.now()).map((c) => c.id);
      st.tracked.push(t);
      st.dirty = true;
    }
    return view(st);
  },
  async clearDone(st) {
    const now = Date.now();
    st.games = st.games.filter((g) => !['done', 'nodrops'].includes(assess(st, g, now).status) || st.run.itemId === g.id);
    return view(st);
  },
  async remove(st, msg) {
    st.games = st.games.filter((g) => g.id !== msg.id);
    if (st.run.itemId === msg.id) { st.run.itemId = null; st.run.phase = 'pick'; st.run.channel = null; }
    return view(st);
  },
  async reorder(st, msg) {
    const ids = Array.isArray(msg.ids) ? msg.ids : [];
    const byId = new Map(st.games.map((g) => [g.id, g]));
    const next = [];
    for (const id of ids) if (byId.has(id)) { next.push(byId.get(id)); byId.delete(id); }
    st.games = next.concat([...byId.values()]);
    return view(st);
  },
  async update(st, msg) {
    const g = st.games.find((x) => x.id === msg.id);
    if (!g) return view(st);
    const p = msg.patch || {};
    if ('channels' in p) g.channels = [...new Set((p.channels || []).map(cleanLogin).filter(Boolean))].slice(0, 40);
    if ('limitMin' in p) { g.limitMin = Math.max(0, Math.round(Number(p.limitMin) || 0)); g.limitHit = false; }
    if (p.retry) { g.retryAt = 0; g.retryStatus = ''; g.limitHit = false; g.watchedMs = 0; }
    return view(st);
  },
  async settings(st, msg) {
    const p = msg.patch || {};
    for (const k of Object.keys(DEF_SETTINGS)) {
      if (!(k in p)) continue;
      st.settings[k] = typeof DEF_SETTINGS[k] === 'number' ? (Number(p[k]) || DEF_SETTINGS[k]) : typeof DEF_SETTINGS[k] === 'boolean' ? !!p[k] : String(p[k]);
    }
    if ('autoClaim' in p) { st.claimFail = {}; st.claimTries = {}; st.claimAt = 0; st.claimWarned = {}; st.claimBlocked = []; if (st.run.running) st.run.forceCheck = true; }
    return view(st);
  },
  async start(st) {
    if (!st.games.length) return Object.assign(view(st), { error: L(st, 'eAddFirst') });
    startRun(st, false);
    return view(st);
  },
  async stop(st) { await stopRun(st, 'bStopped'); return view(st); },
  async skip(st) {
    const g = st.games.find((x) => x.id === st.run.itemId);
    if (st.run.running && st.run.channel && g) markBad(st, g, 'rSkipped');
    return view(st);
  },
  async showWindow(st) {
    if (st.run.windowId != null) { try { await chrome.windows.update(st.run.windowId, { state: 'normal', focused: true }); } catch (e) {} }
    return view(st);
  },
  async clearLog(st) { st.log = []; return view(st); }
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.to !== 'dropomat-bg') return;
  if (msg.op === 'pageCamps') { // dane odczytane ze strony kampanii Twitcha (poza kolejką – zbiera je capturePage)
    if (pageBuf && Array.isArray(msg.list)) { for (const c of msg.list.slice(0, 600)) pageBuf.list.push(c); pageBuf.at = Date.now(); }
    respond({ ok: true });
    return;
  }
  if (msg.op === 'search') { searchGames(msg.q).then(respond, () => respond([])); return true; }
  if (msg.op === 'get') { load().then((st) => respond(view(st)), () => respond(null)); return true; }
  const fn = OPS[msg.op];
  if (!fn) { respond({ error: 'unknown' }); return; }
  locked(async () => {
    const st = await load();
    let res;
    try { res = await fn(st, msg); } catch (e) { res = { error: String((e && e.message) || e) }; }
    await save(st);
    return res;
  }).then((res) => {
    respond(res);
    if (['start', 'skip', 'remove', 'reorder', 'update', 'add', 'toggleQueue', 'clearDone'].includes(msg.op)) runTick();
    if (['add', 'toggleQueue', 'track'].includes(msg.op)) refreshSoon();
  }, () => respond({ error: 'failed' }));
  return true;
});
