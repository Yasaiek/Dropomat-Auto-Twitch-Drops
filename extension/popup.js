'use strict';
const $ = (id) => document.getElementById(id);
const send = (op, extra) => chrome.runtime.sendMessage(Object.assign({ to: 'dropomat-bg', op }, extra || {}));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const same = (a, b) => !!((a.gameId && a.gameId === b.gameId) || (a.slug && a.slug === b.slug));
const gameOf = (x) => ({ gameId: x.gameId || '', slug: x.slug || '', name: x.name, icon: x.icon || '' });

// ───────── język ─────────
let lang = resolveLang('auto');
const t = (key, vars) => tr(lang, key, vars);
const hm = (ts) => new Date(ts).toLocaleTimeString(langLocale(lang), { hour: '2-digit', minute: '2-digit' });
const dm = (ts) => new Date(ts).toLocaleString(langLocale(lang), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const mins = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} ${t('min')}` : `${m} ${t('min')}`; };
const STATUS = { watching: 'stWatching', pending: 'stPending', done: 'stDone', claim: 'stClaim', nodrops: 'stNodrops', nostreams: 'stNostreams', stuck: 'stStuck', limit: 'stLimit' };
const DROP_STATE = { claimed: 'dClaimed', ready: 'dReady', locked: 'dLocked', progress: 'dProgress' };

function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
}

let state = null;
let expanded = null;
let listSig = '', campSig = '', trackSig = '', langSig = '';
let dragId = null;
let pending = 0; // operacje w drodze – w tym czasie nie nadpisujemy widoku starszym odczytem

// ───────── zakładki ─────────
let tab = 'camps';
try { tab = localStorage.getItem('tab') || 'camps'; } catch (e) {}
function showTab(name) {
  tab = name;
  try { localStorage.setItem('tab', name); } catch (e) {}
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

function art(icon, cls) {
  const box = el('div', cls || 'art');
  if (icon) { const im = el('img'); im.src = icon; im.alt = ''; im.draggable = false; im.onerror = () => im.remove(); box.append(im); }
  return box;
}
function flag(code) { const s = el('span', 'flag'); s.innerHTML = flagSvg(code); return s; }

// ───────── wybór języka (z flagami) ─────────
function renderLang(s) {
  const pref = (s.settings && s.settings.lang) || 'auto';
  const sig = pref + '|' + lang;
  if (sig === langSig) return;
  langSig = sig;
  const btn = $('langBtn');
  btn.textContent = '';
  const name = (code) => (LANGS.find((l) => l.code === code) || {}).name || code;
  btn.append(flag(pref === 'auto' ? lang : pref), el('span', '', pref === 'auto' ? `${t('sAuto')} · ${name(lang)}` : name(pref)), el('span', 'caret', '▾'));
  const menu = $('langMenu');
  menu.textContent = '';
  const add = (code, label, flagCode) => {
    const o = el('button', 'lang-opt' + (code === pref ? ' on' : ''));
    o.setAttribute('role', 'option');
    o.dataset.lang = code;
    o.append(flag(flagCode), el('span', '', label));
    o.onclick = () => { menu.hidden = true; act('settings', { patch: { lang: code } }); };
    menu.append(o);
  };
  add('auto', t('sAuto'), resolveLang('auto'));
  for (const l of LANGS) add(l.code, l.name, l.code);
}
$('langBtn').onclick = (e) => { e.stopPropagation(); $('langMenu').hidden = !$('langMenu').hidden; };
document.addEventListener('click', (e) => { if (!e.target.closest('.lang-row')) $('langMenu').hidden = true; });

// ───────── Kampanie ─────────
function renderCamps(s) {
  const f = $('filter').value.trim().toLowerCase();
  const rows = (s.campaigns || []).filter((c) => !f || String(c.name).toLowerCase().includes(f) || c.camps.some((x) => (x.name || '').toLowerCase().includes(f)));
  const sig = JSON.stringify([rows.map((c) => [c.gameId, c.slug, c.pos, c.tracked, c.icon, c.camps.length, c.endAt]), f, s.auth, s.dropsAt > 0, lang]);
  if (sig === campSig) return;
  campSig = sig;
  const box = $('camps');
  const keep = box.scrollTop;
  box.textContent = '';
  if (!rows.length) {
    box.append(el('div', 'empty', !s.dropsAt ? t('campsLoading') : f ? t('campsNoMatch') : t('campsNone')));
    return;
  }
  for (const c of rows) {
    const row = el('button', 'camp' + (c.pos ? ' queued' : ''));
    row.title = c.camps.map((x) => `${x.name}${x.endAt ? ' — ' + t('until', { date: dm(x.endAt) }) : ''}`).join('\n') + '\n\n' + t(c.pos ? 'tipRemove' : 'tipAdd') + ' · ' + t('tipTrack');
    const text = el('div', 'camp-text');
    text.append(el('div', 'camp-name', c.name));
    const sub = c.camps.length === 1 ? c.camps[0].name : t('nCamps', { n: c.camps.length });
    text.append(el('div', 'camp-sub sub', sub + (c.endAt ? ' · ' + t('until', { date: dm(c.endAt) }) : '')));
    row.append(art(c.icon), text);
    if (c.tracked) row.append(el('span', 'star-mark', '★'));
    row.append(el('span', 'num-badge' + (c.pos ? ' on' : ''), c.pos ? String(c.pos) : '+'));
    row.onclick = () => toggleQueue(c);
    row.oncontextmenu = (e) => { e.preventDefault(); toggleTrack(c); };
    box.append(row);
  }
  box.scrollTop = keep;
}

// Numer pojawia się od razu po kliknięciu; tło potwierdza chwilę później.
function toggleQueue(c) {
  const s = state;
  const i = s.games.findIndex((g) => same(g, c));
  if (i >= 0) s.games.splice(i, 1);
  else s.games.push({ id: 'tmp' + Date.now(), gameId: c.gameId, slug: c.slug, name: c.name, icon: c.icon, status: 'pending', a: {}, drops: [], channels: [], limitMin: 0, watchedMs: 0, track: c.tracked });
  for (const x of s.campaigns) x.pos = s.games.findIndex((g) => same(g, x)) + 1;
  render(s);
  act('toggleQueue', { game: gameOf(c) });
}
function toggleTrack(c) {
  const s = state;
  const on = !s.tracked.some((x) => same(x, c));
  if (on) s.tracked.push({ gameId: c.gameId, slug: c.slug, name: c.name, icon: c.icon, active: 1, queued: false });
  else s.tracked = s.tracked.filter((x) => !same(x, c));
  for (const x of s.campaigns) x.tracked = s.tracked.some((y) => same(y, x));
  for (const g of s.games) g.track = s.tracked.some((y) => same(y, g));
  render(s);
  act('track', { game: gameOf(c), on });
}

// ───────── Oglądane (kolejka) ─────────
function gameSub(g, now) {
  const a = g.a || {};
  const parts = [];
  if (a.current) parts.push(`${a.current.name ? a.current.name + ': ' : ''}${a.current.cur}/${a.current.req} ${t('min')}`);
  if (g.status === 'claim' || a.toClaim) parts.push(t('sToClaim', { n: a.toClaim || 0 }) + (a.claimName ? ' (' + a.claimName + ')' : ''));
  if (a.total) parts.push(t('sClaimedOf', { a: a.claimed, b: a.total }));
  if (g.status === 'nodrops') parts.push(a.nextAt ? t('sStartAt', { date: dm(a.nextAt) }) : t('sNoCamp'));
  if ((g.status === 'nostreams' || g.status === 'stuck') && g.retryAt > now) parts.push(t('sRetryAt', { time: hm(g.retryAt) }));
  if (a.fallback && g.status !== 'nodrops') parts.push(t('sNoProg'));
  if (!a.current && !a.total && a.campNames && a.campNames.length) parts.push(a.campNames[0]);
  if (g.watchedMs > 60000) parts.push(t('sWatched', { t: mins(g.watchedMs) }));
  return parts.join(' · ');
}

function dropIcons(g) {
  const row = el('div', 'drops');
  for (const d of g.drops || []) {
    const pct = d.req ? Math.round((d.cur / d.req) * 100) : 0;
    const box = el('div', 'drop ' + d.state);
    box.title = `${d.name} — ${d.state === 'progress' || d.state === 'locked' ? d.cur + '/' + d.req + ' ' + t('min') + ' · ' : ''}${t(DROP_STATE[d.state] || 'dProgress')}${d.camp ? '\n' + d.camp : ''}`;
    box.style.setProperty('--p', pct + '%');
    if (d.img) { const im = el('img'); im.src = d.img; im.alt = ''; im.draggable = false; im.onerror = () => im.remove(); box.append(im); }
    if (d.state === 'claimed') box.append(el('span', 'badge', '✓'));
    if (d.state === 'ready') box.append(el('span', 'badge', '!'));
    row.append(box);
  }
  return row;
}

function renderList(s) {
  const sig = JSON.stringify([s.games.map((g) => [g.id, g.name, g.icon, g.status, g.track, gameSub(g, s.now), g.channels, g.limitMin, g.drops]), expanded, s.run.itemId, lang]);
  const editing = document.activeElement && document.activeElement.closest && document.activeElement.closest('.item-more');
  if (sig === listSig || editing || dragId) return;
  listSig = sig;
  const list = $('list');
  list.textContent = '';
  $('clearDone').hidden = !s.games.some((g) => g.status === 'done' || g.status === 'nodrops');
  if (!s.games.length) { list.append(el('div', 'empty', t('queueEmpty'))); return; }
  s.games.forEach((g, i) => {
    const item = el('div', 'item' + (s.run.running && s.run.itemId === g.id ? ' cur' : ''));
    item.dataset.id = g.id;
    const main = el('div', 'item-main');
    main.draggable = true;
    main.title = t('dragTip');
    const text = el('div', 'item-text');
    text.append(el('div', 'item-name', g.name), el('div', 'item-sub sub', gameSub(g, s.now) || ' '));
    const chip = el('span', 'chip ' + g.status, t(STATUS[g.status] || 'stPending'));
    const star = el('button', 'icon star' + (g.track ? ' on' : ''), g.track ? '★' : '☆');
    star.title = t(g.track ? 'trackOn' : 'trackOff');
    star.onclick = () => toggleTrack(g);
    const more = el('button', 'icon', '⋯'); more.title = t('more');
    more.onclick = () => { expanded = expanded === g.id ? null : g.id; listSig = ''; renderList(state); };
    const del = el('button', 'icon', '✕'); del.title = t('remove');
    del.onclick = () => act('remove', { id: g.id });
    main.append(el('span', 'pos', String(i + 1)), art(g.icon), text, chip, star, more, del);
    item.append(main);
    if (g.drops && g.drops.length) item.append(dropIcons(g));
    if (expanded === g.id) {
      const box = el('div', 'item-more');
      const l1 = el('label', '', t('chLabel'));
      const ch = el('input'); ch.type = 'text'; ch.value = (g.channels || []).join(', '); ch.placeholder = t('chPh');
      ch.onchange = () => act('update', { id: g.id, patch: { channels: ch.value.split(/[\s,;]+/) } });
      l1.append(ch);
      const l2 = el('label', 'inline', t('limitLabel'));
      const lim = el('input'); lim.type = 'number'; lim.min = '0'; lim.value = String(g.limitMin || 0);
      lim.onchange = () => act('update', { id: g.id, patch: { limitMin: lim.value } });
      l2.append(lim);
      const retry = el('button', 'btn ghost', t('retry'));
      retry.onclick = () => act('update', { id: g.id, patch: { retry: true } });
      box.append(l1, l2, retry);
      item.append(box);
    }
    list.append(item);
  });
}

// przeciąganie gier w kolejce
(function dnd() {
  const list = $('list');
  const clear = () => list.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'dragging'));
  const target = (e) => {
    const item = e.target.closest && e.target.closest('.item');
    if (!item || !list.contains(item)) return null;
    const r = item.getBoundingClientRect();
    return { item, after: e.clientY > r.top + r.height / 2 };
  };
  list.addEventListener('dragstart', (e) => {
    const item = e.target.closest && e.target.closest('.item');
    if (!item) return;
    dragId = item.dataset.id;
    item.classList.add('dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', dragId); } catch (err) {} }
  });
  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const tg = target(e);
    list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    if (tg && tg.item.dataset.id !== dragId) tg.item.classList.add(tg.after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const tg = target(e);
    const id = dragId;
    dragId = null; clear();
    if (!tg || tg.item.dataset.id === id) return;
    const ids = [...list.querySelectorAll('.item')].map((n) => n.dataset.id).filter((x) => x !== id);
    let at = ids.indexOf(tg.item.dataset.id);
    if (tg.after) at++;
    ids.splice(at, 0, id);
    const byId = new Map(state.games.map((g) => [g.id, g]));
    state.games = ids.map((x) => byId.get(x)).filter(Boolean);
    for (const x of state.campaigns) x.pos = state.games.findIndex((g) => same(g, x)) + 1;
    listSig = '';
    render(state);
    act('reorder', { ids });
  });
  list.addEventListener('dragend', () => { dragId = null; clear(); listSig = ''; if (state) renderList(state); });
})();

// ───────── Śledzone ─────────
function renderTracked(s) {
  const sig = JSON.stringify([s.tracked, lang]);
  if (sig === trackSig) return;
  trackSig = sig;
  const list = $('trackedList');
  list.textContent = '';
  if (!s.tracked.length) { list.append(el('div', 'empty', t('trackedEmpty'))); return; }
  for (const x of s.tracked) {
    const item = el('div', 'item');
    const main = el('div', 'item-main plain');
    const text = el('div', 'item-text');
    text.append(el('div', 'item-name', x.name), el('div', 'item-sub sub', t(x.active ? (x.queued ? 'tActiveQ' : 'tActive') : 'tWait')));
    const del = el('button', 'icon', '✕'); del.title = t('untrack');
    del.onclick = () => toggleTrack(x);
    main.append(el('span', 'pos star-pos', '★'), art(x.icon), text, del);
    item.append(main);
    list.append(item);
  }
}

// Odpowiedź ze starszej wersji tła (rozszerzenie nieprzeładowane po podmianie plików) nie ma nowych pól.
function stale(s) { return !!s && (!Array.isArray(s.campaigns) || !s.lang); }
function reloadExtension() {
  let last = 0;
  try { last = Number(localStorage.getItem('reloadAt')) || 0; } catch (e) {}
  if (Date.now() - last < 60000) return false; // nie w kółko
  try { localStorage.setItem('reloadAt', String(Date.now())); } catch (e) {}
  chrome.runtime.reload();
  return true;
}

// ───────── całość ─────────
function render(s) {
  if (!s) return;
  if (stale(s) && reloadExtension()) return;
  s.games = s.games || []; s.tracked = s.tracked || []; s.campaigns = s.campaigns || [];
  s.settings = s.settings || {}; s.log = s.log || []; s.run = s.run || {};
  for (const g of s.games) { g.a = g.a || {}; g.drops = g.drops || []; g.channels = g.channels || []; }
  state = s;
  const newLang = s.lang && LOCALES[s.lang] ? s.lang : resolveLang(s.settings.lang);
  if (newLang !== lang) { lang = newLang; applyI18n(); }
  const r = s.run;
  const cur = s.games.find((g) => g.id === r.itemId);

  const pill = $('pill');
  pill.className = 'pill' + (r.running ? (r.phase === 'wait' ? ' wait' : ' on') : '');
  pill.textContent = t(!r.running ? 'pillStopped' : r.phase === 'wait' ? 'pillWait' : 'pillOn');
  const tg = $('toggle');
  tg.textContent = t(r.running ? 'stop' : 'start');
  tg.className = 'btn primary' + (r.running ? ' stop' : '');
  $('nQueue').textContent = s.games.length ? String(s.games.length) : '';
  $('nTracked').textContent = s.tracked.length ? String(s.tracked.length) : '';

  const banners = $('banners');
  banners.textContent = '';
  const banner = (text, bad) => banners.append(el('div', 'banner' + (bad ? ' bad' : ''), text));
  if (s.auth === 'nologin') banner(t('bLogin'), true);
  else if (s.auth === 'error') banner(t('bErrorBanner') + (s.authErr ? ' (' + s.authErr + ')' : ''));
  if (r.needClick) banner(t('bNeedClick'), true);
  if (r.running && r.playing && r.playing.muted && !r.needClick) banner(t('bMuted'));
  if (cur && cur.a && cur.a.notConnected) banner(t('bNotConnected', { game: cur.name }));
  for (const w of s.claimBlocked || []) banner(t('bClaimNoLink', { game: w }), true);
  if (!r.running && (r.msgK || r.msg)) banner(r.msgK ? t(r.msgK.k, r.msgK.v) : r.msg);
  if (s.update && s.update.v) {
    const b = el('div', 'banner upd', t('updAvail', { v: s.update.v }) + ' ');
    const link = el('a', '', t('updGet')); link.href = s.update.page || '#'; link.target = '_blank'; link.rel = 'noopener';
    b.append(link); banners.append(b);
  }
  if (stale(s)) banner(t('bStale'), true);

  const now = $('now');
  now.hidden = !r.running;
  if (r.running) {
    let title = t('nSearching'), sub = '';
    if (r.phase === 'wait') {
      title = t('nWait');
      const claim = s.games.filter((g) => g.status === 'claim').map((g) => g.name);
      sub = claim.length ? t(s.settings.autoClaim ? 'nClaimAuto' : 'nClaimManual', { games: claim.join(', ') }) : t('nNothing');
    } else if (cur && r.channel) {
      title = cur.name;
      sub = t(r.phase === 'load' ? 'nLoading' : 'nWatching', { url: 'twitch.tv/' + r.channel });
      if (r.phase === 'watch' && r.playing) sub += ` · ${r.playing.height || '?'}p`;
      if (r.progOk) sub += ' · ' + t('nProgOk');
    } else if (cur) { title = cur.name; sub = r.msgK ? t(r.msgK.k, r.msgK.v) : t('nSearchDrops'); }
    $('nowTitle').textContent = title;
    $('nowSub').textContent = sub;
    const p = (r.session && r.session.req ? { name: (cur && cur.a && cur.a.current && cur.a.current.name) || t('curDrop'), cur: r.session.cur, req: r.session.req } : null) || (cur && cur.a && cur.a.current);
    const show = !!p && r.phase !== 'wait';
    $('progWrap').hidden = !show;
    if (show) {
      $('progBar').style.width = Math.max(0, Math.min(100, (p.cur / p.req) * 100)) + '%';
      $('progName').textContent = p.name;
      $('progNum').textContent = `${p.cur} / ${p.req} ${t('min')}`;
    }
    $('skip').hidden = !(r.channel && r.phase !== 'wait');
    $('show').hidden = r.windowId == null;
  }

  renderCamps(s);
  renderList(s);
  renderTracked(s);
  renderLang(s);

  document.querySelectorAll('[data-set]').forEach((inp) => {
    if (document.activeElement === inp) return;
    const v = s.settings[inp.dataset.set];
    if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = String(v);
  });

  $('foot').textContent = t(s.settings.autoClaim ? 'footOn' : 'footOff');
  const dg = s.diag;
  const total = (s.campaigns || []).reduce((n, c) => n + c.camps.length, 0);
  $('diag').textContent = s.dropsAt ? t('diag', { time: hm(s.dropsAt), n: total + (dg ? ` (page ${dg.page} · scan ${dg.scan} · api ${dg.api} · inv ${dg.inv} · streams ${dg.streams})` : ''), p: t(s.progKnown ? 'progYes' : 'progNo') }) : '';
  const lg = $('log');
  const lsig = s.log.length + ':' + (s.log.length ? s.log[s.log.length - 1].t : 0) + ':' + lang;
  if (lg.dataset.sig !== lsig) {
    lg.dataset.sig = lsig;
    lg.textContent = '';
    s.log.slice().reverse().forEach((e) => { const row = el('div'); row.append(el('time', '', hm(e.t)), document.createTextNode(e.k ? t(e.k, e.v) : e.m)); lg.append(row); });
    if (!s.log.length) lg.append(el('div', '', t('logEmpty')));
  }
}

async function act(op, extra) {
  pending++;
  let res;
  try { res = await send(op, extra); } catch (e) { res = null; }
  pending--;
  if (res && res.error) flash(res.error);
  if (res && res.games && !pending) render(res);
}
function flash(text) {
  const b = el('div', 'banner bad', text);
  $('banners').prepend(b);
  setTimeout(() => b.remove(), 4000);
}
async function refresh() {
  if (pending || dragId) return;
  try { const s = await send('get'); if (!pending && !dragId) render(s); } catch (e) {}
}

$('toggle').onclick = () => { if (state && !state.run.running) showTab('queue'); act(state && state.run.running ? 'stop' : 'start'); };
$('skip').onclick = () => act('skip');
$('show').onclick = () => act('showWindow');
$('clearLog').onclick = () => act('clearLog');
$('clearDone').onclick = () => act('clearDone');
$('rescan').onclick = async () => { $('rescan').classList.add('spin'); await act('rescan'); $('rescan').classList.remove('spin'); };
$('filter').addEventListener('input', () => { if (state) renderCamps(state); });

document.querySelectorAll('[data-set]').forEach((inp) => {
  inp.addEventListener('change', () => {
    const patch = {};
    patch[inp.dataset.set] = inp.type === 'checkbox' ? inp.checked : inp.value;
    act('settings', { patch });
  });
});

// wyszukiwarka gier (dodanie do kolejki / do śledzonych)
function searchBox(input, sugg, onPick) {
  let timer = null, seq = 0;
  const hide = () => { sugg.hidden = true; sugg.textContent = ''; };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 2) return hide();
    timer = setTimeout(async () => {
      const my = ++seq;
      const res = await send('search', { q: text });
      if (my !== seq) return;
      sugg.textContent = '';
      (res || []).forEach((g) => {
        const b = el('button', 'sugg-row');
        b.append(art(g.icon, 'art small'), el('span', '', g.name));
        b.onclick = () => { hide(); input.value = ''; onPick(g); };
        sugg.append(b);
      });
      if (!res || !res.length) sugg.append(el('div', 'none', t('noCategory')));
      sugg.hidden = false;
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const b = sugg.querySelector('button'); if (b) b.click(); }
    if (e.key === 'Escape') hide();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.add')) hide(); });
}
searchBox($('q'), $('sugg'), (g) => act('add', { game: g }));
searchBox($('tq'), $('tsugg'), (g) => act('track', { game: g, on: true }));

(async () => {
  showTab(tab);
  applyI18n();
  await refresh();
  if (state && Date.now() - (state.dropsAt || 0) > 120000) act('refresh');
  setInterval(refresh, 2000);
})();
