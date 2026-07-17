'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  items: [],
  search: '',
  filterStatus: 'all',
  filterType: 'all',
  filterFandom: 'all',
  filterSection: 'all',
  filterGenre: 'all',
  filterFavorite: false,
  filterTag: 'all',
  sortBy: 'added',
  expandedId: null,
  modalOpen: false,
  editItem: null,
  view: 'library',
  viewMode: 'folder',
  folderPath: [],
  folderConfig: {},
  editingFolder: null,
  creatingFolderIn: null,
  folderSearch: '',
  folderItemFilter: null,
  folderSortBy: 'count',
  mySpaceTab: 'ff',
  editingItemIcon: null,
  statsCategory: 'all',
  statsPeriod: 'year',
  statsMetric: 'words',
  settingsOpen: false,
  bannerConfig: {},
  folderUndoStack: [],
  deletedIds: {},   // id -> ISO timestamp of deletion, so cloud sync/backup can't resurrect it
};

const STATUS = ['TBR','Reading','Finished','Dropped'];
const BANNER_PAGES = [
  { key: 'list',    label: '📚 Library (list view)' },
  { key: 'folder',  label: '🗂 Browse / folders' },
  { key: 'myspace', label: '🗂️ MySpace' },
  { key: 'stats',   label: '📈 Stats' },
];
const BANNER_PRESETS = ['#7d9d6a', '#3c5429', '#9bb08a', '#a98467', '#b9854f', '#6b8e9e', '#b07d9e', '#c98b8b'];

function loadBannerConfig() { try { return JSON.parse(localStorage.getItem('bannerConfig') || '{}'); } catch { return {}; } }
function saveBannerConfig() { try { localStorage.setItem('bannerConfig', JSON.stringify(state.bannerConfig)); } catch (e) {} }
// Turn a stored value (colour or image URL) into a CSS background value; null = use the page default.
function resolveBanner(v) {
  v = (v || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return `url("${v.replace(/"/g, '%22')}") center / cover no-repeat`;
  return v;
}
function currentPageKey() {
  if (state.view === 'stats') return 'stats';
  if (state.viewMode === 'myspace') return 'myspace';
  if (state.viewMode === 'folder') return 'folder';
  return 'list';
}
function applyBanner() {
  const el = document.getElementById('app');
  if (!el) return;
  const bg = resolveBanner(state.bannerConfig[currentPageKey()]);
  if (bg) el.style.setProperty('--banner', bg); else el.style.removeProperty('--banner');
}
function settingsModalHtml() {
  if (!state.settingsOpen) return '';
  const rows = BANNER_PAGES.map(p => {
    const val = state.bannerConfig[p.key] || '';
    const prev = resolveBanner(val) || '#7d9d6a';
    return `
      <label class="field-label" style="margin-top:14px">${p.label}</label>
      <div class="banner-edit">
        <span class="banner-prev" data-banner-prev="${p.key}" style="background:${prev}"></span>
        <input type="text" class="banner-in" data-banner="${p.key}" value="${esc(val)}" placeholder="#7d9d6a  or  https://image…" autocomplete="off" />
        <button class="btn btn-secondary btn-sm" data-banner-reset="${p.key}">Reset</button>
      </div>
      <div class="banner-presets">${BANNER_PRESETS.map(c => `<span class="banner-swatch" data-banner-set="${p.key}|${c}" style="background:${c}" title="${c}"></span>`).join('')}</div>`;
  }).join('');
  return `<div class="folder-edit-backdrop" id="settings-backdrop">
    <div class="folder-edit-modal" style="width:470px">
      <div class="fem-header"><span class="fem-title">⚙️ Page banners</span><button class="fem-close" id="settings-close">×</button></div>
      <div class="fem-body" style="padding-bottom:14px; max-height:70vh; overflow-y:auto">
        <p class="fem-hint" style="display:block; margin-bottom:2px">Give each page's banner a colour (<b>#hex</b>) or a background <b>image URL</b> — like a book cover. Leave blank for the default sage.</p>
        ${rows}
      </div>
      <div class="modal-footer" style="padding:0 22px 18px"><button class="btn btn-primary" id="settings-done">Done</button></div>
    </div>
  </div>`;
}
const STATUS_COLOR = { TBR:'purple', Reading:'amber', Finished:'green', Dropped:'red' };

// ── Persistence ───────────────────────────────────────────────────────────────
async function loadData() {
  state._loadedFromFile = false;
  state._jsonHadFolderConfig = false;
  try {
    const result = await window.api.loadData();
    if (result) {
      const items = Array.isArray(result) ? result : (result.items || []);
      if (!Array.isArray(result) && result.folderConfig && Object.keys(result.folderConfig).length) {
        state._jsonHadFolderConfig = true;
        state.folderConfig = { ...result.folderConfig, ...state.folderConfig };
        localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig)); // init only — skip saveData
      }
      if (!Array.isArray(result) && result.deletedIds) state.deletedIds = result.deletedIds;
      if (items.length) { state._loadedFromFile = true; return items; }
    }
  } catch(e) {}
  return INITIAL_DATA.map((item, i) => ({ ...item, _addedAt: i }));
}

async function saveData() {
  try { await window.api.saveData({ items: state.items, folderConfig: state.folderConfig, deletedIds: state.deletedIds }); } catch(e) {}
}

// ── Cloud sync (merge with GitHub copy so phone ↔ desktop changes don't clobber) ──
function pickItem(a, b) {
  // Primary signal: which copy was edited more recently (any field change stamps _modAt).
  const ma = Date.parse(a._modAt || '') || 0, mb = Date.parse(b._modAt || '') || 0;
  if (ma !== mb) return ma > mb ? a : b;
  // Fallback for legacy items without _modAt: most recent read/finish, then more reads.
  const score = x => {
    let t = 0;
    if (Array.isArray(x.readDates) && x.readDates.length) { const d = Date.parse(x.readDates[x.readDates.length-1]); if (d) t = Math.max(t, d); }
    if (x.finishedAt) { const d = Date.parse(x.finishedAt); if (d) t = Math.max(t, d); }
    return t;
  };
  const sa = score(a), sb = score(b);
  if (sa !== sb) return sa > sb ? a : b;
  const ra = Array.isArray(a.readDates) ? a.readDates.length : (a.readCount||0);
  const rb = Array.isArray(b.readDates) ? b.readDates.length : (b.readCount||0);
  return rb > ra ? b : a;
}
function mergeLibrary(localItems, localFC, remoteItems, remoteFC, localDel, remoteDel) {
  const byId = new Map();
  (remoteItems||[]).forEach(x => { if (x && x.id != null) byId.set(x.id, x); });
  (localItems||[]).forEach(x => {
    if (!x || x.id == null) return;
    const r = byId.get(x.id);
    byId.set(x.id, r ? pickItem(x, r) : x);
  });

  // Deletion tombstones: merge both sides (later timestamp per id wins), then drop anything
  // tombstoned from the item union — unless a surviving copy was modified *after* the deletion,
  // meaning it was intentionally revived/edited elsewhere and that edit should win.
  const delMerged = { ...(remoteDel || {}) };
  for (const [id, ts] of Object.entries(localDel || {})) {
    if (!delMerged[id] || Date.parse(ts) > Date.parse(delMerged[id])) delMerged[id] = ts;
  }
  const TOMBSTONE_TTL_DAYS = 365;
  const cutoff = Date.now() - TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removedByTombstone = 0;
  for (const [id, ts] of Object.entries(delMerged)) {
    if (Date.parse(ts) < cutoff) { delete delMerged[id]; continue; } // old enough to stop tracking
    const item = byId.get(id);
    if (item) {
      const modAt = Date.parse(item._modAt || '') || 0;
      if (modAt <= Date.parse(ts)) { byId.delete(id); removedByTombstone++; }
    }
  }

  const fc = { ...(remoteFC||{}) };
  for (const [k, lv] of Object.entries(localFC||{})) {
    const rv = fc[k];
    if (!rv) { fc[k] = lv; continue; }
    const lm = Date.parse(lv._modAt||'')||0, rm = Date.parse(rv._modAt||'')||0, localNewer = lm >= rm;
    const out = {};
    for (const kk of new Set([...Object.keys(rv), ...Object.keys(lv)])) {
      if (kk === '_modAt') continue;
      const a = lv[kk], b = rv[kk];
      out[kk] = a === undefined ? b : b === undefined ? a : (JSON.stringify(a) === JSON.stringify(b) ? a : (localNewer ? a : b));
    }
    const m = (lm >= rm ? lv._modAt : rv._modAt) || lv._modAt || rv._modAt; if (m) out._modAt = m;
    fc[k] = out;
  }
  return { items: [...byId.values()], folderConfig: fc, deletedIds: delMerged, removedByTombstone };
}
// Pull the latest data from GitHub and merge it in (additive except for tracked deletions).
async function syncFromCloud() {
  try {
    if (!window.api.pullData) return false;
    const res = await window.api.pullData();
    if (!res || !res.ok || !res.data) return false;
    const remoteN = (res.data.items||[]).length, localN = state.items.length;
    const merged = mergeLibrary(state.items, state.folderConfig, res.data.items, res.data.folderConfig, state.deletedIds, res.data.deletedIds);
    // Safety: never lose data for any reason other than an explicit, tracked deletion.
    if (merged.items.length < Math.max(localN, remoteN) - merged.removedByTombstone) return false;
    state.items = merged.items;
    state.folderConfig = merged.folderConfig;
    state.deletedIds = merged.deletedIds;
    localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig));
    await saveData();
    return true;
  } catch(e) { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) { return n ? Number(n).toLocaleString() : '—'; }
function genId() { return Date.now() + '_' + Math.random().toString(36).slice(2); }
function itemWords(x) { return x.words || (x.pages ? x.pages * 250 : 0); }
// Times read: prefer the per-read timestamp list, fall back to the legacy count.
function timesRead(x) { return Array.isArray(x.readDates) ? x.readDates.length : (x.readCount ?? (x.status === 'Finished' ? 1 : 0)); }
// Re-read multiplier: counts every item at least once, +1× for each re-read beyond the first.
function readMult(x) { return Math.max(1, timesRead(x)); }
// Per-read timestamps, migrating legacy reads to the finish date (best-known date for old reads).
function ensureReadDates(x) {
  if (Array.isArray(x.readDates)) return x.readDates.slice();
  const n = x.readCount ?? (x.status === 'Finished' ? 1 : 0);
  return Array.from({ length: n }, () => x.finishedAt || null);
}
// Most recent read timestamp, or null.
function lastReadAt(x) { const d = ensureReadDates(x).filter(Boolean); return d.length ? d[d.length - 1] : null; }
// Flatten items into individual read events, each dated when that read happened.
function readEvents(items) {
  const ev = [];
  items.forEach(x => { const w = itemWords(x); ensureReadDates(x).forEach(d => { if (d) ev.push({ date: d, words: w }); }); });
  return ev;
}
function fmtTime(mins) {
  if (!mins) return '0m';
  const h = Math.floor(mins / 60);
  if (h === 0) return `${Math.round(mins)}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  if (d === 0) return `${h}h`;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return n.toLocaleString();
}

function fmtDateShort(iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : ''; }
function daysBetween(a, b) { return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000)); }

function getFandoms() {
  const s = new Set();
  state.items.filter(x => x.type === 'ff' && x.fandom).forEach(x => s.add(x.fandom));
  return [...s].sort();
}

function getSections() {
  const s = new Set();
  state.items.filter(x => x.type === 'book' && x.section).forEach(x => s.add(x.section));
  return [...s];
}

function getGenres() {
  const s = new Set();
  state.items.filter(x => x.type === 'book' && x.genre)
    .forEach(x => s.add(x.genre.split(' / ')[0].trim()));
  return [...s].sort();
}

function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fandomEmoji(f) {
  const k = (f||'').toLowerCase();
  if (k.includes('harry potter')) return '⚡';
  if (k.includes('percy jackson') || k.includes('pjo') || k.includes('olympus')) return '🔱';
  if (k.includes('marvel') || k.includes('avengers')) return '🦸';
  if (k.includes('star wars')) return '⭐';
  if (k.includes('lord of the rings') || k.includes('tolkien') || k.includes('hobbit')) return '💍';
  if (k.includes('game of thrones') || k.includes('asoiaf') || k.includes('fire and blood')) return '🐉';
  if (k.includes('doctor who')) return '🌀';
  if (k.includes('sherlock')) return '🔍';
  if (k.includes('naruto')) return '🍥';
  if (k.includes('one piece')) return '🏴‍☠️';
  if (k.includes('my hero academia') || k.includes('bnha') || k.includes('boku no hero')) return '💥';
  if (k.includes('attack on titan') || k.includes('shingeki')) return '⚔️';
  if (k.includes('teen wolf')) return '🐺';
  if (k.includes('twilight')) return '🌙';
  if (k.includes('hunger games')) return '🏹';
  if (k.includes('supernatural')) return '🌑';
  if (k.includes('the witcher')) return '⚔️';
  if (k.includes('merlin')) return '🔮';
  if (k.includes('criminal minds')) return '🕵️';
  if (k.includes('band of brothers') || k.includes('generation kill')) return '🎖️';
  return '📁';
}

function genreEmoji(g) {
  const k = (g||'').toLowerCase();
  if (k.includes('romantasy') || k.includes('fantasy')) return '🐉';
  if (k.includes('romance')) return '💕';
  if (k.includes('mystery') || k.includes('detective')) return '🔍';
  if (k.includes('thriller') || k.includes('suspense')) return '🔪';
  if (k.includes('sci') || k.includes('science fiction')) return '🚀';
  if (k.includes('horror')) return '👻';
  if (k.includes('historical')) return '🏛️';
  if (k.includes('contemporary')) return '🌆';
  if (k.includes('ya') || k.includes('young adult')) return '✨';
  if (k.includes('non-fiction') || k.includes('nonfiction')) return '📰';
  if (k.includes('biograph') || k.includes('memoir')) return '👤';
  if (k.includes('classic')) return '📜';
  if (k.includes('crime')) return '🕵️';
  if (k.includes('adventure')) return '🗺️';
  return '📚';
}

function getTagsForFandom() {
  if (state.filterFandom === 'all') return [];
  const s = new Set();
  state.items
    .filter(x => x.fandom === state.filterFandom && (x.tags || []).length > 0)
    .forEach(x => (x.tags || []).forEach(t => s.add(t)));
  return [...s].sort();
}

function getPeriodData(items, period) {
  const now = new Date();
  const DAY = 86400000;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dated = readEvents(items);

  if (period === 'week') {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    return Array.from({length: 7}, (_, i) => {
      const d = new Date(now - (6 - i) * DAY); d.setHours(0,0,0,0);
      const end = new Date(d); end.setHours(23,59,59,999);
      return { label: i === 6 ? 'Today' : days[d.getDay()],
        events: dated.filter(e => { const t = new Date(e.date); return t >= d && t <= end; }) };
    });
  }
  if (period === 'month') {
    return Array.from({length: 4}, (_, i) => {
      const end = new Date(now - (3 - i) * 7 * DAY); end.setHours(23,59,59,999);
      const start = new Date(end - 6 * DAY); start.setHours(0,0,0,0);
      return { label: `${MONTHS[start.getMonth()]} ${start.getDate()}`,
        events: dated.filter(e => { const t = new Date(e.date); return t >= start && t <= end; }) };
    });
  }
  if (period === 'year') {
    return Array.from({length: 12}, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      return { label: MONTHS[d.getMonth()],
        events: dated.filter(e => { const t = new Date(e.date); return t >= start && t <= end; }) };
    });
  }
  if (period === 'ever') {
    if (dated.length === 0) return [{ label: String(now.getFullYear()), events: [] }];
    const years = [...new Set(dated.map(e => new Date(e.date).getFullYear()))].sort();
    if (!years.includes(now.getFullYear())) years.push(now.getFullYear());
    return years.map(yr => ({ label: String(yr),
      events: dated.filter(e => new Date(e.date).getFullYear() === yr) }));
  }
  return [];
}

function getFiltered() {
  return state.items.filter(item => {
    if (state.filterFavorite && !item.favorite) return false;
    if (state.filterType === 'oneshot') {
      if (item.type !== 'ff' || !item.oneshot) return false;
    } else if (state.filterType !== 'all' && item.type !== state.filterType) return false;
    if (state.filterStatus !== 'all' && item.status !== state.filterStatus) return false;
    if (state.filterFandom !== 'all' && item.fandom !== state.filterFandom) return false;
    if (state.filterTag !== 'all' && !(item.tags || []).includes(state.filterTag)) return false;
    if (state.filterSection !== 'all' && item.section !== state.filterSection) return false;
    if (state.filterGenre !== 'all') {
      const top = (item.genre || '').split(' / ')[0].trim();
      if (top !== state.filterGenre) return false;
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      return (item.title||'').toLowerCase().includes(q)
        || (item.author||'').toLowerCase().includes(q)
        || (item.fandom||'').toLowerCase().includes(q)
        || (item.genre||'').toLowerCase().includes(q)
        || (item.section||'').toLowerCase().includes(q)
        || (item.tags||[]).some(t => t.toLowerCase().includes(q));
    }
    return true;
  }).sort((a,b) => {
    if (state.sortBy === 'title') return (a.title||'').localeCompare(b.title||'');
    if (state.sortBy === 'words') return (b.words||0) - (a.words||0);
    if (state.sortBy === 'hearts') return (b.hearts||0) - (a.hearts||0);
    if (state.sortBy === 'rating') return (b.userRating||0) - (a.userRating||0);
    if (state.sortBy === 'author') return (a.author||'').localeCompare(b.author||'');
    // default 'recent': most recently read/finished first; not-yet-read items on top by add order
    const ra = lastReadAt(a), rb = lastReadAt(b);
    const ta = ra ? Date.parse(ra) : null, tb = rb ? Date.parse(rb) : null;
    if (ta === null && tb === null) return (b._addedAt||0) - (a._addedAt||0);
    if (ta === null) return -1;
    if (tb === null) return 1;
    if (tb !== ta) return tb - ta;
    return (b._addedAt||0) - (a._addedAt||0);
  });
}

function getStats() {
  const items = state.items;
  return {
    total: items.length,
    ff: items.filter(x => x.type === 'ff').length,
    books: items.filter(x => x.type === 'book').length,
    tbr: items.filter(x => x.status === 'TBR').length,
    reading: items.filter(x => x.status === 'Reading').length,
    finished: items.filter(x => x.status === 'Finished').length,
    dropped: items.filter(x => x.status === 'Dropped').length,
    totalWords: items.reduce((s,x) => s + itemWords(x) * readMult(x), 0),
  };
}

// ── Stars HTML ────────────────────────────────────────────────────────────────
function starsHtml(value, id, readonly=false) {
  const cls = readonly ? 'stars readonly' : 'stars';
  const stars = [1,2,3,4,5].map(i =>
    `<span class="star${i <= value ? ' lit' : ''}" data-val="${i}" data-id="${id||''}"
      style="font-size:${readonly?14:20}px">★</span>`
  ).join('');
  return `<span class="${cls}" data-stars="${id||''}">${stars}</span>`;
}

// ── Badge HTML ────────────────────────────────────────────────────────────────
function badgeHtml(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function tagHtml(t, removable=false, itemId='') {
  return `<span class="tag">${t}${removable ? `<span class="tag-remove" data-tag="${esc(t)}" data-id="${itemId}">×</span>` : ''}</span>`;
}

// ── Card HTML ─────────────────────────────────────────────────────────────────
function cardHtml(item) {
  const isFf = item.type === 'ff';
  const expanded = state.expandedId === item.id;
  const readCount = timesRead(item);
  const _lastRead = lastReadAt(item);
  const lastReadHtml = _lastRead ? `<span class="reread-sub">Last read ${new Date(_lastRead).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'})}</span>` : '';
  const metaParts = [];
  if (item.words) metaParts.push(`📝 ${fmt(item.words)} words`);
  if (isFf && item.hearts) metaParts.push(`♥ ${fmt(item.hearts)}`);
  if (!isFf && item.pages) metaParts.push(`📄 ${fmt(item.pages)} pages`);
  if (item.userRating > 0) metaParts.push(starsHtml(item.userRating, item.id, true));
  if (!isFf && item.section) metaParts.push(`<span style="color:#9ca3af;font-size:11px">${item.section}</span>`);
  const tags = (item.tags||[]).map(t => tagHtml(t)).join('');

  let expandedHtml = '';
  if (expanded) {
    const statusBtns = STATUS.map(s =>
      `<button class="status-btn${item.status===s?' active-'+s:''}" data-set-status="${s}" data-id="${item.id}">${s}</button>`
    ).join('');
    const notesHtml = item.notes ? `<p class="card-notes">"${item.notes}"</p>` : '';
    const extraParts = [];
    if (isFf) {
      if (item.pairing) extraParts.push(`Pairing: ${item.pairing}`);
      if (item.rating) extraParts.push(`Rating: ${item.rating}`);
    }
    const extraHtml = extraParts.length ? `<p class="card-extra">${extraParts.join(' · ')}</p>` : '';

    expandedHtml = `
      <div class="card-expanded">
        <div class="status-switcher">${statusBtns}</div>
        <div style="margin:8px 0 4px;display:flex;gap:4px;align-items:center">
          <span style="font-size:12px;color:#9ca3af;margin-right:4px">Your rating:</span>
          ${starsHtml(item.userRating, item.id)}
        </div>
        <div class="reread-row">
          <div class="reread-info">
            <span class="reread-label">📖 Read ${readCount} time${readCount === 1 ? '' : 's'}</span>
            ${lastReadHtml}
          </div>
          <div class="reread-stepper">
            <button class="reread-step" data-reread-delta="-1" data-reread-id="${item.id}" title="Remove the latest re-read"${readCount <= 0 ? ' disabled' : ''}>－</button>
            <button class="reread-step" data-reread-delta="1" data-reread-id="${item.id}" title="I re-read this today">＋</button>
          </div>
        </div>
        ${notesHtml}${extraHtml}
        ${item.url ? `<p class="card-extra"><a href="${item.url}" style="color:#6366f1">Open link ↗</a></p>` : ''}
      </div>`;
  }

  const sub = isFf
    ? `by <b>${item.author||'—'}</b>${item.fandom ? ' · '+item.fandom : ''}`
    : `by <b>${item.author||'—'}</b>${item.genre ? ' · '+item.genre : ''}`;

  const [cc1, cc2] = folderGradient(item.id);
  const coverIcon = item.coverIcon || '';
  const coverIsUrl = coverIcon.startsWith('http');
  const coverInner = coverIsUrl
    ? `<img class="card-cover-img" src="${esc(coverIcon)}" />`
    : `<span class="card-cover-emoji">${coverIcon || (isFf ? '✍️' : '📚')}</span>`;

  return `
    <div class="card" data-id="${item.id}">
      <div class="card-top">
        <div class="card-cover" data-expand="${item.id}" style="--c1:${cc1};--c2:${cc2}">
          ${coverInner}
          <button class="cover-edit-btn" data-edit-item-icon="${item.id}" title="Change cover icon">✏️</button>
        </div>
        <div class="card-main" data-expand="${item.id}">
          <div class="card-title-row">
            <span class="card-title">${item.title}</span>
            ${badgeHtml(item.status)}
            ${item.oneshot ? '<span class="badge badge-oneshot">One-shot</span>' : ''}
            ${readCount > 1 ? `<span class="badge badge-reread" title="Read ${readCount} times">↻${readCount}</span>` : ''}
          </div>
          <div class="card-sub">${sub}</div>
          <div class="card-meta">
            ${metaParts.join('\n')}
            ${tags}
          </div>
        </div>
        <div class="card-actions">
          <button class="icon-btn${item.favorite ? ' fav-active' : ''}" data-toggle-fav="${item.id}" title="${item.favorite ? 'Remove from favorites' : 'Add to favorites'}">⭐</button>
          ${item.url ? `<button class="icon-btn" data-open-url="${item.url}" title="Open link">🔗</button>` : ''}
          ${isFf && /archiveofourown|fanfiction\.net|transformativeworks/.test(item.url||'') ? `<button class="icon-btn" data-refresh-words="${item.id}" title="Refresh word count from the link">↻</button>` : ''}
          <button class="icon-btn" data-edit="${item.id}" title="Edit">✏️</button>
          <button class="icon-btn danger" data-delete="${item.id}" title="Delete">🗑</button>
        </div>
      </div>
      ${expandedHtml}
    </div>`;
}

// ── Modal HTML ────────────────────────────────────────────────────────────────
function modalHtml() {
  const item = state.editItem || {};
  const isEdit = !!state.editItem;
  const type = item.type || 'ff';
  const isFf = type === 'ff';

  const typeBtn = (t, label) =>
    `<button class="type-btn${type===t?' active':''}" data-type-btn="${t}">${label}</button>`;

  const ratingOpts = ['','General','Teen+','Mature','Explicit','Not Rated']
    .map(r => `<option value="${r}"${item.rating===r?' selected':''}>${r||'— select —'}</option>`).join('');
  const statusOpts = STATUS
    .map(s => `<option value="${s}"${(item.status||'TBR')===s?' selected':''}>${s}</option>`).join('');

  const tags = (item.tags||[]).map(t => tagHtml(t, true, item.id||'new')).join('');

  return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title">${isEdit ? 'Edit entry' : 'Add new entry'}</span>
          <button class="modal-close" id="modal-close">×</button>
        </div>

        ${!isEdit ? `<div class="type-toggle">
          ${typeBtn('ff','📖 Fanfiction')}
          ${typeBtn('book','📚 Book')}
        </div>` : ''}

        ${isFf ? `
        <label class="field-label">Fic URL <span style="font-size:10px;font-weight:400;color:#9ca3af">(AO3 or FF.net)</span></label>
        <div class="fetch-row">
          <input type="url" id="m-url" value="${item.url||''}" placeholder="https://archiveofourown.org/… or https://www.fanfiction.net/…" />
          <button class="btn btn-primary btn-sm" id="btn-fetch">Auto-fill ✦</button>
        </div>
        <div class="fetch-msg" id="fetch-msg"></div>
        <label class="field-label">Format</label>
        <div class="type-toggle">
          <button class="type-btn${!item.oneshot ? ' active' : ''}" data-oneshot-btn="false">📖 Multi-chapter</button>
          <button class="type-btn${item.oneshot ? ' active' : ''}" data-oneshot-btn="true">📄 One-shot</button>
        </div>` : ''}

        <label class="field-label">Title *</label>
        ${!isFf ? `
          <div class="ac-wrap">
            <div class="fetch-row">
              <input type="text" id="m-title" value="${item.title||''}" placeholder="Title, author or ISBN…" />
              <button class="btn btn-primary btn-sm" id="btn-book-fetch">Auto-fill ✦</button>
            </div>
            <div class="field-suggest" id="sug-title"></div>
          </div>
          <div class="fetch-msg" id="book-fetch-msg"></div>
        ` : `<div class="ac-wrap"><input type="text" id="m-title" value="${item.title||''}" placeholder="Title" /><div class="field-suggest" id="sug-title"></div></div>`}
        <div class="dupe-warn" id="dupe-warning"></div>

        <label class="field-label">Author</label>
        <div class="ac-wrap"><input type="text" id="m-author" value="${item.author||''}" placeholder="Author / username" /><div class="field-suggest" id="sug-author"></div></div>

        <div class="field-row">
          ${isFf ? `
          <div class="ac-wrap">
            <label class="field-label">Fandom</label>
            <input type="text" id="m-fandom" value="${item.fandom||''}" placeholder="e.g. Harry Potter" />
            <div class="field-suggest" id="sug-fandom"></div>
          </div>
          <div class="ac-wrap">
            <label class="field-label">Pairing</label>
            <input type="text" id="m-pairing" value="${item.pairing||''}" placeholder="e.g. M/M or Harry/Ginny" />
            <div class="field-suggest" id="sug-pairing"></div>
          </div>` : `
          <div>
            <label class="field-label">Genre</label>
            <input type="text" id="m-genre" value="${item.genre||''}" placeholder="e.g. Romantasy" />
          </div>
          <div>
            <label class="field-label">Pages</label>
            <input type="number" id="m-pages" value="${item.pages||''}" placeholder="e.g. 512" />
          </div>`}
        </div>

        <div class="field-row">
          <div>
            <label class="field-label">Word count</label>
            <div class="wc-row">
              <input type="number" id="m-words" value="${item.words||''}" placeholder="e.g. 120000" />
              ${isFf ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-refresh-words" title="Refresh word count & kudos from the link (doesn't touch your other fields)">↻</button>` : ''}
            </div>
          </div>
          ${isFf ? `
          <div>
            <label class="field-label">Kudos / Hearts</label>
            <input type="number" id="m-hearts" value="${item.hearts||''}" placeholder="e.g. 5000" />
          </div>` : `
          <div>
            <label class="field-label">Section</label>
            <input type="text" id="m-section" value="${item.section||''}" placeholder="e.g. Romantasy" />
          </div>`}
        </div>

        <div class="field-row">
          ${isFf ? `
          <div>
            <label class="field-label">AO3 Rating</label>
            <select id="m-rating">${ratingOpts}</select>
          </div>` : ''}
          <div>
            <label class="field-label">Status</label>
            <select id="m-status">${statusOpts}</select>
          </div>
        </div>

        <label class="field-label">Your rating</label>
        <div class="star-picker" id="star-picker">
          ${[1,2,3,4,5].map(i =>
            `<span class="${i <= (item.userRating||0) ? 'lit':''}" data-pick="${i}">★</span>`
          ).join('')}
        </div>

        <label class="field-label">Tags</label>
        <div class="tags-input-row">
          <input type="text" id="m-tag-input" placeholder="Add tag + Enter (e.g. Drarry, slow burn)" autocomplete="off" />
          <button class="btn btn-secondary btn-sm" id="btn-add-tag">+</button>
        </div>
        <div class="tag-suggest" id="tag-suggest" style="display:none"></div>
        <div class="tags-display" id="tags-display">${tags}</div>

        <label class="field-label">Times read</label>
        <input type="number" id="m-readcount" min="0" value="${item.readCount ?? (item.status === 'Finished' ? 1 : 0)}" style="width:100px" />

        <label class="field-label">Date finished <span style="font-weight:400;text-transform:none;font-size:10px">(optional)</span></label>
        <input type="date" id="m-finished" value="${item.finishedAt ? item.finishedAt.slice(0,10) : (!isEdit && isFf ? new Date().toISOString().slice(0,10) : '')}" />

        <label class="field-label">Notes</label>
        <textarea id="m-notes" placeholder="Personal thoughts, read again?">${item.notes||''}</textarea>

        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-submit">${isEdit ? 'Save changes' : 'Add to list'}</button>
        </div>
      </div>
    </div>`;
}

// ── Stats View ────────────────────────────────────────────────────────────────
function statsViewHtml() {
  const SPEED = 250;
  const fin = {
    all:     state.items,
    books:   state.items.filter(x => x.type === 'book'),
    ff:      state.items.filter(x => x.type === 'ff' && !x.oneshot),
    oneshot: state.items.filter(x => x.type === 'ff' && x.oneshot),
  };
  const cat = state.statsCategory;
  const items = fin[cat];
  const totalCount = items.length;
  const totalWords = items.reduce((s, x) => s + itemWords(x) * readMult(x), 0);
  const totalMins = totalWords / SPEED;

  const tab = (id, lbl) =>
    `<span class="stat-tab${cat === id ? ' active' : ''}" data-scat="${id}">${lbl}</span>`;

  // Breakdown bar (all category only)
  let breakdownHtml = '';
  if (cat === 'all' && totalWords > 0) {
    const parts = [
      { key:'books',   lbl:'📚 Books',       cls:'green',  list: fin.books },
      { key:'ff',      lbl:'📖 Fanfiction',  cls:'purple', list: fin.ff },
      { key:'oneshot', lbl:'📄 One-shots',   cls:'amber',  list: fin.oneshot },
    ].filter(p => p.list.length > 0);
    const rows = parts.map(p => {
      const w = p.list.reduce((s, x) => s + itemWords(x) * readMult(x), 0);
      const pct = Math.round(w / totalWords * 100);
      return `<div class="bdrow">
        <span class="bddot ${p.cls}"></span>
        <span class="bdlabel">${p.lbl}</span>
        <span class="bdstat">${p.list.length} · ${fmtNum(w)} words · ${fmtTime(w/SPEED)}</span>
        <span class="bdpct">${pct}%</span>
      </div>`;
    }).join('');
    const segs = parts.map(p => {
      const w = p.list.reduce((s, x) => s + itemWords(x) * readMult(x), 0);
      return `<div class="bdseg ${p.cls}" style="width:${Math.round(w/totalWords*100)}%"></div>`;
    }).join('');
    breakdownHtml = `<div class="stats-breakdown">${rows}<div class="bdbar">${segs}</div></div>`;
  }

  // Chart
  const groups = getPeriodData(items, state.statsPeriod);
  const isWords = state.statsMetric === 'words';
  const metricFn = isWords
    ? g => g.events.reduce((s, e) => s + e.words, 0)
    : g => g.events.length;
  const values = groups.map(metricFn);
  const maxVal = Math.max(...values, 1);
  const periodTotal = values.reduce((a, b) => a + b, 0);
  const peakIdx = values.reduce((bi, v, i) => (v > values[bi] ? i : bi), 0);
  const peakVal = values[peakIdx];
  const lastV = values[values.length - 1] || 0;
  const prevV = values[values.length - 2] || 0;
  const pctChange = prevV > 0 ? Math.round((lastV - prevV) / prevV * 100) : null;
  const bars = groups.map((g, i) => {
    const val = values[i];
    const pct = val > 0 ? Math.max(val / maxVal * 88, 5) : 0;
    const lbl = isWords ? fmtNum(val) : String(val);
    const isPeak = val > 0 && i === peakIdx;
    const tip = `${g.label}: ${isWords ? fmtNum(val) + ' words · ' + fmtTime(val / SPEED) : val + (val === 1 ? ' read' : ' reads')}`;
    return `<div class="chart-col" title="${tip}">
      <div class="chart-bar-wrap">
        ${val > 0 ? `<span class="chart-bar-val${isPeak ? ' peak' : ''}">${isPeak ? '🔥' : ''}${lbl}</span>` : ''}
        <div class="chart-bar${val === 0 ? ' empty' : ''}${isPeak ? ' peak' : ''}" style="height:${pct}%"></div>
      </div>
      <div class="chart-bar-lbl${isPeak ? ' peak' : ''}">${g.label}</div>
    </div>`;
  }).join('');
  // Friendly, dynamic headline for the trend
  const periodName = { week: 'this week', month: 'this past month', year: 'this year', ever: 'all time' }[state.statsPeriod] || '';
  const trendTxt = pctChange === null ? '' :
    pctChange > 0 ? ` · <span class="ins-up">▲ ${pctChange}% vs before</span>` :
    pctChange < 0 ? ` · <span class="ins-down">▼ ${Math.abs(pctChange)}% vs before</span>` : ` · <span class="ins-flat">→ steady</span>`;
  let insightHtml;
  if (periodTotal === 0) {
    insightHtml = `<span class="ins-emoji">🌱</span> Nothing logged ${periodName} yet — finish a fic (or add a finish date) and watch this fill up!`;
  } else if (isWords) {
    const books = periodTotal / 90000;
    const booksTxt = books >= 0.4 ? ` &nbsp;·&nbsp; 📚 ≈ ${books < 10 ? books.toFixed(1) : Math.round(books)} books` : '';
    insightHtml = `<span class="ins-emoji">📖</span> <b>${fmtNum(periodTotal)}</b> words ${periodName}${booksTxt} &nbsp;·&nbsp; 🔥 best: <b>${groups[peakIdx].label}</b>${trendTxt}`;
  } else {
    insightHtml = `<span class="ins-emoji">✅</span> <b>${periodTotal}</b> finished ${periodName} &nbsp;·&nbsp; 🔥 best: <b>${groups[peakIdx].label}</b>${trendTxt}`;
  }

  const datedCount = items.filter(x => x.finishedAt).length;
  const noteHtml = datedCount < totalCount
    ? `<p class="stats-note">📅 ${totalCount - datedCount} of ${totalCount} items have no finish date — they count in the totals above but not in the chart. Edit items to add dates.</p>`
    : '';

  const pBtn = (id, lbl) =>
    `<button class="speriod-btn${state.statsPeriod===id?' active':''}" data-speriod="${id}">${lbl}</button>`;
  const mBtn = (id, lbl) =>
    `<button class="smetric-btn${state.statsMetric===id?' active':''}" data-smetric="${id}">${lbl}</button>`;

  // Reading pace — fics tracked through the MySpace board (have both a start and finish date).
  const pacedReads = state.items
    .filter(x => x.type === 'ff' && x.readingStartedAt && x.finishedAt && x.words > 0 && Date.parse(x.finishedAt) >= Date.parse(x.readingStartedAt))
    .map(x => { const days = daysBetween(x.readingStartedAt, x.finishedAt); return { title: x.title, words: x.words, days, pace: Math.round(x.words / days), end: x.finishedAt }; })
    .sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
  let paceHtml = '';
  if (pacedReads.length) {
    const avg = Math.round(pacedReads.reduce((s, r) => s + r.pace, 0) / pacedReads.length);
    const maxPace = Math.max(...pacedReads.map(r => r.pace), 1);
    const paceBars = pacedReads.map(r => {
      const h = Math.max(r.pace / maxPace * 88, 5);
      return `<div class="chart-col" title="${esc(r.title || '')} — ${fmtNum(r.pace)} words/day (${fmtNum(r.words)}w in ${r.days}d)">
        <div class="chart-bar-wrap"><span class="chart-bar-val">${fmtNum(r.pace)}</span><div class="chart-bar" style="height:${h}%"></div></div>
        <div class="chart-bar-lbl">${fmtDateShort(r.end)}</div>
      </div>`;
    }).join('');
    paceHtml = `
      <div class="stats-trend-hdr" style="margin-top:24px">
        <span class="stats-section-ttl">📖 Reading pace</span>
        <span class="stats-note" style="margin:0">avg <b>${fmtNum(avg)}</b> words/day · ${pacedReads.length} tracked read${pacedReads.length === 1 ? '' : 's'}</span>
      </div>
      <div class="stats-chart">${paceBars}</div>
      <div class="stats-chart-base"></div>
      <p class="stats-note" style="margin-top:6px">Pace = word count ÷ days from start to finish. Reads are tracked by dragging fics through the <b>MySpace</b> board (TBR → Reading → Finished).</p>`;
  }

  return `<div id="stats-view">
    <div class="stats-cats">
      ${tab('all','All')}${tab('books','📚 Books')}${tab('ff','📖 Fanfiction')}${tab('oneshot','📄 One-shots')}
    </div>
    <div class="stats-summary">
      <div class="scard"><div class="scard-num">${totalCount}</div><div class="scard-lbl">items</div></div>
      <div class="scard"><div class="scard-num">${fmtNum(totalWords)}</div><div class="scard-lbl">words read</div></div>
      <div class="scard"><div class="scard-num">${fmtTime(totalMins)}</div><div class="scard-lbl">reading time*</div></div>
    </div>
    ${breakdownHtml}
    <div class="stats-trend-hdr">
      <span class="stats-section-ttl">Reading trend</span>
      <div class="stats-ctrls">
        <div class="speriod-group">${pBtn('week','Week')}${pBtn('month','Month')}${pBtn('year','Year')}${pBtn('ever','All time')}</div>
        <div class="smetric-group">${mBtn('words','Words')}${mBtn('items','Items')}</div>
      </div>
    </div>
    <div class="stats-insight">${insightHtml}</div>
    <div class="stats-chart">${bars}</div>
    <div class="stats-chart-base"></div>
    ${noteHtml}
    <p class="stats-note" style="margin-top:6px">* estimated at 250 words/min; books without word count use 250 words/page</p>
    ${paceHtml}
  </div>`;
}

// ── MySpace — reading board ─────────────────────────────────────────────────────
function mySpaceCard(x) {
  const [c1, c2] = folderGradient(x.id);
  const coverIsUrl = (x.coverIcon || '').startsWith('http');
  const cover = coverIsUrl
    ? `<img class="ms-cover-img" src="${esc(x.coverIcon)}" />`
    : `<span class="ms-cover-emoji">${x.coverIcon || '✍️'}</span>`;
  const tags = [];
  if (x.status === 'Reading' && x.readingStartedAt) {
    tags.push(`<span class="ms-badge">▶ ${fmtDateShort(x.readingStartedAt)} · ${daysBetween(x.readingStartedAt, new Date().toISOString())}d</span>`);
  }
  if (x.words) tags.push(`<span class="ms-wc">${fmtNum(x.words)}w</span>`);
  if (x.url) tags.push(`<button class="ms-link" data-open-url="${esc(x.url)}" draggable="false" title="Open in browser">🔗</button>`);
  if (/archiveofourown|fanfiction\.net|transformativeworks/.test(x.url || '')) tags.push(`<button class="ms-refresh" data-ms-refresh="${esc(x.id)}" draggable="false" title="Refresh word count from the link">↻</button>`);
  return `<div class="ms-card" draggable="true" data-ms-id="${esc(x.id)}" title="${esc(x.title || '')}">
    <div class="ms-cover" style="background:linear-gradient(135deg,${c1},${c2})">${cover}<button class="ms-cover-edit cover-edit-btn" data-edit-item-icon="${esc(x.id)}" draggable="false" title="Change cover">✏️</button></div>
    <div class="ms-meta">
      <div class="ms-title">${esc(x.title || 'Untitled')}</div>
      <div class="ms-author">${esc(x.author || '')}${x.fandom ? ' · ' + esc(x.fandom) : ''}</div>
      ${tags.length ? `<div class="ms-tags">${tags.join('')}</div>` : ''}
    </div>
  </div>`;
}

function mySpaceHtml() {
  const ffs = state.items.filter(x => x.type === 'ff');
  const tbr = ffs.filter(x => (x.status || 'TBR') === 'TBR');
  const reading = ffs.filter(x => x.status === 'Reading' && !x.waitingOnChap);
  const waiting = ffs.filter(x => x.status === 'Reading' && x.waitingOnChap);
  const byAdded = (a, b) => (b._addedAt || 0) - (a._addedAt || 0);
  const byStarted = (a, b) => ((Date.parse(b.readingStartedAt) || 0) - (Date.parse(a.readingStartedAt) || 0)) || byAdded(a, b);
  tbr.sort(byAdded); reading.sort(byStarted); waiting.sort(byStarted);
  const body = (items, empty) => items.length ? items.map(mySpaceCard).join('') : `<div class="ms-empty">${empty}</div>`;
  return `<div class="ms-board">
    <div class="ms-col" data-ms-drop="TBR">
      <div class="ms-col-hdr"><span>📚 To Be Read</span><span class="ms-count">${tbr.length}</span></div>
      <div class="ms-col-body">${body(tbr, 'Your to-read fics live here')}</div>
    </div>
    <div class="ms-col ms-col-reading" data-ms-drop="Reading">
      <div class="ms-col-hdr"><span>📖 Reading</span><span class="ms-count">${reading.length}</span></div>
      <div class="ms-col-body">${body(reading, 'Drag a fic here when you start reading — the date is logged')}</div>
    </div>
    <div class="ms-col-right">
      <div class="ms-col ms-col-waiting" data-ms-drop="Waiting">
        <div class="ms-col-hdr"><span>⏳ Waiting on chap</span><span class="ms-count">${waiting.length}</span></div>
        <div class="ms-col-body">${body(waiting, 'WIPs you’re caught up on — waiting for new chapters')}</div>
      </div>
      <div class="ms-finish" data-ms-drop="Finished">
        <div class="ms-finish-icon">✅</div>
        <div class="ms-finish-ttl">Finished</div>
        <div class="ms-finish-sub">Drop here to mark finished today &amp; log your reading pace</div>
      </div>
    </div>
  </div>`;
}

// Big book cover for the "currently reading" shelf.
const HP_PLANT = `<svg class="plant-svg" viewBox="0 0 60 90">
  <path class="leaf" d="M30 58 C 10 50 9 22 22 12 C 31 30 35 47 30 58 Z"/>
  <path class="leaf" d="M30 58 C 50 50 51 22 38 12 C 29 30 25 47 30 58 Z"/>
  <path class="leaf" d="M30 58 C 24 34 26 9 31 2 C 39 14 39 40 30 58 Z"/>
  <path class="leaf leaf-sm" d="M30 58 C 16 50 11 37 13 31 C 24 35 30 46 30 58 Z"/>
  <path class="leaf leaf-sm" d="M30 58 C 44 50 49 37 47 31 C 36 35 30 46 30 58 Z"/>
  <path class="pot" d="M19 57 L41 57 L38 84 L22 84 Z"/>
  <rect class="pot-rim" x="16" y="52" width="28" height="8" rx="2"/>
</svg>`;

function mySpaceShelfCover(x) {
  const [c1, c2] = folderGradient(x.id);
  const coverIsUrl = (x.coverIcon || '').startsWith('http');
  const cover = coverIsUrl
    ? `<img class="ms-shelf-img" src="${esc(x.coverIcon)}" />`
    : `<span class="ms-shelf-emoji">${x.coverIcon || '📚'}</span>`;
  return `<div class="ms-shelf-book" draggable="true" data-ms-id="${esc(x.id)}" title="${esc(x.title || '')}">
    <div class="ms-shelf-cover" style="background:linear-gradient(135deg,${c1},${c2})">${cover}<button class="ms-cover-edit cover-edit-btn" data-edit-item-icon="${esc(x.id)}" draggable="false" title="Change cover">✏️</button></div>
  </div>`;
}

function mySpaceShelfCap(x) {
  const started = x.readingStartedAt
    ? `<div class="ms-shelf-since">▶ ${fmtDateShort(x.readingStartedAt)} · ${daysBetween(x.readingStartedAt, new Date().toISOString())}d</div>` : '';
  return `<div class="ms-shelf-cap">
    <div class="ms-shelf-ttl">${esc(x.title || 'Untitled')}</div>
    <div class="ms-shelf-author">${esc(x.author || '')}</div>
    ${started}
  </div>`;
}

function mySpaceBooksHtml() {
  const books = state.items.filter(x => x.type === 'book');
  const tbr = books.filter(x => (x.status || 'TBR') === 'TBR');
  const reading = books.filter(x => x.status === 'Reading');
  const byAdded = (a, b) => (b._addedAt || 0) - (a._addedAt || 0);
  const byStarted = (a, b) => ((Date.parse(b.readingStartedAt) || 0) - (Date.parse(a.readingStartedAt) || 0)) || byAdded(a, b);
  tbr.sort(byAdded); reading.sort(byStarted);
  const tbrBody = tbr.length ? tbr.map(mySpaceCard).join('') : `<div class="ms-empty">Your to-read books live here</div>`;
  const shelf = reading.length
    ? `<div class="ms-shelf-scene">
         <div class="ms-plant ms-plant-l">${HP_PLANT}</div>
         <div class="ms-shelf-covers">${reading.map(mySpaceShelfCover).join('')}</div>
         <div class="ms-plant ms-plant-r">${HP_PLANT}</div>
       </div>
       <div class="ms-shelf-plank"></div>
       <div class="ms-shelf-caps">${reading.map(mySpaceShelfCap).join('')}</div>`
    : `<div class="ms-shelf-scene">
         <div class="ms-plant ms-plant-l">${HP_PLANT}</div>
         <div class="ms-shelf-empty"><div class="ms-shelf-empty-ico">📖</div><div>Drag a book here when you start reading it</div></div>
         <div class="ms-plant ms-plant-r">${HP_PLANT}</div>
       </div>
       <div class="ms-shelf-plank"></div>`;
  return `<div class="ms-board ms-board-books">
    <div class="ms-col" data-ms-drop="TBR">
      <div class="ms-col-hdr"><span>📚 To Be Read</span><span class="ms-count">${tbr.length}</span></div>
      <div class="ms-col-body">${tbrBody}</div>
    </div>
    <div class="ms-col-right">
      <div class="ms-shelf-panel" data-ms-drop="Reading">${shelf}</div>
      <div class="ms-finish ms-finish-shelf" data-ms-drop="Finished">
        <div class="ms-finish-icon">✅</div>
        <div class="ms-finish-ttl">Finished</div>
        <div class="ms-finish-sub">Drop here to mark it finished today</div>
      </div>
    </div>
  </div>`;
}

// Re-fetch the live word count from a fic's AO3 / FF.net link (mutates item in place).
// Returns { ok, old, new } on success, { ok:false } on failure, or null if there's no usable URL.
async function refreshWordCount(item) {
  if (!item) return null;
  const url = (item.url || '').replace('archive.transformativeworks.org', 'archiveofourown.org');
  const isAO3 = url.includes('archiveofourown');
  const isFFNet = url.includes('fanfiction.net');
  if (!url || (!isAO3 && !isFFNet)) return null;
  try {
    const data = isAO3 ? await window.api.fetchAO3(url) : await window.api.fetchFFNet(url);
    if (data && !data.error && data.words) {
      const old = item.words || 0;
      item.words = data.words;
      if (data.hearts) item.hearts = data.hearts;
      item._modAt = new Date().toISOString();
      return { ok: true, old, new: data.words };
    }
    if (data && data.needsLogin) return { ok: false, needsLogin: true };
  } catch (e) {}
  return { ok: false };
}

async function moveMsCard(id, target) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;
  const now = new Date().toISOString();
  if (target === 'TBR') {
    item.status = 'TBR'; item.waitingOnChap = false; item.readingStartedAt = null;
  } else if (target === 'Reading') {
    item.status = 'Reading'; item.waitingOnChap = false;
    if (!item.readingStartedAt) item.readingStartedAt = now;
  } else if (target === 'Waiting') {
    item.status = 'Reading'; item.waitingOnChap = true;
    if (!item.readingStartedAt) item.readingStartedAt = now;
  } else if (target === 'Finished') {
    // Capture the final word count from the source so stats & pace reflect the
    // complete work you actually read (WIP counts grow while you're reading).
    showToast('Marking finished — refreshing word count…', 'loading');
    const res = await refreshWordCount(item);
    item.status = 'Finished'; item.waitingOnChap = false; item.finishedAt = now;
    if (!(timesRead(item) > 0)) { item.readDates = [now]; item.readCount = 1; }
    item._modAt = now;
    saveData(); render();
    if (res && res.ok && res.new !== res.old) showToast(`Finished ✓ — word count updated ${fmtNum(res.old)} → ${fmtNum(res.new)}`, 'success');
    else if (res && res.ok) showToast('Finished ✓ — word count already current', 'success');
    else if (res && res.needsLogin) showToast('Finished ✓ — 🔒 locked work; use “🔑 AO3 login” then ↻ to update the count.', 'info');
    else if (res === null) showToast(item.type === 'book' ? '📚 Finished ✓ — onto the read pile!' : 'Finished ✓ (add the AO3/FF.net link to auto-update word count)', 'info');
    else showToast('Finished ✓ — couldn’t reach the link to refresh word count', 'info');
    return;
  } else return;
  item._modAt = now;
  saveData();
  render();
}

// ── Harry Potter folder mascot: a Pusheen-style Gryffindor cat that floats on a broom and flies across when touched ──
function hpCatHtml() {
  return `<div id="hp-cat" class="hp-cat" title="touch me to fly!">
    <img class="hp-cat-img" src="hp_cat.png" alt="Gryffindor cat on a broom" draggable="false" />
  </div>`;
}

function mountHpCat() {
  const cat = document.getElementById('hp-cat');
  if (!cat) return;
  const W = 200;
  const xFor = side => (side === 'left' ? 20 : Math.max(40, window.innerWidth - W - 30)) + 'px';
  if (!cat.dataset.side) cat.dataset.side = 'right';
  cat.style.left = xFor(cat.dataset.side);

  // a fixed layer to host the little star particles
  let layer = document.getElementById('hp-star-layer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'hp-star-layer'; document.body.appendChild(layer); }
  const sparkle = (x, y, big) => {
    const s = document.createElement('div');
    s.className = 'hp-star';
    s.textContent = '★';
    s.style.left = x + 'px'; s.style.top = y + 'px';
    s.style.fontSize = ((big ? 12 : 8) + Math.random() * 7) + 'px';
    s.style.setProperty('--dx', ((Math.random() * 2 - 1) * 22).toFixed(0) + 'px');
    s.style.setProperty('--dy', ((big ? 16 : 8) + Math.random() * 14).toFixed(0) + 'px');
    s.style.setProperty('--rot', ((Math.random() * 2 - 1) * 70).toFixed(0) + 'deg');
    layer.appendChild(s);
    setTimeout(() => s.remove(), 850);
  };

  // eyes follow the cursor + a trail of yellow stars from the pointer (HP folder only)
  if (window._hpMove) document.removeEventListener('mousemove', window._hpMove);
  let lastTrail = 0;
  window._hpMove = e => {
    const c = document.getElementById('hp-cat');
    if (!c) { document.removeEventListener('mousemove', window._hpMove); window._hpMove = null; return; }
    const now = Date.now();
    if (now - lastTrail > 45) { lastTrail = now; sparkle(e.clientX, e.clientY, false); }
  };
  document.addEventListener('mousemove', window._hpMove);

  // touch → slowly fly across, leaving a star trail from the broom
  const fly = () => {
    if (cat.classList.contains('is-flying')) return;
    const to = cat.dataset.side === 'left' ? 'right' : 'left';
    cat.classList.add('is-flying');
    cat.classList.toggle('facing-right', to === 'right'); // face the way it's going
    cat.style.left = xFor(to);
    cat.dataset.side = to;
    const trail = setInterval(() => {
      const r = cat.getBoundingClientRect();
      const broomX = cat.classList.contains('facing-right') ? r.left + r.width * 0.16 : r.right - r.width * 0.16;
      sparkle(broomX + (Math.random() * 16 - 8), r.top + r.height * 0.6, true);
    }, 85);
    setTimeout(() => { cat.classList.remove('is-flying'); clearInterval(trail); }, 3850);
  };
  cat.addEventListener('mouseenter', fly);
  cat.addEventListener('click', fly);
}

// ── Folder view ───────────────────────────────────────────────────────────────
const FOLDER_DEFAULTS = {
  'ff|Harry Potter - J. K. Rowling':                         { displayName: 'Harry Potter', icon: '⚡' },
  'ff|Harry Potter - J. K. Rowling|Drarry':                  { displayName: 'Draco/Harry', icon: '🐍' },
  'ff|Harry Potter - J. K. Rowling|Tomarry':                 { displayName: 'Tom Riddle/Harry', icon: '🐍' },
  'ff|Harry Potter - J. K. Rowling|Harry/Hermione':          { displayName: 'Harry & Hermione', icon: '📚' },
  'ff|Harry Potter - J. K. Rowling|Harry/Ginny':             { displayName: 'Harry & Ginny', icon: '🔥' },
  'ff|Harry Potter - J. K. Rowling|Mentor Severus':          { displayName: 'Mentor Severus', icon: '🧪' },
  'ff|Harry Potter - J. K. Rowling|Powerful!Harry':          { displayName: 'Powerful Harry', icon: '💥' },
  'ff|Harry Potter - J. K. Rowling|Time/Dimension Travel HP':{ displayName: 'Time Travel', icon: '⏳' },
  'ff|Harry Potter - J. K. Rowling|Harry in Slytherin':      { displayName: 'Harry in Slytherin', icon: '🐍' },
  'ff|Harry Potter - J. K. Rowling|Creature Harry':          { displayName: 'Creature Harry', icon: '🐺' },
};

const GRADIENTS = [
  ['#6366f1','#4338ca'], ['#8b5cf6','#7c3aed'], ['#ec4899','#be185d'],
  ['#f59e0b','#b45309'], ['#10b981','#047857'], ['#3b82f6','#1d4ed8'],
  ['#ef4444','#b91c1c'], ['#06b6d4','#0e7490'], ['#f97316','#c2410c'],
  ['#84cc16','#4d7c0f'],
];

function loadFolderConfig() {
  try { return JSON.parse(localStorage.getItem('folderConfig') || '{}'); } catch { return {}; }
}
function saveFolderConfig() {
  localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig));
  saveData(); // also persist to JSON file so git backup pushes it to GitHub
}

// Undo (⌘Z / Ctrl+Z) for folder structure changes — merges, renames, deletes, creates.
// Snapshot the whole folderConfig before each mutation so undo is a simple pop+restore.
const FOLDER_UNDO_LIMIT = 20;
function pushFolderUndo() {
  state.folderUndoStack.push(JSON.stringify(state.folderConfig));
  if (state.folderUndoStack.length > FOLDER_UNDO_LIMIT) state.folderUndoStack.shift();
}
function undoFolderChange() {
  const snapshot = state.folderUndoStack.pop();
  if (snapshot === undefined) { showToast('Nothing to undo', 'info'); return; }
  state.folderConfig = JSON.parse(snapshot);
  saveFolderConfig();
  render();
  showToast('Undid last folder change ↩️', 'info');
}
function getCfg(key) {
  return { ...(FOLDER_DEFAULTS[key] || {}), ...(state.folderConfig[key] || {}) };
}
function folderGradient(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h) ^ key.charCodeAt(i);
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

function folderCard(navPath, defaultEmoji, rawLabel, count) {
  const key = navPath.join('|');
  const cfg = getCfg(key);
  const label = cfg.displayName || rawLabel;
  const icon = cfg.icon || defaultEmoji;
  const pinned = cfg.pinned || false;
  const [c1, c2] = folderGradient(key);
  const nav = JSON.stringify(navPath).replace(/"/g,'&quot;');
  const editKey = key.replace(/"/g,'&quot;');
  const isUrl = icon.startsWith('http');
  const iconHtml = isUrl ? `<img class="fc-img" src="${esc(icon)}" />` : `<span class="fc-emoji">${icon}</span>`;
  // Draggable so tag/group folders can be dropped onto one another to nest — only real
  // tag-level ff folders qualify (not All/Untagged, not fandom tiles, not book genres).
  const isDraggable = navPath.length === 3 && navPath[0] === 'ff' && !['__all__','__untagged__'].includes(navPath[2]);
  const dragAttrs = isDraggable ? ` draggable="true" data-drag-key="${editKey}"` : '';
  return `<div class="folder-card${pinned?' fc-pinned':''}" data-folder-nav="${nav}"${dragAttrs}>
    <div class="fc-thumb" style="--c1:${c1};--c2:${c2}">
      ${iconHtml}
      ${pinned ? '<span class="fc-pin">📌</span>' : ''}
      <button class="fc-edit-btn" data-edit-folder="${editKey}">✏️ Edit</button>
    </div>
    <div class="fc-info">
      <div class="fc-name">${esc(label)}</div>
      <div class="fc-count">${count} ${count===1?'item':'items'}</div>
    </div>
  </div>`;
}

function addFolderCard(parentPath) {
  const ap = JSON.stringify(parentPath).replace(/"/g,'&quot;');
  return `<div class="folder-card folder-card-add" data-add-folder="${ap}">
    <div class="fc-thumb fc-thumb-add"><span style="font-size:28px;opacity:0.35">＋</span></div>
    <div class="fc-info">
      <div class="fc-name" style="color:#9ca3af">New folder</div>
      <div class="fc-count" style="color:#d1d5db">Customise</div>
    </div>
  </div>`;
}

// The raw tags a folder key represents — a group's member tags, or the tag itself.
function folderTagsOf(key) {
  const cfg = state.folderConfig[key];
  if (cfg && cfg.isGroup) return (cfg.groupTags || []).slice();
  const parts = key.split('|');
  return [parts[parts.length - 1]];
}

// iOS-style "drag one folder onto another" — combines two tag/group folders into one
// group folder, or drops a tag/group into an existing group.
function mergeFoldersIntoGroup(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const sParts = sourceKey.split('|');
  const tParts = targetKey.split('|');
  if (sParts[0] !== tParts[0] || sParts[1] !== tParts[1]) return; // different fandom/section — no-op

  const sourceCfg = state.folderConfig[sourceKey];
  const targetCfg = state.folderConfig[targetKey];
  const sourceTags = folderTagsOf(sourceKey);
  pushFolderUndo();

  if (targetCfg && targetCfg.isGroup) {
    // Drop into an existing group — just add the source's tag(s), keep the group's identity.
    const merged = [...new Set([...(targetCfg.groupTags || []), ...sourceTags])];
    state.folderConfig[targetKey] = { ...targetCfg, isCustom: true, isGroup: true, groupTags: merged, _modAt: new Date().toISOString() };
    if (sourceCfg && sourceCfg.isGroup) delete state.folderConfig[sourceKey]; // dissolve the now-emptied source group
    saveFolderConfig();
    render();
    return;
  }

  // Neither side is a group yet — create a brand-new one containing both, iOS-style.
  const targetTags = folderTagsOf(targetKey);
  const allTags = [...new Set([...targetTags, ...sourceTags])];
  const newKey = `${tParts[0]}|${tParts[1]}|group_${Date.now()}`;
  state.folderConfig[newKey] = {
    displayName: 'New Folder',
    icon: '📁',
    pinned: false,
    isCustom: true,
    isGroup: true,
    groupTags: allTags,
    _modAt: new Date().toISOString(),
  };
  if (sourceCfg && sourceCfg.isGroup) delete state.folderConfig[sourceKey];
  saveFolderConfig();
  state.editingFolder = newKey; // jump straight into naming it, like iOS does
  render();
}

function sortedCards(items) {
  return items.slice().sort((a, b) => {
    const ap = getCfg(a[0].join('|')).pinned || false;
    const bp = getCfg(b[0].join('|')).pinned || false;
    if (ap !== bp) return ap ? -1 : 1;
    if (state.folderSortBy === 'alpha') {
      const al = (getCfg(a[0].join('|')).displayName || a[2] || '').toLowerCase();
      const bl = (getCfg(b[0].join('|')).displayName || b[2] || '').toLowerCase();
      return al.localeCompare(bl);
    }
    return b[3] - a[3];
  });
}

function filterCards(items) {
  if (!state.folderSearch) return items;
  const q = state.folderSearch.toLowerCase();
  return items.filter(([p,e,l,c]) => {
    const display = getCfg(p.join('|')).displayName || l || '';
    return display.toLowerCase().includes(q);
  });
}

function isPairingTag(rawLabel, navPath) {
  const key = navPath.join('|');
  const cfg = getCfg(key);
  if (cfg.section === 'trope')   return false;
  if (cfg.section === 'pairing') return true;
  const display = cfg.displayName || rawLabel;
  return rawLabel.includes('/') || display.includes('/') || display.includes(' & ');
}

// A manually-typed Pairing value like "Harry/Ginny" is a real ship name and should act as a
// tag (so it gets its own folder). AO3-style relationship-category shorthand isn't a ship.
const PAIRING_CATEGORY_WORDS = new Set(['gen','m/m','f/f','f/m','m/f','multi','other','various','none','poly']);
function isShipPairing(s) {
  const v = (s || '').trim();
  if (!v || PAIRING_CATEGORY_WORDS.has(v.toLowerCase())) return false;
  return v.includes('/') || v.includes(' & ');
}

function folderCrumbs(crumbs) {
  return `<div class="folder-breadcrumb">
    <span class="fcrumb" data-folder-go="[]">Home</span>
    ${crumbs.map((c,i) => {
      const go = JSON.stringify(c.path).replace(/"/g,'&quot;');
      const last = i === crumbs.length-1;
      return `<span class="fcrumb-sep">›</span><span class="fcrumb${last?' fcrumb-active':''}" data-folder-go="${go}">${esc(c.label)}</span>`;
    }).join('')}
  </div>`;
}

const FOLDER_ITEM_FILTERS = [
  ['favorite', '⭐ Favourite', x => x.favorite],
  ['TBR',      '📋 TBR',       x => (x.status||'TBR')==='TBR'],
  ['Reading',  '📖 Reading',   x => x.status==='Reading'],
  ['Finished', '✅ Finished',  x => x.status==='Finished'],
  ['Dropped',  '🚫 Dropped',   x => x.status==='Dropped'],
  ['oneshot',  '📄 One-shot',  x => !!x.oneshot],
];

function folderItemList(items) {
  const f = state.folderItemFilter;
  const pills = FOLDER_ITEM_FILTERS.map(([key, label, pred]) =>
    `<button class="fpill folder-item-filter${f===key?' active':''}" data-folder-filter="${key}">${label} <span class="fpill-n">${items.filter(pred).length}</span></button>`
  ).join('');
  // Newest added first (last added → oldest), matching the main list view.
  let filtered = items.slice().sort((a, b) => (b._addedAt||0) - (a._addedAt||0));
  if (state.folderSearch) {
    const q = state.folderSearch.toLowerCase();
    filtered = filtered.filter(x => (x.title||'').toLowerCase().includes(q) || (x.author||'').toLowerCase().includes(q));
  }
  if (f) filtered = filtered.filter(FOLDER_ITEM_FILTERS.find(g => g[0]===f)[2]);
  const filteredActive = state.folderSearch || f;
  return `<div class="folder-filter-row">${pills}</div>
    <div class="folder-item-meta">${filtered.length} ${filtered.length===1?'entry':'entries'}${filteredActive&&filtered.length!==items.length?' shown':''}</div>
    <div id="list">${filtered.length
      ? filtered.map(cardHtml).join('')
      : `<div class="empty"><div class="empty-icon">${filteredActive?'🔍':'📭'}</div><p>${filteredActive?'No items match this filter.':'Nothing here yet.'}</p></div>`
    }</div>`;
}

function folderEditModalHtml() {
  if (!state.editingFolder) return '';
  const key = state.editingFolder;
  const cfg = getCfg(key);
  const parts = key.split('|');
  const tail = parts[parts.length-1];
  const rawLabel = tail.startsWith('custom_') ? '' : (tail==='__none__'?'Other':(tail==='__all__'?'All':(tail==='__untagged__'?'Untagged':tail)));
  const label = cfg.displayName || rawLabel;
  const icon = cfg.icon || '';
  const pinned = cfg.pinned || false;
  const isUrl = icon.startsWith('http');
  const preview = isUrl
    ? `<img src="${esc(icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px" />`
    : `<span style="font-size:38px;line-height:1">${icon || '📁'}</span>`;
  return `<div class="folder-edit-backdrop" id="folder-edit-backdrop">
    <div class="folder-edit-modal">
      <div class="fem-header">
        <span class="fem-title">Edit folder</span>
        <button class="fem-close" id="fem-close">×</button>
      </div>
      <div class="fem-preview-row"><div class="fem-preview-icon" id="fem-preview-icon">${preview}</div></div>
      <div class="fem-body">
        <label class="field-label">Name</label>
        <input type="text" id="fem-name" value="${esc(label)}" placeholder="Folder name…" />
        <label class="field-label" style="margin-top:12px">Icon <span class="fem-hint">(emoji or image URL — paste from anywhere)</span></label>
        <input type="text" id="fem-icon" value="${esc(icon)}" placeholder="⚡  or  https://…" />
        ${parts.length === 3 && parts[0] === 'ff' ? `
        <label class="field-label" style="margin-top:12px">Section</label>
        <select id="fem-section" class="filter-select" style="width:100%;margin-top:4px">
          <option value=""${!cfg.section?' selected':''}>Auto-detect</option>
          <option value="pairing"${cfg.section==='pairing'?' selected':''}>🚢 Pairings</option>
          <option value="trope"${cfg.section==='trope'?' selected':''}>⚡ Tropes &amp; AUs</option>
        </select>` : ''}
        <label class="fem-pin-row">
          <input type="checkbox" id="fem-pin" ${pinned?'checked':''} />
          <span>Pin to top</span>
        </label>
      </div>
      <div class="modal-footer"${cfg.isCustom ? ' style="justify-content:space-between"' : ''}>
        ${cfg.isCustom ? `<button class="btn fem-delete" id="fem-delete">🗑 Delete folder</button>` : ''}
        <div class="fem-footer-actions">
          <button class="btn btn-secondary" id="fem-cancel">Cancel</button>
          <button class="btn btn-primary" id="fem-save">Save</button>
        </div>
      </div>
    </div>
  </div>`;
}

function folderCreateModalHtml() {
  if (!state.creatingFolderIn) return '';
  const path = state.creatingFolderIn;
  const needsTag = path[0]==='ff' && path.length===2;
  const base = needsTag ? state.items.filter(x=>x.type==='ff'&&(path[1]==='__none__'?!x.fandom:x.fandom===path[1])) : [];
  const tagOpts = needsTag ? [...new Set(base.flatMap(x=>x.tags||[]))].sort().map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('') : '';
  return `<div class="folder-edit-backdrop" id="folder-create-backdrop">
    <div class="folder-edit-modal">
      <div class="fem-header">
        <span class="fem-title">New folder</span>
        <button class="fem-close" id="fcm-close">×</button>
      </div>
      <div class="fem-body">
        <label class="field-label">Name</label>
        <input type="text" id="fcm-name" placeholder="Folder name…" />
        <label class="field-label" style="margin-top:12px">Icon <span class="fem-hint">(emoji or image URL)</span></label>
        <input type="text" id="fcm-icon" placeholder="⚡  or  https://…" />
        ${needsTag ? `<label class="field-label" style="margin-top:12px">Filter by tag</label>
        <select id="fcm-tag" class="filter-select" style="width:100%;margin-top:4px"><option value="">— choose tag —</option>${tagOpts}</select>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="fcm-cancel">Cancel</button>
        <button class="btn btn-primary" id="fcm-save">Create</button>
      </div>
    </div>
  </div>`;
}

function itemIconModalHtml() {
  if (!state.editingItemIcon) return '';
  const item = state.items.find(x => x.id === state.editingItemIcon);
  if (!item) return '';
  const isFf = item.type === 'ff';
  const icon = item.coverIcon || '';
  const isUrl = icon.startsWith('http');
  const [c1, c2] = folderGradient(item.id);
  const preview = isUrl
    ? `<img src="${esc(icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:10px" />`
    : `<span style="font-size:38px;line-height:1">${icon || (isFf?'✍️':'📚')}</span>`;
  return `<div class="folder-edit-backdrop" id="item-icon-backdrop">
    <div class="folder-edit-modal">
      <div class="fem-header">
        <span class="fem-title">Cover icon</span>
        <button class="fem-close" id="iim-close">×</button>
      </div>
      <div class="fem-preview-row">
        <div class="fem-preview-icon" id="iim-preview-icon" style="--c1:${c1};--c2:${c2};background:linear-gradient(135deg,var(--c1),var(--c2))">${preview}</div>
      </div>
      <div class="fem-body">
        <label class="field-label">Icon <span class="fem-hint">(emoji or image URL — paste from anywhere)</span></label>
        <input type="text" id="iim-icon" value="${esc(icon)}" placeholder="📚  or  https://…" />
        ${icon ? `<button class="btn btn-secondary btn-sm" id="iim-clear" style="margin-top:8px;width:100%">Reset to default</button>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="iim-cancel">Cancel</button>
        <button class="btn btn-primary" id="iim-save">Save</button>
      </div>
    </div>
  </div>`;
}

function folderControlBar(isItemList) {
  const sortBar = !isItemList ? `<select class="folder-sort-select" id="folder-sort">
    <option value="count"${state.folderSortBy==='count'?' selected':''}>Most items</option>
    <option value="alpha"${state.folderSortBy==='alpha'?' selected':''}>A → Z</option>
  </select>` : '';
  return `<div class="folder-search-row">
    <input type="text" class="folder-search-input" id="folder-search" placeholder="${isItemList?'Search items…':'Search folders…'}" value="${esc(state.folderSearch)}" />
    ${sortBar}
  </div>`;
}

// If the current folder has become empty (e.g. after removing the last item's tag), step back out of it.
function pruneEmptyFolderPath() {
  const countAt = p => {
    const [type, sub, tag, childTag] = p;
    if (!type) return 1;
    if (type === 'ff') {
      if (!sub) return 1;
      const base = state.items.filter(x=>x.type==='ff'&&(sub==='__none__'?!x.fandom:x.fandom===sub));
      if (!tag) return base.length;
      if (tag === '__all__') return base.length;
      if (tag === '__untagged__') return base.filter(x=>!(x.tags||[]).length).length;
      const cfg = state.folderConfig['ff|'+sub+'|'+tag];
      if (cfg && cfg.isGroup) {
        if (!childTag) return base.filter(x=>(x.tags||[]).some(t=>(cfg.groupTags||[]).includes(t))).length;
        return base.filter(x=>(x.tags||[]).includes(childTag)).length;
      }
      if (cfg && cfg.isCustom) return 1;
      return base.filter(x=>(x.tags||[]).includes(tag)).length;
    }
    if (type === 'book') {
      if (!sub) return 1;
      return (sub==='__none__'
        ? state.items.filter(x=>x.type==='book'&&!x.genre)
        : state.items.filter(x=>x.type==='book'&&(x.genre||'').split(' / ')[0].trim()===sub)).length;
    }
    return 1;
  };
  while (state.folderPath.length > 1 && countAt(state.folderPath) === 0) {
    state.folderPath = state.folderPath.slice(0, -1);
  }
}

function folderViewHtml() {
  pruneEmptyFolderPath();
  const [type, sub, tag, childTag] = state.folderPath;

  // Root — two big tiles, with the full list view underneath
  if (!type) {
    const ffN = state.items.filter(x=>x.type==='ff').length;
    const bkN = state.items.filter(x=>x.type==='book').length;
    return `<div id="folder-view">
      <div class="folder-grid folder-grid-root">
        ${folderCard(['ff'],'📖','Fanfiction',ffN)}
        ${folderCard(['book'],'📚','Books',bkN)}
      </div>
      ${listViewContentHtml()}
    </div>`;
  }

  // FF → fandom list
  if (type==='ff' && !sub) {
    const raw = getFandoms().map(f => {
      const n = state.items.filter(x=>x.type==='ff'&&x.fandom===f).length;
      return [['ff',f], fandomEmoji(f), f, n];
    });
    const none = state.items.filter(x=>x.type==='ff'&&!x.fandom);
    if (none.length) raw.push([['ff','__none__'],'📄','Other',none.length]);
    Object.keys(state.folderConfig).filter(k=>state.folderConfig[k].isCustom && k.split('|').length===2 && k.startsWith('ff|')).forEach(k => {
      const cfg = state.folderConfig[k];
      const n = cfg.filterTag ? state.items.filter(x=>x.type==='ff'&&(x.tags||[]).includes(cfg.filterTag)).length : 0;
      raw.push([[...k.split('|')], cfg.icon||'📁', cfg.displayName||'Custom', n]);
    });
    const cards = sortedCards(filterCards(raw)).map(([p,e,l,c]) => folderCard(p,e,l,c));
    cards.push(addFolderCard(['ff']));
    return `<div id="folder-view">
      ${folderCrumbs([{label:'Fanfiction',path:['ff']}])}
      ${folderControlBar(false)}
      <div class="folder-grid">${cards.join('')}</div>
    </div>`;
  }

  // FF → fandom → tag list (with pairing/trope split)
  if (type==='ff' && sub && !tag) {
    const base = state.items.filter(x=>x.type==='ff'&&(sub==='__none__'?!x.fandom:x.fandom===sub));
    const groupKeys = Object.keys(state.folderConfig).filter(k=>{
      const p = k.split('|');
      return state.folderConfig[k].isGroup && p.length===3 && p[0]==='ff' && p[1]===sub;
    });
    const groupedTagSet = new Set(groupKeys.flatMap(k=>state.folderConfig[k].groupTags||[]));
    const tagSet = [...new Set(base.flatMap(x=>x.tags||[]))].filter(t=>!groupedTagSet.has(t)).sort();
    const allEntry = [['ff',sub,'__all__'],'📋','All',base.length];
    const tagEntries = tagSet.map(t => {
      const n = base.filter(x=>(x.tags||[]).includes(t)).length;
      return [['ff',sub,t],'🏷️',t,n];
    });
    groupKeys.forEach(k => {
      const cfg = state.folderConfig[k];
      const n = base.filter(x=>(x.tags||[]).some(t=>(cfg.groupTags||[]).includes(t))).length;
      tagEntries.push([[...k.split('|')], cfg.icon||'📁', cfg.displayName||'Group', n]);
    });
    const untagged = base.filter(x=>!(x.tags||[]).length);
    Object.keys(state.folderConfig).filter(k=>{
      const p = k.split('|');
      return state.folderConfig[k].isCustom && !state.folderConfig[k].isGroup && p.length===3 && p[0]==='ff' && p[1]===sub;
    }).forEach(k => {
      const cfg = state.folderConfig[k];
      const n = cfg.filterTag ? base.filter(x=>(x.tags||[]).includes(cfg.filterTag)).length : 0;
      tagEntries.push([[...k.split('|')], cfg.icon||'📁', cfg.displayName||'Custom', n]);
    });
    const filtered = filterCards(tagEntries);
    const pairings = sortedCards(filtered.filter(([p,e,l,c]) => isPairingTag(l,p)));
    const tropes   = sortedCards(filtered.filter(([p,e,l,c]) => !isPairingTag(l,p)));
    const subLbl = getCfg(`ff|${sub}`).displayName || (sub==='__none__'?'Other':sub);
    let gridContent = folderCard(allEntry[0], allEntry[1], allEntry[2], allEntry[3])
      + (untagged.length ? folderCard(['ff',sub,'__untagged__'], '📄', 'Untagged', untagged.length) : '');
    if (pairings.length) {
      gridContent += `<div class="fv-section-hdr fv-section-full">🚢 Pairings</div>` + pairings.map(([p,e,l,c])=>folderCard(p,e,l,c)).join('');
    }
    if (tropes.length) {
      gridContent += `<div class="fv-section-hdr fv-section-full">⚡ Tropes & AUs</div>` + tropes.map(([p,e,l,c])=>folderCard(p,e,l,c)).join('');
    }
    gridContent += addFolderCard(['ff',sub]);
    return `<div id="folder-view">
      ${folderCrumbs([{label:'Fanfiction',path:['ff']},{label:subLbl,path:['ff',sub]}])}
      ${folderControlBar(false)}
      <div class="folder-grid">${gridContent}</div>
    </div>`;
  }

  // FF → fandom → group → child tag list
  if (type==='ff' && sub && tag) {
    const base = state.items.filter(x=>x.type==='ff'&&(sub==='__none__'?!x.fandom:x.fandom===sub));
    const customCfg = state.folderConfig[`ff|${sub}|${tag}`];

    if (customCfg?.isGroup && !childTag) {
      const subLbl = getCfg(`ff|${sub}`).displayName || (sub==='__none__'?'Other':sub);
      const groupLbl = customCfg.displayName || tag;
      const childEntries = (customCfg.groupTags||[]).map(t => {
        const n = base.filter(x=>(x.tags||[]).includes(t)).length;
        const flatCfg = getCfg(`ff|${sub}|${t}`);
        return [['ff',sub,tag,t], flatCfg.icon || '🏷️', flatCfg.displayName || t, n];
      });
      const cards = sortedCards(filterCards(childEntries)).map(([p,e,l,c])=>folderCard(p,e,l,c));
      return `<div id="folder-view">
        ${folderCrumbs([{label:'Fanfiction',path:['ff']},{label:subLbl,path:['ff',sub]},{label:groupLbl,path:['ff',sub,tag]}])}
        ${folderControlBar(false)}
        <div class="folder-grid">${cards.join('')}</div>
      </div>`;
    }

    let items;
    if (childTag) items = base.filter(x=>(x.tags||[]).includes(childTag));
    else if (tag==='__all__') items = base;
    else if (tag==='__untagged__') items = base.filter(x=>!(x.tags||[]).length);
    else if (customCfg?.isCustom && customCfg.filterTag) items = base.filter(x=>(x.tags||[]).includes(customCfg.filterTag));
    else items = base.filter(x=>(x.tags||[]).includes(tag));
    const subLbl = getCfg(`ff|${sub}`).displayName || (sub==='__none__'?'Other':sub);
    const tagLbl = getCfg(`ff|${sub}|${tag}`).displayName || (tag==='__all__'?'All':tag==='__untagged__'?'Untagged':tag);
    const crumbs = [{label:'Fanfiction',path:['ff']},{label:subLbl,path:['ff',sub]},{label:tagLbl,path:['ff',sub,tag]}];
    if (childTag) {
      const flatCfg = getCfg(`ff|${sub}|${childTag}`);
      crumbs.push({label:flatCfg.displayName || childTag, path:['ff',sub,tag,childTag]});
    }
    return `<div id="folder-view">
      ${folderCrumbs(crumbs)}
      ${folderControlBar(true)}
      ${folderItemList(items)}
    </div>`;
  }

  // Books → genre list
  if (type==='book' && !sub) {
    const raw = getGenres().map(g => {
      const n = state.items.filter(x=>x.type==='book'&&(x.genre||'').split(' / ')[0].trim()===g).length;
      return [['book',g], genreEmoji(g), g, n];
    });
    const none = state.items.filter(x=>x.type==='book'&&!x.genre);
    if (none.length) raw.push([['book','__none__'],'📖','Other',none.length]);
    const cards = sortedCards(filterCards(raw)).map(([p,e,l,c]) => folderCard(p,e,l,c));
    return `<div id="folder-view">
      ${folderCrumbs([{label:'Books',path:['book']}])}
      ${folderControlBar(false)}
      <div class="folder-grid">${cards.join('')}</div>
    </div>`;
  }

  // Books → genre → items
  if (type==='book' && sub) {
    const items = sub==='__none__'
      ? state.items.filter(x=>x.type==='book'&&!x.genre)
      : state.items.filter(x=>x.type==='book'&&(x.genre||'').split(' / ')[0].trim()===sub);
    const subLbl = getCfg(`book|${sub}`).displayName || (sub==='__none__'?'Other':sub);
    return `<div id="folder-view">
      ${folderCrumbs([{label:'Books',path:['book']},{label:subLbl,path:['book',sub]}])}
      ${folderControlBar(true)}
      ${folderItemList(items)}
    </div>`;
  }

  return `<div id="folder-view"></div>`;
}

// The stat banner + search/filter controls + item list — used standalone in List view,
// and appended below the Fanfiction/Books tiles on the folder-view home screen.
function listViewContentHtml() {
  const stats = getStats();
  const filtered = getFiltered();
  const fandoms = getFandoms();
  const sections = getSections();

  const statPillClass = (key) => {
    const map = {TBR:'tbr', Reading:'reading', Finished:'finished', Dropped:'dropped'};
    return state.filterStatus === key ? `active-${map[key]||''}` : '';
  };

  const fpill = (label, active, action) =>
    `<span class="fpill${active?' active':''}" data-${action}>${label}</span>`;

  // Fandom/section quick filters
  const fandomPills = fandoms.slice(0,12).map(f =>
    fpill(f, state.filterFandom===f, `fandom="${f}"`)
  ).join('');
  const sectionPills = sections.map(s =>
    fpill(s, state.filterSection===s, `section="${s.replace(/"/g,'&quot;')}"`)
  ).join('');
  const genrePills = getGenres().map(g =>
    fpill(g, state.filterGenre===g, `genre="${g.replace(/"/g,'&quot;')}"`)
  ).join('');

  return `
    <div class="stat-row">
      <button class="calc-stats-fab" id="btn-stats-fab" title="Stats">🧮</button>
      <div class="stat-pill ${statPillClass('TBR')}" data-stat="TBR">
        <span class="stat-num tbr">${stats.tbr}</span>
        <span class="stat-label">TBR</span>
      </div>
      <div class="stat-pill ${statPillClass('Reading')}" data-stat="Reading">
        <span class="stat-num reading">${stats.reading}</span>
        <span class="stat-label">Reading</span>
      </div>
      <div class="stat-pill ${statPillClass('Finished')}" data-stat="Finished">
        <span class="stat-num finished">${stats.finished}</span>
        <span class="stat-label">Finished</span>
      </div>
      <div class="stat-pill ${statPillClass('Dropped')}" data-stat="Dropped">
        <span class="stat-num dropped">${stats.dropped}</span>
        <span class="stat-label">Dropped</span>
      </div>
    </div>

    <div class="controls">
      <input id="search-input" type="text" placeholder="Search title, author, fandom, tag…" value="${state.search}" />
      <select class="filter-select" id="sort-select">
        <option value="added"${state.sortBy==='added'?' selected':''}>Recent (last read/added)</option>
        <option value="title"${state.sortBy==='title'?' selected':''}>A → Z</option>
        <option value="author"${state.sortBy==='author'?' selected':''}>Author A → Z</option>
        <option value="words"${state.sortBy==='words'?' selected':''}>Most words</option>
        <option value="hearts"${state.sortBy==='hearts'?' selected':''}>Most hearts</option>
        <option value="rating"${state.sortBy==='rating'?' selected':''}>My rating</option>
      </select>
    </div>

    <div class="filter-bar">
      <span class="fpill${state.filterFavorite ? ' active-fav' : ''}" data-fav-filter="true">⭐ Favorites</span>
      <span class="fpill${state.filterType==='all'&&state.filterFandom==='all'&&state.filterGenre==='all'&&state.filterSection==='all'?' active':''}" data-type="all">All</span>
      <div class="dd${(state.filterType==='ff'||state.filterType==='oneshot'||state.filterFandom!=='all')?' dd-on':''}">
        <button class="dd-btn">📖 Fanfiction <span class="dd-chev">▾</span></button>
        <div class="dd-menu">
          <div class="dd-item${state.filterType==='ff'?' sel':''}" data-type="ff">All fanfiction</div>
          <div class="dd-item${state.filterType==='oneshot'?' sel':''}" data-type="oneshot">📄 One-shots</div>
          ${fandoms.length ? '<div class="dd-sep"></div>' : ''}
          ${fandoms.map(f => `<div class="dd-item${state.filterFandom===f?' sel':''}" data-fandom="${esc(f).replace(/"/g,'&quot;')}">${esc(f)}</div>`).join('')}
        </div>
      </div>
      <div class="dd${(state.filterType==='book'||state.filterGenre!=='all')?' dd-on':''}">
        <button class="dd-btn">📚 Books <span class="dd-chev">▾</span></button>
        <div class="dd-menu">
          <div class="dd-item${state.filterType==='book'?' sel':''}" data-type="book">All books</div>
          ${getGenres().length ? '<div class="dd-sep"></div>' : ''}
          ${getGenres().map(g => `<div class="dd-item${state.filterGenre===g?' sel':''}" data-genre="${esc(g).replace(/"/g,'&quot;')}">${esc(g)}</div>`).join('')}
        </div>
      </div>
    </div>

    ${state.filterFandom !== 'all' ? (() => {
      const fandomTags = getTagsForFandom();
      if (!fandomTags.length) return '';
      const opts = fandomTags.map(t =>
        `<option value="${t}"${state.filterTag === t ? ' selected' : ''}>${t}</option>`
      ).join('');
      return `<div class="tag-filter-row">
        <span class="tag-filter-label">Tag:</span>
        <select class="filter-select" id="tag-filter-select">
          <option value="all"${state.filterTag === 'all' ? ' selected' : ''}>All tags</option>
          ${opts}
        </select>
      </div>`;
    })() : ''}

    <div id="results-meta">${filtered.length} ${filtered.length===1?'entry':'entries'}${state.search ? ` matching "<b>${state.search}</b>"` : ''}</div>

    <div id="list">
      ${filtered.length === 0 ? `
        <div class="empty">
          <div class="empty-icon">📭</div>
          <p>${state.search ? 'No entries match your search.' : 'No entries yet — add your first one!'}</p>
        </div>` : filtered.map(cardHtml).join('')}
    </div>
  `;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const scrollable = document.getElementById('list') || document.getElementById('stats-view');
  const scrollTop = scrollable ? scrollable.scrollTop : 0;
  const folderViewEl = document.getElementById('folder-view');
  const folderScrollTop = folderViewEl ? folderViewEl.scrollTop : 0;
  const stats = getStats();

  const titlebarHtml = `
    <div id="titlebar">
      <div>
        <div id="titlebar-title">My Library</div>
        <div class="subtitle">${stats.ff} fics · ${stats.books} books · ${stats.totalWords.toLocaleString()} words read</div>
      </div>
      <div id="titlebar-actions">
        <div class="dd">
          <button class="btn btn-secondary btn-sm btn-icon dd-btn">⚙️ Settings <span class="dd-chev">▾</span></button>
          <div class="dd-menu dd-menu-right">
            <div class="dd-item" id="btn-export">📊 Export to Excel</div>
            <div class="dd-item" id="btn-data-folder">📁 Open data folder</div>
            <div class="dd-item" id="btn-ao3-login">🔑 Log in to AO3</div>
            <div class="dd-item" id="btn-sync">🔄 Sync — get latest from GitHub</div>
            <div class="dd-sep"></div>
            <div class="dd-item" id="btn-stats">${state.view==='stats'?'📚 Back to Library':'📈 Stats'}</div>
            <div class="dd-item" id="btn-settings">🎨 Page banners</div>
          </div>
        </div>
        <button class="btn btn-backup btn-sm btn-icon" id="btn-backup" title="Back up — save all changes to GitHub">☁️ Back up</button>
        <button class="btn btn-primary btn-sm btn-icon" id="btn-add">＋ Add entry</button>
      </div>
    </div>`;

  if (state.view === 'stats') {
    document.getElementById('app').innerHTML = titlebarHtml + statsViewHtml() + (state.modalOpen ? modalHtml() : '') + settingsModalHtml();
    const newScrollable = document.getElementById('stats-view');
    if (newScrollable) newScrollable.scrollTop = scrollTop;
    bindEvents();
    return;
  }

  if (state.viewMode === 'folder') {
    const inHp = state.folderPath[0] === 'ff' && state.folderPath[1] === 'Harry Potter - J. K. Rowling';
    document.getElementById('app').innerHTML = titlebarHtml + folderViewHtml() + folderEditModalHtml() + folderCreateModalHtml() + itemIconModalHtml() + (state.modalOpen ? modalHtml() : '') + settingsModalHtml() + (inHp ? hpCatHtml() : '');
    const newFolderView = document.getElementById('folder-view');
    if (newFolderView) newFolderView.scrollTop = folderScrollTop;
    bindEvents();
    if (inHp) mountHpCat();
    return;
  }

  if (state.viewMode === 'myspace') {
    const msTab = state.mySpaceTab === 'books' ? 'books' : 'ff';
    document.getElementById('app').innerHTML = titlebarHtml +
      `<div id="myspace-page">
        <div class="ms-tabs">
          <button class="ms-tab${msTab==='ff'?' active':''}" data-ms-tab="ff">📖 Fanfiction</button>
          <button class="ms-tab${msTab==='books'?' active':''}" data-ms-tab="books">📚 Books</button>
        </div>
        ${msTab==='books' ? mySpaceBooksHtml() : mySpaceHtml()}
      </div>` +
      (state.modalOpen ? modalHtml() : '') + itemIconModalHtml() + settingsModalHtml();
    bindEvents();
    return;
  }

  document.getElementById('app').innerHTML = titlebarHtml + listViewContentHtml() + `
    ${state.modalOpen ? modalHtml() : ''}
    ${itemIconModalHtml()}
    ${settingsModalHtml()}
  `;

  const newListEl = document.getElementById('list');
  if (newListEl) newListEl.scrollTop = scrollTop;
  bindEvents();
}


// ── Event binding ─────────────────────────────────────────────────────────────
function snapshotModalForm() {
  // Capture whatever is currently typed into the modal form, even for a brand-new
  // entry (state.editItem === null) — otherwise adding a tag mid-entry wipes the
  // title/author/etc. on the re-render.
  if (!state.modalOpen) return;
  const base = state.editItem || {};
  const v = id => document.getElementById(id)?.value ?? null;
  const patch = {};
  const url     = v('m-url');     if (url     !== null) patch.url     = url.trim();
  const title   = v('m-title');   if (title   !== null) patch.title   = title.trim();
  const author  = v('m-author');  if (author  !== null) patch.author  = author.trim();
  const fandom  = v('m-fandom');  if (fandom  !== null) patch.fandom  = fandom.trim();
  const genre   = v('m-genre');   if (genre   !== null) patch.genre   = genre.trim();
  const section = v('m-section'); if (section !== null) patch.section = section.trim();
  const pairing = v('m-pairing'); if (pairing !== null) patch.pairing = pairing.trim();
  const notes   = v('m-notes');   if (notes   !== null) patch.notes   = notes.trim();
  const status  = v('m-status');  if (status  !== null) patch.status  = status;
  const rating  = v('m-rating');  if (rating  !== null) patch.rating  = rating;
  const ws = v('m-words');     if (ws && ws.trim())  patch.words     = parseInt(ws)  || base.words;
  const hs = v('m-hearts');    if (hs && hs.trim())  patch.hearts    = parseInt(hs)  || base.hearts;
  const ps = v('m-pages');     if (ps && ps.trim())  patch.pages     = parseInt(ps)  || base.pages;
  const rc = v('m-readcount');
  if (rc !== null) {
    const n = Math.max(0, parseInt(rc) || 0);
    const dates = ensureReadDates(base);
    if (n > dates.length) { const fill = base.finishedAt || null; while (dates.length < n) dates.push(fill); }
    else dates.length = n;
    patch.readDates = dates;
    patch.readCount = n;
  }
  state.editItem = { ...base, ...patch };
}

function bindEvents() {
  // Search
  const searchEl = document.getElementById('search-input');
  if (searchEl) searchEl.addEventListener('input', e => {
    const cursorPos = e.target.selectionStart;
    state.search = e.target.value;
    render();
    const newEl = document.getElementById('search-input');
    if (newEl) { newEl.focus(); newEl.setSelectionRange(cursorPos, cursorPos); }
  });

  // Sort
  const sortEl = document.getElementById('sort-select');
  if (sortEl) sortEl.addEventListener('change', e => { state.sortBy = e.target.value; render(); });

  // Stats toggle
  const toggleStatsView = () => {
    state.view = state.view === 'stats' ? 'library' : 'stats';
    state.modalOpen = false; state.editItem = null;
    render();
  };
  document.getElementById('btn-stats')?.addEventListener('click', toggleStatsView);
  document.getElementById('btn-stats-fab')?.addEventListener('click', toggleStatsView);

  // View mode toggle (list / folder)
  document.getElementById('btn-view-list')?.addEventListener('click', () => {
    state.viewMode = 'list'; render();
  });
  document.getElementById('btn-view-folder')?.addEventListener('click', () => {
    state.viewMode = 'folder'; render();
  });
  document.getElementById('btn-view-myspace')?.addEventListener('click', () => {
    state.viewMode = 'myspace'; state.view = 'library'; render();
  });

  // ── MySpace: Fanfiction / Books tab switch ──
  document.querySelectorAll('[data-ms-tab]').forEach(btn => {
    btn.addEventListener('click', () => { state.mySpaceTab = btn.dataset.msTab; render(); });
  });

  // ── MySpace board: drag & drop ──
  let _msDrag = null, _msDragged = false;
  document.querySelectorAll('.ms-card, .ms-shelf-book').forEach(c => {
    c.addEventListener('dragstart', e => {
      _msDrag = c.dataset.msId; _msDragged = true;
      c.classList.add('ms-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', c.dataset.msId); } catch (err) {}
    });
    c.addEventListener('dragend', () => {
      c.classList.remove('ms-dragging');
      document.querySelectorAll('.ms-drop-over').forEach(z => z.classList.remove('ms-drop-over'));
      setTimeout(() => { _msDragged = false; }, 0);
    });
    c.addEventListener('click', () => {
      if (_msDragged) return;
      const item = state.items.find(x => x.id === c.dataset.msId);
      if (item) { state.editItem = { ...item }; state.modalOpen = true; render(); }
    });
  });
  document.querySelectorAll('[data-ms-refresh]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const item = state.items.find(x => x.id === btn.dataset.msRefresh);
      if (!item) return;
      btn.textContent = '…'; btn.disabled = true;
      showToast('Refreshing word count…', 'loading');
      const res = await refreshWordCount(item);
      if (res && res.ok && res.new !== res.old) { saveData(); render(); showToast(`Word count updated ${fmtNum(res.old)} → ${fmtNum(res.new)}`, 'success'); }
      else if (res && res.ok) { showToast('Already up to date ✓', 'success'); btn.textContent = '↻'; btn.disabled = false; }
      else if (res && res.needsLogin) { showToast('🔒 Locked work — use “🔑 AO3 login” (top bar), then retry.', 'info'); btn.textContent = '↻'; btn.disabled = false; }
      else { showToast('Couldn’t refresh — check the link', 'error'); btn.textContent = '↻'; btn.disabled = false; }
    });
  });
  document.querySelectorAll('#myspace-page [data-ms-drop]').forEach(zone => {
    zone.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; zone.classList.add('ms-drop-over'); });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('ms-drop-over'); });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('ms-drop-over');
      const id = _msDrag || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      _msDrag = null;
      if (id) moveMsCard(id, zone.dataset.msDrop);
    });
  });

  // Folder search & sort
  const folderSearchEl = document.getElementById('folder-search');
  if (folderSearchEl) {
    folderSearchEl.addEventListener('input', e => {
      state.folderSearch = e.target.value;
      render();
      const newEl = document.getElementById('folder-search');
      if (newEl) { newEl.focus(); newEl.setSelectionRange(e.target.selectionStart, e.target.selectionStart); }
    });
  }
  const folderSortEl = document.getElementById('folder-sort');
  if (folderSortEl) folderSortEl.addEventListener('change', e => { state.folderSortBy = e.target.value; render(); });

  // In-folder status / favourite / one-shot filters
  document.querySelectorAll('[data-folder-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.folderFilter;
      state.folderItemFilter = state.folderItemFilter === k ? null : k;
      render();
    });
  });

  // Folder navigation (reset search + item filter on navigate)
  document.querySelectorAll('[data-folder-nav]').forEach(el => {
    el.addEventListener('click', () => {
      state.folderPath = JSON.parse(el.dataset.folderNav);
      state.folderSearch = '';
      state.folderItemFilter = null;
      render();
    });
  });
  document.querySelectorAll('[data-folder-go]').forEach(el => {
    el.addEventListener('click', () => {
      state.folderPath = JSON.parse(el.dataset.folderGo);
      state.folderSearch = '';
      state.folderItemFilter = null;
      render();
    });
  });

  // Folder edit button
  document.querySelectorAll('.fc-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.editingFolder = btn.dataset.editFolder;
      render();
    });
  });

  // Drag one folder onto another to nest them together, iOS home-screen style.
  {
    let dragKey = null;
    const draggables = document.querySelectorAll('.folder-card[draggable="true"]');
    draggables.forEach(el => {
      el.addEventListener('dragstart', e => {
        dragKey = el.dataset.dragKey;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragKey);
        el.classList.add('fc-dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('fc-dragging');
        draggables.forEach(x => x.classList.remove('fc-drop-hover'));
        dragKey = null;
      });
      el.addEventListener('dragover', e => {
        if (!dragKey || dragKey === el.dataset.dragKey) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('fc-drop-hover');
      });
      el.addEventListener('dragleave', () => el.classList.remove('fc-drop-hover'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('fc-drop-hover');
        const sourceKey = dragKey || e.dataTransfer.getData('text/plain');
        mergeFoldersIntoGroup(sourceKey, el.dataset.dragKey);
      });
    });
  }

  // Folder edit modal
  const febClose = document.getElementById('fem-close');
  const febCancel = document.getElementById('fem-cancel');
  const febSave = document.getElementById('fem-save');
  const febBackdrop = document.getElementById('folder-edit-backdrop');
  if (febClose) febClose.addEventListener('click', () => { state.editingFolder = null; render(); });
  if (febCancel) febCancel.addEventListener('click', () => { state.editingFolder = null; render(); });
  if (febBackdrop) febBackdrop.addEventListener('click', e => { if (e.target === febBackdrop) { state.editingFolder = null; render(); } });
  const femIcon = document.getElementById('fem-icon');
  if (femIcon) {
    femIcon.addEventListener('input', e => {
      const val = e.target.value.trim();
      const preview = document.getElementById('fem-preview-icon');
      if (!preview) return;
      const isUrl = val.startsWith('http');
      preview.innerHTML = isUrl
        ? `<img src="${val}" style="width:100%;height:100%;object-fit:cover;border-radius:12px" />`
        : `<span style="font-size:38px;line-height:1">${val || '📁'}</span>`;
    });
  }
  if (febSave) {
    febSave.addEventListener('click', () => {
      const key = state.editingFolder;
      if (!key) return;
      const name = document.getElementById('fem-name')?.value.trim();
      const icon = document.getElementById('fem-icon')?.value.trim();
      const pinned = document.getElementById('fem-pin')?.checked || false;
      const existing = state.folderConfig[key] || {};
      pushFolderUndo();
      state.folderConfig[key] = { ...existing };
      if (name) state.folderConfig[key].displayName = name;
      else delete state.folderConfig[key].displayName;
      if (icon) state.folderConfig[key].icon = icon;
      else delete state.folderConfig[key].icon;
      state.folderConfig[key].pinned = pinned;
      const sectionVal = document.getElementById('fem-section')?.value || '';
      if (sectionVal) state.folderConfig[key].section = sectionVal;
      else delete state.folderConfig[key].section;
      if (!name && !icon && !pinned && !sectionVal && !existing.isCustom && !existing.filterTag) delete state.folderConfig[key];
      else state.folderConfig[key]._modAt = new Date().toISOString();  // stamp so the change syncs to phone
      saveFolderConfig();
      state.editingFolder = null;
      render();
    });
  }
  const febDelete = document.getElementById('fem-delete');
  if (febDelete) {
    febDelete.addEventListener('click', () => {
      const key = state.editingFolder;
      if (!key) return;
      if (!confirm('Delete this folder? The items inside keep their tags — only this custom folder is removed.')) return;
      pushFolderUndo();
      delete state.folderConfig[key];
      saveFolderConfig();
      state.editingFolder = null;
      render();
    });
  }

  // Add folder card
  document.querySelectorAll('[data-add-folder]').forEach(el => {
    el.addEventListener('click', () => {
      state.creatingFolderIn = JSON.parse(el.dataset.addFolder);
      render();
    });
  });

  // Create folder modal
  const fcmClose = document.getElementById('fcm-close');
  const fcmCancel = document.getElementById('fcm-cancel');
  const fcmSave = document.getElementById('fcm-save');
  const fcmBackdrop = document.getElementById('folder-create-backdrop');
  if (fcmClose) fcmClose.addEventListener('click', () => { state.creatingFolderIn = null; render(); });
  if (fcmCancel) fcmCancel.addEventListener('click', () => { state.creatingFolderIn = null; render(); });
  if (fcmBackdrop) fcmBackdrop.addEventListener('click', e => { if (e.target === fcmBackdrop) { state.creatingFolderIn = null; render(); } });
  if (fcmSave) {
    fcmSave.addEventListener('click', () => {
      const parentPath = state.creatingFolderIn;
      if (!parentPath) return;
      const name = document.getElementById('fcm-name')?.value.trim();
      const icon = document.getElementById('fcm-icon')?.value.trim();
      const filterTag = document.getElementById('fcm-tag')?.value?.trim() || null;
      if (!name) return;
      const id = 'custom_' + Date.now();
      const newPath = [...parentPath, id];
      const key = newPath.join('|');
      pushFolderUndo();
      state.folderConfig[key] = { displayName: name, isCustom: true, _modAt: new Date().toISOString() };
      if (icon) state.folderConfig[key].icon = icon;
      if (filterTag) state.folderConfig[key].filterTag = filterTag;
      saveFolderConfig();
      state.creatingFolderIn = null;
      render();
    });
  }

  // Item icon (cover) edit
  document.querySelectorAll('.cover-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      state.editingItemIcon = btn.dataset.editItemIcon;
      render();
    });
  });
  const iimClose = document.getElementById('iim-close');
  const iimCancel = document.getElementById('iim-cancel');
  const iimSave = document.getElementById('iim-save');
  const iimClear = document.getElementById('iim-clear');
  const iimBackdrop = document.getElementById('item-icon-backdrop');
  if (iimClose) iimClose.addEventListener('click', () => { state.editingItemIcon = null; render(); });
  if (iimCancel) iimCancel.addEventListener('click', () => { state.editingItemIcon = null; render(); });
  if (iimBackdrop) iimBackdrop.addEventListener('click', e => { if (e.target === iimBackdrop) { state.editingItemIcon = null; render(); } });
  const iimIconEl = document.getElementById('iim-icon');
  if (iimIconEl) {
    iimIconEl.addEventListener('input', e => {
      const val = e.target.value.trim();
      const preview = document.getElementById('iim-preview-icon');
      if (!preview) return;
      const isUrl = val.startsWith('http');
      const item = state.items.find(x => x.id === state.editingItemIcon);
      const isFf = item?.type === 'ff';
      preview.innerHTML = isUrl
        ? `<img src="${val}" style="width:100%;height:100%;object-fit:cover;border-radius:10px" />`
        : `<span style="font-size:38px;line-height:1">${val || (isFf?'✍️':'📚')}</span>`;
    });
  }
  if (iimClear) {
    iimClear.addEventListener('click', () => {
      const id = state.editingItemIcon;
      if (!id) return;
      state.items = state.items.map(x => x.id === id ? { ...x, coverIcon: undefined, _modAt: new Date().toISOString() } : x);
      saveData(); state.editingItemIcon = null; render();
    });
  }
  if (iimSave) {
    iimSave.addEventListener('click', () => {
      const id = state.editingItemIcon;
      if (!id) return;
      const icon = document.getElementById('iim-icon')?.value.trim();
      state.items = state.items.map(x => x.id === id ? { ...x, coverIcon: icon || undefined, _modAt: new Date().toISOString() } : x);
      saveData(); state.editingItemIcon = null; render();
    });
  }

  // Stats tabs / period / metric
  document.querySelectorAll('[data-scat]').forEach(el => {
    el.addEventListener('click', () => { state.statsCategory = el.dataset.scat; render(); });
  });
  document.querySelectorAll('[data-speriod]').forEach(el => {
    el.addEventListener('click', () => { state.statsPeriod = el.dataset.speriod; render(); });
  });
  document.querySelectorAll('[data-smetric]').forEach(el => {
    el.addEventListener('click', () => { state.statsMetric = el.dataset.smetric; render(); });
  });

  // Add button
  const addBtn = document.getElementById('btn-add');
  if (addBtn) addBtn.addEventListener('click', () => { state.editItem = null; state.modalOpen = true; render(); });

  // Export
  const expBtn = document.getElementById('btn-export');
  if (expBtn) expBtn.addEventListener('click', exportToExcel);

  // Data folder
  const dfBtn = document.getElementById('btn-data-folder');
  if (dfBtn) dfBtn.addEventListener('click', () => window.api.openDataFolder());

  document.getElementById('btn-ao3-login')?.addEventListener('click', async () => {
    showToast('Opening AO3 login — sign in, then close that window.', 'loading');
    try {
      await window.api.ao3Login();
      const ok = window.api.ao3LoggedIn ? await window.api.ao3LoggedIn() : true;
      showToast(ok ? 'AO3 connected ✓ — locked works can now be fetched. Try Auto-fill / ↻ again.' : 'AO3 window closed — if you signed in, try fetching again.', ok ? 'success' : 'info');
    } catch (e) { showToast('AO3 login failed: ' + e.message, 'error'); }
  });

  // Refresh only the word count (+ kudos) in the edit form from the link.
  const refreshWordsBtn = document.getElementById('btn-refresh-words');
  if (refreshWordsBtn) {
    refreshWordsBtn.addEventListener('click', async () => {
      const url = (document.getElementById('m-url')?.value?.trim() || '').replace('archive.transformativeworks.org', 'archiveofourown.org');
      const isAO3 = url.includes('archiveofourown'), isFFNet = url.includes('fanfiction.net');
      if (!url || (!isAO3 && !isFFNet)) { showToast('Add the AO3 / FF.net link first.', 'error'); return; }
      refreshWordsBtn.disabled = true; refreshWordsBtn.textContent = '…';
      try {
        const data = isAO3 ? await window.api.fetchAO3(url) : await window.api.fetchFFNet(url);
        if (data && data.needsLogin) showToast(data.error, 'info');
        else if (data && !data.error && data.words) {
          const wEl = document.getElementById('m-words'); const old = parseInt(wEl.value) || 0;
          wEl.value = data.words;
          const hEl = document.getElementById('m-hearts'); if (data.hearts && hEl) hEl.value = data.hearts;
          showToast(old && old !== data.words ? `Word count ${fmtNum(old)} → ${fmtNum(data.words)} — remember to Save` : 'Word count already up to date ✓', 'success');
        } else showToast('Couldn’t refresh — check the link.', 'error');
      } catch (e) { showToast('Couldn’t refresh — check the link.', 'error'); }
      refreshWordsBtn.disabled = false; refreshWordsBtn.textContent = '↻';
    });
  }

  // GitHub sync + backup
  const syncBtn = document.getElementById('btn-sync');
  if (syncBtn) syncBtn.addEventListener('click', handleSync);
  const backupBtn = document.getElementById('btn-backup');
  if (backupBtn) backupBtn.addEventListener('click', handleBackup);

  // Stat pills
  document.querySelectorAll('[data-stat]').forEach(el => {
    el.addEventListener('click', () => {
      const s = el.dataset.stat;
      state.filterStatus = state.filterStatus === s ? 'all' : s;
      render();
    });
  });

  // Favorites filter pill
  document.querySelectorAll('[data-fav-filter]').forEach(el => {
    el.addEventListener('click', () => { state.filterFavorite = !state.filterFavorite; render(); });
  });

  // Favorite toggle on card
  document.querySelectorAll('[data-toggle-fav]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const id = el.dataset.toggleFav;
      state.items = state.items.map(x => x.id === id ? { ...x, favorite: !x.favorite, _modAt: new Date().toISOString() } : x);
      saveData(); render();
    });
  });

  // Filter pills
  document.querySelectorAll('[data-type]').forEach(el => {
    el.addEventListener('click', () => {
      state.filterType = el.dataset.type;
      state.filterFandom = 'all';
      state.filterSection = 'all';
      state.filterGenre = 'all';
      state.filterTag = 'all';
      render();
    });
  });
  document.querySelectorAll('[data-fandom]').forEach(el => {
    el.addEventListener('click', () => {
      const f = el.dataset.fandom;
      state.filterFandom = state.filterFandom === f ? 'all' : f;
      state.filterTag = 'all';
      render();
    });
  });
  const tagFilterEl = document.getElementById('tag-filter-select');
  if (tagFilterEl) tagFilterEl.addEventListener('change', e => { state.filterTag = e.target.value; render(); });
  document.querySelectorAll('[data-section]').forEach(el => {
    el.addEventListener('click', () => {
      const s = el.dataset.section;
      state.filterSection = state.filterSection === s ? 'all' : s;
      render();
    });
  });
  document.querySelectorAll('[data-genre]').forEach(el => {
    el.addEventListener('click', () => {
      const g = el.dataset.genre;
      state.filterGenre = state.filterGenre === g ? 'all' : g;
      render();
    });
  });

  // Card expand
  document.querySelectorAll('[data-expand]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.expand;
      state.expandedId = state.expandedId === id ? null : id;
      render();
    });
  });

  // Edit
  document.querySelectorAll('[data-edit]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const item = state.items.find(x => x.id === el.dataset.edit);
      if (item) { state.editItem = { ...item }; state.modalOpen = true; render(); }
    });
  });

  // Delete
  document.querySelectorAll('[data-delete]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      if (confirm('Remove this entry?')) {
        const id = el.dataset.delete;
        state.items = state.items.filter(x => x.id !== id);
        state.deletedIds = { ...state.deletedIds, [id]: new Date().toISOString() };
        saveData(); render();
      }
    });
  });

  // Open URL
  document.querySelectorAll('[data-open-url]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      window.api.openExternal(el.dataset.openUrl);
    });
  });

  // Refresh word count from the link (list & folder cards)
  document.querySelectorAll('[data-refresh-words]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const item = state.items.find(x => x.id === btn.dataset.refreshWords);
      if (!item) return;
      btn.textContent = '…'; btn.disabled = true;
      showToast('Refreshing word count…', 'loading');
      const res = await refreshWordCount(item);
      if (res && res.ok && res.new !== res.old) { saveData(); render(); showToast(`${item.title || 'Fic'}: ${fmtNum(res.old)} → ${fmtNum(res.new)} words`, 'success'); }
      else if (res && res.ok) { showToast('Word count already up to date ✓', 'success'); btn.textContent = '↻'; btn.disabled = false; }
      else if (res && res.needsLogin) { showToast('🔒 Locked work — use “🔑 AO3 login” (top bar), then retry.', 'info'); btn.textContent = '↻'; btn.disabled = false; }
      else { showToast('Couldn’t refresh — check the link.', 'error'); btn.textContent = '↻'; btn.disabled = false; }
    });
  });

  // Status change in expanded card
  document.querySelectorAll('[data-set-status]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const id = el.dataset.id;
      const status = el.dataset.setStatus;
      state.items = state.items.map(x => {
        if (x.id !== id) return x;
        const update = { ...x, status, _modAt: new Date().toISOString() };
        if (status === 'Finished' && !x.finishedAt) update.finishedAt = new Date().toISOString();
        if (status === 'Finished' && !(x.readCount > 0)) update.readCount = 1;
        return update;
      });
      saveData(); render();
    });
  });

  // Re-read count stepper (＋ / －)
  document.querySelectorAll('[data-reread-delta]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.rereadId;
      const delta = parseInt(btn.dataset.rereadDelta, 10);
      state.items = state.items.map(x => {
        if (x.id !== id) return x;
        const dates = ensureReadDates(x);
        if (delta > 0) dates.push(new Date().toISOString());  // record "I re-read this" with today's date
        else dates.pop();                                     // remove the most recent read
        return { ...x, readDates: dates, readCount: dates.length, _modAt: new Date().toISOString() };
      });
      saveData(); render();
    });
  });

  // Inline star rating (expanded card)
  document.querySelectorAll('.stars:not(.readonly) .star').forEach(star => {
    star.addEventListener('click', e => {
      e.stopPropagation();
      const val = parseInt(star.dataset.val);
      const id = star.dataset.id;
      state.items = state.items.map(x => {
        if (x.id !== id) return x;
        return { ...x, userRating: x.userRating === val ? 0 : val, _modAt: new Date().toISOString() };
      });
      saveData(); render();
    });
    star.addEventListener('mouseenter', () => {
      const val = parseInt(star.dataset.val);
      star.closest('.stars').querySelectorAll('.star').forEach((s,i) => {
        s.classList.toggle('lit', i < val);
      });
    });
    star.addEventListener('mouseleave', () => {
      const id = star.dataset.id;
      const item = state.items.find(x => x.id === id);
      if (item) {
        star.closest('.stars').querySelectorAll('.star').forEach((s,i) => {
          s.classList.toggle('lit', i < (item.userRating||0));
        });
      }
    });
  });

  // ── Settings: per-page banner customization (bound on every render) ──
  document.getElementById('btn-settings')?.addEventListener('click', () => { state.settingsOpen = true; render(); });
  const closeSettings = () => { state.settingsOpen = false; render(); };
  document.getElementById('settings-close')?.addEventListener('click', closeSettings);
  document.getElementById('settings-done')?.addEventListener('click', closeSettings);
  const sb = document.getElementById('settings-backdrop');
  if (sb) sb.addEventListener('click', e => { if (e.target === sb) closeSettings(); });
  // live text edit (no re-render, keeps focus)
  document.querySelectorAll('.banner-in').forEach(inp => {
    inp.addEventListener('input', () => {
      const key = inp.dataset.banner;
      state.bannerConfig[key] = inp.value.trim();
      saveBannerConfig();
      const prevEl = document.querySelector(`[data-banner-prev="${key}"]`);
      if (prevEl) prevEl.style.background = resolveBanner(inp.value) || '#7d9d6a';
      if (key === currentPageKey()) applyBanner();
    });
  });
  document.querySelectorAll('[data-banner-set]').forEach(sw => {
    sw.addEventListener('click', () => {
      const [key, color] = sw.dataset.bannerSet.split('|');
      state.bannerConfig[key] = color; saveBannerConfig(); render();
    });
  });
  document.querySelectorAll('[data-banner-reset]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.bannerConfig[btn.dataset.bannerReset] = ''; saveBannerConfig(); render();
    });
  });
  applyBanner();

  // ── Modal events ────────────────────────────────────────────────────────────
  if (!state.modalOpen) return;

  const close = () => { state.modalOpen = false; state.editItem = null; render(); };
  document.getElementById('modal-close')?.addEventListener('click', close);
  document.getElementById('modal-cancel')?.addEventListener('click', close);
  document.getElementById('modal-backdrop')?.addEventListener('click', e => {
    if (e.target.id === 'modal-backdrop') close();
  });

  // Type toggle
  document.querySelectorAll('[data-type-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      snapshotModalForm();
      state.editItem = { ...(state.editItem||{}), type: btn.dataset.typeBtn };
      render();
    });
  });

  // One-shot toggle
  document.querySelectorAll('[data-oneshot-btn]').forEach(btn => {
    btn.addEventListener('click', () => {
      snapshotModalForm();
      state.editItem = { ...(state.editItem||{}), oneshot: btn.dataset.oneshotBtn === 'true' };
      render();
    });
  });

  // Marking Finished should visibly default Times Read to 1 right away, rather than leaving
  // a stale 0 sitting in the field until Save silently corrects it behind the scenes.
  const statusSelectEl = document.getElementById('m-status');
  if (statusSelectEl) {
    statusSelectEl.addEventListener('change', () => {
      if (statusSelectEl.value !== 'Finished') return;
      const rcInput = document.getElementById('m-readcount');
      if (rcInput && (!rcInput.value || parseInt(rcInput.value) < 1)) rcInput.value = '1';
      const finishedInput = document.getElementById('m-finished');
      if (finishedInput && !finishedInput.value) finishedInput.value = new Date().toISOString().slice(0, 10);
    });
  }

  // Star picker in modal
  let modalRating = state.editItem?.userRating || 0;
  const pickerEl = document.getElementById('star-picker');
  if (pickerEl) {
    pickerEl.querySelectorAll('span').forEach(star => {
      star.addEventListener('mouseenter', () => {
        const v = parseInt(star.dataset.pick);
        pickerEl.querySelectorAll('span').forEach((s,i) => s.classList.toggle('lit', i<v));
      });
      star.addEventListener('mouseleave', () => {
        pickerEl.querySelectorAll('span').forEach((s,i) => s.classList.toggle('lit', i<modalRating));
      });
      star.addEventListener('click', () => {
        const v = parseInt(star.dataset.pick);
        modalRating = modalRating === v ? 0 : v;
        pickerEl.querySelectorAll('span').forEach((s,i) => s.classList.toggle('lit', i<modalRating));
      });
    });
  }

  // Tag remove in modal
  document.querySelectorAll('#tags-display .tag-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      snapshotModalForm();
      state.editItem = { ...(state.editItem||{}), tags: (state.editItem?.tags||[]).filter(t=>t!==tag) };
      render();
    });
  });

  // Tag add (with autocomplete from existing tags)
  const tagInput = document.getElementById('m-tag-input');
  const sugEl = document.getElementById('tag-suggest');
  const allTags = [...new Set(state.items.flatMap(x => x.tags || []))].sort((a, b) => a.localeCompare(b));
  const addTagValue = (t) => {
    t = (t || '').trim();
    if (!t) return;
    const existing = state.editItem?.tags || [];
    if (!existing.includes(t)) {
      snapshotModalForm();
      state.editItem = { ...(state.editItem||{}), tags: [...existing, t] };
      render();
    } else if (tagInput) { tagInput.value = ''; }
  };
  const addTag = () => addTagValue(tagInput?.value);
  const renderSug = () => {
    if (!sugEl || !tagInput) return;
    const q = tagInput.value.trim().toLowerCase();
    const cur = state.editItem?.tags || [];
    const matches = q ? allTags.filter(t => !cur.includes(t) && t.toLowerCase().includes(q)).slice(0, 8) : [];
    if (!matches.length) { sugEl.style.display = 'none'; return; }
    sugEl.innerHTML = matches.map(t => `<div class="tag-sug" data-t="${t.replace(/"/g,'&quot;')}">${t}</div>`).join('');
    sugEl.style.display = 'block';
    sugEl.querySelectorAll('.tag-sug').forEach(el => el.addEventListener('mousedown', e => { e.preventDefault(); addTagValue(el.dataset.t); }));
  };
  tagInput?.addEventListener('input', renderSug);
  tagInput?.addEventListener('keydown', e => e.key==='Enter' && addTag());
  document.getElementById('btn-add-tag')?.addEventListener('click', addTag);

  // Autocomplete dropdowns for Fandom / Author / Title (reuse existing values)
  const distinctVals = key => [...new Set(state.items.map(x => (x[key]||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const attachAutocomplete = (inputId, sugId, values) => {
    const inp = document.getElementById(inputId), sug = document.getElementById(sugId);
    if (!inp || !sug) return;
    const showMatches = () => {
      const q = inp.value.trim().toLowerCase();
      const matches = q ? values.filter(v => v.toLowerCase().includes(q) && v.toLowerCase() !== q).slice(0, 8) : [];
      if (!matches.length) { sug.style.display = 'none'; return; }
      sug.innerHTML = matches.map(v => `<div class="tag-sug" data-v="${esc(v).replace(/"/g,'&quot;')}">${esc(v)}</div>`).join('');
      sug.style.display = 'block';
      sug.querySelectorAll('.tag-sug').forEach(el => el.addEventListener('mousedown', e => { e.preventDefault(); inp.value = el.dataset.v; sug.style.display = 'none'; }));
    };
    inp.addEventListener('input', showMatches);
    inp.addEventListener('focus', showMatches);
    inp.addEventListener('blur', () => setTimeout(() => { sug.style.display = 'none'; }, 150));
  };
  attachAutocomplete('m-fandom', 'sug-fandom', distinctVals('fandom'));
  attachAutocomplete('m-author', 'sug-author', distinctVals('author'));
  attachAutocomplete('m-title',  'sug-title',  distinctVals('title'));
  // Pairing suggestions pool both past Pairing values (M/M, F/F…) and ship-name tags already in use.
  const shipTagPool = [...new Set(state.items.flatMap(x => x.tags || []).filter(isShipPairing))];
  attachAutocomplete('m-pairing', 'sug-pairing', [...new Set([...distinctVals('pairing'), ...shipTagPool])].sort((a,b)=>a.localeCompare(b)));

  // Duplicate title warning (live, on blur)
  const titleEl = document.getElementById('m-title');
  const dupeWarnEl = document.getElementById('dupe-warning');
  if (titleEl && dupeWarnEl && !state.editItem?.id) {
    titleEl.addEventListener('blur', () => {
      const t = titleEl.value.trim().toLowerCase();
      if (!t) { dupeWarnEl.textContent = ''; return; }
      const dupe = state.items.find(x => x.title.toLowerCase().trim() === t);
      dupeWarnEl.textContent = dupe
        ? `⚠️ Already in library: "${dupe.title}" (${dupe.type === 'ff' ? 'FF' : 'Book'}, ${dupe.status})`
        : '';
    });
  }

  // Book auto-fill (Google Books)
  const bookFetchBtn = document.getElementById('btn-book-fetch');
  if (bookFetchBtn) {
    bookFetchBtn.addEventListener('click', async () => {
      const query = document.getElementById('m-title')?.value?.trim();
      if (!query) return;
      const msgEl = document.getElementById('book-fetch-msg');
      if (msgEl) { msgEl.textContent = 'Searching…'; msgEl.className = 'fetch-msg'; }
      bookFetchBtn.disabled = true; bookFetchBtn.textContent = '…';
      try {
        const data = await window.api.fetchBook(query);
        if (data.error) throw new Error(data.error);
        if (data.title)  { const el = document.getElementById('m-title');  if (el) el.value = data.title; }
        if (data.author) { const el = document.getElementById('m-author'); if (el) el.value = data.author; }
        if (data.pages)  { const el = document.getElementById('m-pages');  if (el) el.value = data.pages; }
        if (data.genre)  { const el = document.getElementById('m-genre');  if (el) el.value = data.genre; }
        if (msgEl) { msgEl.textContent = '✓ Details filled in — check and adjust!'; msgEl.className = 'fetch-msg ok'; }
      } catch(e) {
        if (msgEl) { msgEl.textContent = 'Not found — fill in manually.'; msgEl.className = 'fetch-msg err'; }
      }
      bookFetchBtn.disabled = false; bookFetchBtn.textContent = 'Auto-fill ✦';
    });
  }

  // AO3 / FF.net fetch
  const fetchBtn = document.getElementById('btn-fetch');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      const url = (document.getElementById('m-url')?.value?.trim() || '').replace('archive.transformativeworks.org', 'archiveofourown.org');
      const msgEl = document.getElementById('fetch-msg');
      if (!url) {
        if (msgEl) { msgEl.textContent = 'Paste a fic URL in the field above first.'; msgEl.className = 'fetch-msg err'; }
        return;
      }
      const isAO3 = url.includes('archiveofourown');
      const isFFNet = url.includes('fanfiction.net');
      if (!isAO3 && !isFFNet) {
        if (msgEl) { msgEl.textContent = 'URL must be from archiveofourown.org or fanfiction.net'; msgEl.className = 'fetch-msg err'; }
        return;
      }
      if (msgEl) { msgEl.textContent = `Fetching from ${isAO3 ? 'AO3' : 'FF.net'}…`; msgEl.className='fetch-msg'; }
      fetchBtn.disabled = true; fetchBtn.textContent = '…';
      try {
        const data = isAO3 ? await window.api.fetchAO3(url) : await window.api.fetchFFNet(url);
        if (data && data.needsLogin) {
          if (msgEl) { msgEl.innerHTML = '🔒 Locked work — click <b>🔑 AO3</b> in the top bar to log in, then Auto-fill again.'; msgEl.className = 'fetch-msg err'; }
          fetchBtn.disabled = false; fetchBtn.textContent = 'Auto-fill ✦';
          return;
        }
        if (data.error) throw new Error(data.error);
        state.editItem = {
          ...(state.editItem||{}),
          title: data.title || state.editItem?.title || '',
          author: data.author || state.editItem?.author || '',
          fandom: data.fandom || state.editItem?.fandom || '',
          words: data.words || state.editItem?.words || '',
          hearts: data.hearts || state.editItem?.hearts || '',
          rating: data.rating || state.editItem?.rating || '',
          pairing: data.pairing || state.editItem?.pairing || '',
          tags: data.tags?.length ? data.tags : (state.editItem?.tags || []),
          url,
        };
        render();
        const newMsgEl = document.getElementById('fetch-msg');
        if (newMsgEl) { newMsgEl.textContent = '✓ Details fetched!'; newMsgEl.className = 'fetch-msg ok'; }
      } catch(e) {
        if (msgEl) { msgEl.textContent = 'Could not fetch — fill in manually.'; msgEl.className='fetch-msg err'; }
        fetchBtn.disabled = false; fetchBtn.textContent = 'Auto-fill ✦';
      }
    });
  }

  // Submit
  document.getElementById('modal-submit')?.addEventListener('click', () => {
    const title = document.getElementById('m-title')?.value?.trim();
    if (!title) { alert('Title is required.'); return; }
    if (!state.editItem?.id) {
      const dupe = state.items.find(x => x.title.toLowerCase().trim() === title.toLowerCase().trim());
      if (dupe) {
        if (!confirm(`"${title}" is already in your library (${dupe.type === 'ff' ? 'fanfiction' : 'book'}, ${dupe.status}). Add it anyway?`)) return;
      }
    }

    const type = state.editItem?.type || 'ff';
    const isFf = type === 'ff';
    const words = document.getElementById('m-words')?.value;
    const hearts = document.getElementById('m-hearts')?.value;
    const pages = document.getElementById('m-pages')?.value;

    const status = document.getElementById('m-status')?.value || 'TBR';

    const finishedAt = (() => {
      const d = document.getElementById('m-finished')?.value;
      if (d) return new Date(d + 'T12:00:00').toISOString();
      if (status === 'Finished' && !state.editItem?.finishedAt) return new Date().toISOString();
      return state.editItem?.finishedAt || null;
    })();

    // Finished always means "read at least once" — trust an explicit higher count, but
    // never let a stale/untouched Times-Read field (still showing its pre-Finished default) win.
    const readCount = (() => {
      const rc = document.getElementById('m-readcount')?.value;
      let n = (rc !== null && rc !== undefined && rc !== '') ? (parseInt(rc) || 0) : (state.editItem?.readCount || 0);
      if (status === 'Finished' && n < 1) n = 1;
      return n;
    })();

    // Keep readDates in lockstep with readCount — timesRead()/stats trust readDates.length
    // first, so letting it drift out of sync (e.g. a stale empty array) hides finished reads.
    const readDates = (() => {
      const existing = Array.isArray(state.editItem?.readDates) ? state.editItem.readDates.slice() : [];
      if (readCount > existing.length) { while (existing.length < readCount) existing.push(finishedAt); }
      else existing.length = readCount;
      return existing;
    })();

    const pairing = isFf ? (document.getElementById('m-pairing')?.value?.trim() || '') : '';

    // A ship typed into Pairing (e.g. "Harry/Ginny") also becomes a tag, so it gets its own folder.
    const tags = (() => {
      const base = state.editItem?.tags || [];
      if (!pairing) return base;
      const shipTags = pairing.split(',').map(s => s.trim()).filter(isShipPairing);
      if (!shipTags.length) return base;
      return [...new Set([...base, ...shipTags])];
    })();

    const item = {
      ...(state.editItem||{}),
      id: state.editItem?.id || genId(),
      type,
      title,
      author: document.getElementById('m-author')?.value?.trim() || '',
      fandom: isFf ? (document.getElementById('m-fandom')?.value?.trim() || '') : '',
      genre: !isFf ? (document.getElementById('m-genre')?.value?.trim() || '') : '',
      section: !isFf ? (document.getElementById('m-section')?.value?.trim() || state.editItem?.section || '') : '',
      pairing,
      rating: isFf ? (document.getElementById('m-rating')?.value || '') : '',
      status,
      words: words ? parseInt(words) : null,
      hearts: hearts ? parseInt(hearts) : null,
      pages: pages ? parseInt(pages) : null,
      userRating: modalRating,
      notes: document.getElementById('m-notes')?.value?.trim() || '',
      tags,
      url: document.getElementById('m-url')?.value?.trim() || state.editItem?.url || '',
      oneshot: isFf ? (state.editItem?.oneshot || false) : undefined,
      finishedAt,
      readCount,
      readDates,
      _addedAt: state.editItem?._addedAt ?? state.items.length,
      _modAt: new Date().toISOString(),
    };

    const idx = state.items.findIndex(x => x.id === item.id);
    if (idx >= 0) state.items[idx] = item;
    else state.items.unshift(item);

    state.modalOpen = false; state.editItem = null;
    saveData(); render();
  });
}

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  // Remove any existing toast
  document.getElementById('toast')?.remove();

  const colors = {
    info:    { bg: '#1e1e3c', color: '#fff' },
    success: { bg: '#065f46', color: '#fff' },
    error:   { bg: '#7f1d1d', color: '#fff' },
    loading: { bg: '#1e1e3c', color: '#fff' },
  };
  const c = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.innerHTML = `
    <span style="font-size:16px">${type === 'loading' ? '⏳' : type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <span>${message}</span>
  `;
  Object.assign(toast.style, {
    position: 'fixed', bottom: '28px', left: '50%', transform: 'translateX(-50%)',
    background: c.bg, color: c.color, padding: '12px 22px', borderRadius: '12px',
    fontSize: '14px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '10px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.25)', zIndex: '9999',
    animation: 'fadeInUp 0.2s ease', whiteSpace: 'nowrap',
  });

  // Add animation keyframes once
  if (!document.getElementById('toast-style')) {
    const style = document.createElement('style');
    style.id = 'toast-style';
    style.textContent = `@keyframes fadeInUp { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);
  if (type !== 'loading') setTimeout(() => toast.remove(), 4000);
  return toast;
}

// ── GitHub backup ─────────────────────────────────────────────────────────────
// Sync = pull only. Back up = push only. They used to be entangled (Back up silently pulled
// and merged first), which meant deleting something and then backing up could resurrect it —
// the pull-in-merge only knows an id is "missing", not "deleted on purpose".
async function handleSync() {
  showToast('Getting the latest from GitHub…', 'loading');
  try {
    const res = await window.api.pullData();
    document.getElementById('toast')?.remove();
    if (!res || !res.ok) { showToast('Sync failed: ' + ((res && res.error) || 'no connection'), 'error'); return; }
    if (res.data) {
      const merged = mergeLibrary(state.items, state.folderConfig, res.data.items, res.data.folderConfig, state.deletedIds, res.data.deletedIds);
      // Safety: never lose data for any reason other than an explicit, tracked deletion.
      if (merged.items.length >= Math.max(state.items.length, (res.data.items||[]).length) - merged.removedByTombstone) {
        state.items = merged.items;
        state.folderConfig = merged.folderConfig;
        state.deletedIds = merged.deletedIds;
        localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig));
        await saveData();
      }
    }
    render();
    showToast('Synced ✓ — up to date', 'success');
  } catch(e) {
    document.getElementById('toast')?.remove();
    showToast('Sync failed: ' + e.message, 'error');
  }
}

async function handleBackup() {
  const btn = document.getElementById('btn-backup');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Backing up…'; }
  showToast('Saving to GitHub…', 'loading');

  try {
    const result = await window.api.gitBackup();
    document.getElementById('toast')?.remove();
    if (result.ok) {
      showToast(result.message, 'success');
      if (btn) { btn.disabled = false; btn.innerHTML = '☁️ Back up'; }
    } else {
      showToast(result.error, 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '☁️ Back up'; }
    }
  } catch(e) {
    document.getElementById('toast')?.remove();
    showToast('Backup failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '☁️ Back up'; }
  }
}

// ── Excel export ──────────────────────────────────────────────────────────────
async function exportToExcel() {
  const filePath = await window.api.exportPath();
  if (!filePath) return;

  // Build CSV as fallback if xlsx not available, then convert
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();

  // FF sheet
  const ffSheet = wb.addWorksheet('Fanfiction');
  ffSheet.columns = [
    {header:'#', width:5}, {header:'Title', width:50}, {header:'Author', width:25},
    {header:'Fandom', width:20}, {header:'Words', width:12}, {header:'Hearts', width:12},
    {header:'Rating', width:12}, {header:'Pairing', width:12},
    {header:'Status', width:12}, {header:'My Rating', width:12}, {header:'Notes', width:30},
  ];
  const ffItems = state.items.filter(x => x.type === 'ff');
  ffItems.forEach((item, i) => {
    ffSheet.addRow([i+1, item.title, item.author, item.fandom, item.words, item.hearts,
      item.rating, item.pairing, item.status, item.userRating ? '★'.repeat(item.userRating) : '', item.notes]);
  });
  ffSheet.getRow(1).font = { bold: true };

  // Books sheet
  const bkSheet = wb.addWorksheet('Books');
  bkSheet.columns = [
    {header:'#', width:5}, {header:'Title', width:55}, {header:'Author', width:25},
    {header:'Genre', width:30}, {header:'Section', width:20}, {header:'Pages', width:10},
    {header:'Words', width:12}, {header:'Status', width:12},
    {header:'My Rating', width:12}, {header:'Notes', width:30},
  ];
  const bkItems = state.items.filter(x => x.type === 'book');
  bkItems.forEach((item, i) => {
    bkSheet.addRow([i+1, item.title, item.author, item.genre, item.section,
      item.pages, item.words, item.status, item.userRating ? '★'.repeat(item.userRating) : '', item.notes]);
  });
  bkSheet.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(filePath);
  alert(`Exported ${state.items.length} entries to:\n${filePath}`);
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && state.editingFolder) { state.editingFolder = null; render(); return; }
  if (e.key === 'Escape' && state.creatingFolderIn) { state.creatingFolderIn = null; render(); return; }
  if (e.key === 'Escape' && state.editingItemIcon) { state.editingItemIcon = null; render(); return; }
  if (e.key === 'Escape' && state.modalOpen) { state.modalOpen = false; state.editItem = null; render(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('search-input')?.focus();
  }
  // ⌘Z / Ctrl+Z undoes the last folder change (merge, rename, delete, create) — but not
  // while typing in a text field, where it should do normal text-undo instead.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (state.folderUndoStack.length) {
      e.preventDefault();
      undoFolderChange();
    }
  }
});

// Trackpad swipe navigation, now that the view-mode buttons are gone:
//  - in Stats: swipe right (macOS "back") returns to the library
//  - inside a folder: swipe right (macOS "back") steps up a level
//  - on the home screen: swipe left opens MySpace; swipe right from MySpace returns home
//
// Accumulates deltaX across the whole gesture (instead of reacting to a single wheel tick) so
// both directions trigger at the same true swipe distance — trackpads don't always deliver the
// first tick of a gesture at the same size in both directions, which made "back" feel laggier.
let _navSwipeAt = 0;
let _swipeAccumX = 0;
let _swipeResetTimer = null;
const SWIPE_THRESHOLD = 14;
const SWIPE_COOLDOWN = 280;
const SWIPE_IDLE_RESET = 120;

function fireSwipe(action) {
  _navSwipeAt = Date.now();
  _swipeAccumX = 0;
  action();
}

window.addEventListener('wheel', e => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) + 4) { _swipeAccumX = 0; return; }  // must be a horizontal swipe

  _swipeAccumX += e.deltaX;
  clearTimeout(_swipeResetTimer);
  _swipeResetTimer = setTimeout(() => { _swipeAccumX = 0; }, SWIPE_IDLE_RESET);

  const now = Date.now();
  if (now - _navSwipeAt < SWIPE_COOLDOWN) return;                        // one step per swipe

  if (state.view === 'stats') {
    if (_swipeAccumX < -SWIPE_THRESHOLD) fireSwipe(() => { state.view = 'library'; render(); });
    return;
  }
  if (state.viewMode !== 'folder' && state.viewMode !== 'myspace') return;

  if (state.viewMode === 'folder') {
    if (state.folderPath && state.folderPath.length) {
      if (_swipeAccumX < -SWIPE_THRESHOLD) fireSwipe(() => { state.folderPath = state.folderPath.slice(0, -1); render(); });
    } else if (_swipeAccumX > SWIPE_THRESHOLD) {
      fireSwipe(() => { state.viewMode = 'myspace'; render(); });
    }
  } else if (state.viewMode === 'myspace' && _swipeAccumX < -SWIPE_THRESHOLD) {
    fireSwipe(() => { state.viewMode = 'folder'; render(); });
  }
}, { passive: true });

(async () => {
  state.items = await loadData();
  state.folderConfig = loadFolderConfig();
  state.bannerConfig = loadBannerConfig();
  // One-time migration: older data files stored folder icons only in localStorage.
  // Write them into the JSON file so cloud backup syncs folder covers to mobile.
  if (state._loadedFromFile && !state._jsonHadFolderConfig && Object.keys(state.folderConfig).length) {
    saveData();
  }
  render();
  // Pull any changes made on the phone (or elsewhere) and merge them in, then re-render.
  if (await syncFromCloud()) render();
})();
