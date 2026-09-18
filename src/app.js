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
  statsCalendarYear: null, // null = default to the most recent year with any reads logged
  calMoveDraft: null, // { itemId, oldDate, defaultDateStr, title } while the "move read date" modal is open
  settingsOpen: false,
  bannerConfig: {},
  folderUndoStack: [],
  deletedIds: {},   // id -> ISO timestamp of deletion, so cloud sync/backup can't resurrect it
  moodPickerOpen: false,
  moodPickerMood: null,     // key into MOODS while a result is showing
  moodPickerBookId: null,   // the TBR book currently revealed for that mood
  moodPickerFallback: false, // true if no TBR book matched the mood and this is a random pick instead
  moodPickerDesc: null,       // { text, source } once fetched, or 'loading', or 'none'
  loadError: null,          // set when the data file exists but can't be read — the app goes read-only
  recoveredFrom: null,      // name of the .bak / dated snapshot the library was restored from, if any
  readOnly: false,          // true while in recovery mode: nothing is ever written back to disk
  missingFiles: {},         // localFile path → true when the linked ebook isn't on disk (checked at launch)
  density: 'comfortable',   // 'comfortable' | 'compact' — card density, remembered in localStorage
  msSearch: '',             // MySpace board: filter typed into the TBR column
  msSort: 'added',          // MySpace board: 'added' | 'waiting' | 'shortest' | 'longest' | 'author' | 'series'
  msChip: null,             // MySpace board: genre (books) / fandom (fics) chip, or null
};

// ── Remembered UI state (which view you were in, sort, density) ────────────────
const UI_STATE_KEY = 'uiState:v1';
function restoreUiState() {
  try {
    const s = JSON.parse(localStorage.getItem(UI_STATE_KEY) || '{}');
    if (['list', 'folder', 'myspace'].includes(s.viewMode)) state.viewMode = s.viewMode;
    if (s.view === 'stats') state.view = 'stats';
    if (s.mySpaceTab === 'books' || s.mySpaceTab === 'ff') state.mySpaceTab = s.mySpaceTab;
    if (['week', 'month', 'year', 'ever'].includes(s.statsPeriod)) state.statsPeriod = s.statsPeriod;
    if (s.statsMetric === 'items' || s.statsMetric === 'words') state.statsMetric = s.statsMetric;
    if (['all', 'books', 'ff', 'oneshot'].includes(s.statsCategory)) state.statsCategory = s.statsCategory;
    if (['added', 'title', 'author', 'words', 'hearts', 'rating'].includes(s.sortBy)) state.sortBy = s.sortBy;
    if (s.folderSortBy === 'alpha' || s.folderSortBy === 'count') state.folderSortBy = s.folderSortBy;
    if (Array.isArray(s.folderPath) && s.folderPath.every(p => typeof p === 'string')) state.folderPath = s.folderPath;
  } catch {}
  try { state.density = localStorage.getItem('density:v2') === 'compact' ? 'compact' : 'comfortable'; } catch {}
  document.body.dataset.density = state.density;
}
let _uiStateTimer = null;
function persistUiState() {
  clearTimeout(_uiStateTimer);
  _uiStateTimer = setTimeout(() => {
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify({
        viewMode: state.viewMode, view: state.view, mySpaceTab: state.mySpaceTab,
        statsPeriod: state.statsPeriod, statsMetric: state.statsMetric, statsCategory: state.statsCategory,
        sortBy: state.sortBy, folderSortBy: state.folderSortBy, folderPath: state.folderPath,
      }));
    } catch {}
  }, 150);
}

// ── Linked ebook files: which ones are actually still on disk ──────────────────
async function refreshFileStatus() {
  const paths = [...new Set(state.items.map(x => x.localFile).filter(p => typeof p === 'string' && p))];
  if (!paths.length || !window.api.checkFiles) { const had = Object.keys(state.missingFiles).length > 0; state.missingFiles = {}; return had; }
  try {
    const res = await window.api.checkFiles(paths);
    const missing = {};
    for (const [p, ok] of Object.entries(res || {})) if (!ok) missing[p] = true;
    const changed = JSON.stringify(missing) !== JSON.stringify(state.missingFiles);
    state.missingFiles = missing;
    return changed;
  } catch { return false; }
}
// Try to find a moved file by name in the usual folders; fall back to the picker (pre-pointed
// at the best guess). Relinks and saves on success.
async function relinkLocalFile(item) {
  const name = (item.localFile || '').split('/').pop();
  showToast(`Looking for “${name}”…`, 'loading');
  let hits = [];
  try { hits = (await window.api.locateFile(name)) || []; } catch {}
  let picked = null;
  if (hits.length === 1) picked = hits[0];
  else {
    document.getElementById('toast')?.remove();
    const hint = hits[0] ? hits[0].slice(0, hits[0].lastIndexOf('/')) : undefined;
    picked = await window.api.pickLocalFile(hint);
  }
  if (!picked) {
    showToast(hits.length > 1 ? 'Several files with that name were found — pick the right one from the dialog to relink.' : 'Not found — link the file again once you know where it is.', 'info', { duration: 6000 });
    return;
  }
  item.localFile = picked;
  item._modAt = new Date().toISOString();
  saveData();
  await refreshFileStatus();
  render();
  showToast(hits.length === 1 ? `Found it — relinked to ${picked.split('/').pop()} ✓` : 'Relinked ✓', 'success');
}


// Bulk, automatic version — runs after the launch check and from Settings. Every missing file is
// looked for under the nearest folder that still exists (the "PDF and FF" folder the files were
// reorganised inside), by exact name first and then by normalised title ("Author - Title.ext").
// Unique matches are applied and saved; look-alikes stay flagged for the per-item picker.
async function relinkMovedFiles({ silent = false } = {}) {
  const missing = state.items.filter(x => x.localFile && state.missingFiles[x.localFile]);
  if (!missing.length || !window.api.relinkFiles) {
    if (!silent) showToast(missing.length ? 'File search isn’t available in this build.' : 'Every linked file is where it should be ✓', missing.length ? 'info' : 'success');
    return 0;
  }
  if (!silent) showToast(`Looking for ${missing.length} moved ${missing.length === 1 ? 'file' : 'files'}…`, 'loading');
  let res = null;
  try { res = await window.api.relinkFiles(missing.map(x => ({ id: x.id, path: x.localFile, title: x.title, author: x.author }))); } catch {}
  document.getElementById('toast')?.remove();
  if (!res || res.error) { if (!silent) showToast('Couldn’t search for the files.', 'error'); return 0; }
  const byId = new Map(state.items.map(x => [x.id, x]));
  const now = new Date().toISOString();
  let n = 0, byTitle = 0;
  for (const r of res.relinked || []) {
    const it = byId.get(r.id);
    if (!it || it.localFile !== r.from || typeof r.to !== 'string') continue;
    it.localFile = r.to; it._modAt = now; n++; if (r.confidence !== 'exact') byTitle++;
  }
  if (n) { saveData(); await refreshFileStatus(); render(); }
  const amb = (res.ambiguous || []).length, nf = (res.notFound || []).length;
  if (n || !silent) {
    const parts = [];
    if (n) parts.push(`Relinked ${n} moved ${n === 1 ? 'file' : 'files'}${byTitle ? ` (${byTitle} matched by title)` : ''} ✓`);
    if (amb) parts.push(`${amb} ${amb === 1 ? 'has' : 'have'} several look-alikes — use the book button to pick`);
    if (nf) parts.push(`${nf} not found under ${(res.roots || []).length ? res.roots.map(r => r.split('/').pop()).join(' or ') : 'the old folder'}`);
    showToast(parts.join(' · '), n ? 'success' : 'info', { duration: n ? 8000 : 6000 });
  }
  return n;
}


// ── Icon set ─────────────────────────────────────────────────────────────────────
// Stroke icons drawn with currentColor so they inherit text colour and theme. Emoji stay only
// where they are *content* the user chose (folder icons, covers, moods) — never as chrome.
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="M12 2.5l2.95 6.1 6.7.95-4.85 4.7 1.15 6.65L12 17.75 6.05 20.9 7.2 14.25 2.35 9.55l6.7-.95z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  feather: '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><path d="M16 8 2 22"/><path d="M17.5 15H9"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  refresh: '<path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  cloud: '<path d="M16 16l-4-4-4 4"/><path d="M12 12v9"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  chart: '<path d="M12 20V10M18 20V4M6 20v-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="16" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="8" cy="16" r="1.2" fill="currentColor"/><circle cx="16" cy="16" r="1.2" fill="currentColor"/>',
  home: '<path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
  sort: '<path d="M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 20V4"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1" fill="currentColor"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
};
window.icon = icon;
function icon(name, cls = '') {
  const d = ICONS[name] || ICONS.alert;
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

const STATUS = ['TBR','Reading','Finished','Dropped'];
const BANNER_PAGES = [
  { key: 'list',    label: 'Library (list view)' },
  { key: 'folder',  label: 'Browse / folders' },
  { key: 'myspace', label: 'MySpace' },
  { key: 'stats',   label: 'Stats' },
];
const BANNER_PRESETS = ['#7d6cf0', '#c4b5ff', '#f7b8dd', '#c9e6ff', '#2fd4c2', '#c8f04b', '#ffb648', '#ff7a59'];

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
// Parse a CSS colour string (hex or rgb()) into [r,g,b], or null.
function parseColor(str) {
  const s = String(str || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split('').map(ch => parseInt(ch + ch, 16));
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)].map(h => parseInt(h, 16));
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return null;
}
// A text ("ink") version of a banner colour that stays legible on the current theme's surfaces:
// same hue, lightness pinned dark on light mode and light on dark mode.
function inkFromBanner(color) {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return `hsl(${h.toFixed(0)} ${Math.round(Math.min(0.6, Math.max(s, 0.25)) * 100)}% ${dark ? 74 : 27}%)`;
}
function applyBanner() {
  const el = document.getElementById('app');
  if (!el) return;
  const raw = (state.bannerConfig[currentPageKey()] || '').trim();
  const bg = resolveBanner(raw);
  if (bg) el.style.setProperty('--banner', bg); else el.style.removeProperty('--banner');
  el.classList.toggle('has-banner', !!bg);
  // A solid banner colour tints this page's section labels (contrast-safe ink derived from it)
  // and fills the header bands; the app's accent colour is left alone so buttons, chips and
  // charts stay on the palette. An image banner has no single colour, so ink stays default.
  const isImage = /^https?:\/\//i.test(raw);
  const ink = raw && !isImage ? inkFromBanner(raw) : null;
  el.style.removeProperty('--purple'); // older builds set the accent from the banner
  if (ink) el.style.setProperty('--banner-ink', ink); else el.style.removeProperty('--banner-ink');
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
      <div class="fem-header"><span class="fem-title">Page banners</span><button class="fem-close" id="settings-close">${icon('x')}</button></div>
      <div class="fem-body" style="padding-bottom:14px; max-height:70vh; overflow-y:auto">
        <p class="fem-hint" style="display:block; margin-bottom:2px">Give each page's banner a colour (<b>#hex</b>) or a background <b>image URL</b> — like a book cover. Leave blank for the default sage.</p>
        ${rows}
      </div>
      <div class="modal-footer" style="padding:0 22px 18px"><button class="btn btn-primary" id="settings-done">Done</button></div>
    </div>
  </div>`;
}
const STATUS_COLOR = { TBR:'purple', Reading:'amber', Finished:'green', Dropped:'red' };

// ── Mood-based "what should I read next" picker ─────────────────────────────────
// Matches against genre (top-level, before " / ") and the trope tag used by the series-folder
// feature — same fields already populated for the Romance trope sort, so no new data needed.
function topGenre(item) { return (item.genre || '').split(' / ')[0].trim(); }
const MOODS = [
  { key: 'cozy', emoji: '😌', label: 'Cozy & comforting', match: b => topGenre(b) === 'Romance' && !['Mafia Romance', 'Dark Academy / Bully Romance'].includes(b.series) },
  { key: 'fun', emoji: '😂', label: 'Fun & light-hearted', match: b => ['Fake Dating', 'Bad Boy Romance', 'Enemies to Lovers', 'Grumpy x Sunshine'].includes(b.series) || topGenre(b) === 'Wattpad' },
  { key: 'cry', emoji: '😭', label: 'I want to cry', match: b => b.series === 'Second Chance / Angst' },
  { key: 'steamy', emoji: '🔥', label: 'Steamy & intense', match: b => topGenre(b) === 'Erotico' || ['Mafia Romance', 'Dark Academy / Bully Romance'].includes(b.series) },
  { key: 'escape', emoji: '🐉', label: 'Escape to another world', match: b => ['Fantasy', 'Romantasy', 'Trash Fantasy'].includes(topGenre(b)) },
  { key: 'sports', emoji: '🏆', label: 'Sports & competition', match: b => b.series === 'Sports Romance' || b.series === 'Hockey' },
  { key: 'royal', emoji: '👑', label: 'Billionaires & royals', match: b => b.series === 'Billionaire Romance' || b.series === 'Royal Romance' },
  { key: 'paranormal', emoji: '👻', label: 'Paranormal & supernatural', match: b => b.series === 'Omegaverse' || (b.series || '').includes('Paranormal') || (b.series || '').includes('Shifter') },
  { key: 'smart', emoji: '🧠', label: 'Thought-provoking', match: b => ['Saggistica', 'Romanzo Storico'].includes(topGenre(b)) },
  { key: 'surprise', emoji: '🎲', label: 'Surprise me completely', match: () => true },
];

function moodPool(moodKey) {
  const mood = MOODS.find(m => m.key === moodKey);
  if (!mood) return [];
  return state.items.filter(x => x.type === 'book' && x.status === 'TBR' && mood.match(x));
}
function pickMoodBook(moodKey) {
  // Falls back to the full TBR shelf if nothing on it happens to fit this mood, rather than
  // dead-ending — the modal marks the result as a fallback so it's not a silent mismatch.
  let pool = moodPool(moodKey);
  let fallback = false;
  if (!pool.length) {
    pool = state.items.filter(x => x.type === 'book' && x.status === 'TBR');
    fallback = true;
  }
  if (!pool.length) return { book: null, fallback: false };
  return { book: pool[Math.floor(Math.random() * pool.length)], fallback };
}

// ── Data normalisation (runs on every load, idempotent) ───────────────────────
// Older records and other clients have left a few inconsistencies in the file: a lowercase
// "finished" status, HTML entities in scraped AO3 tags ("Harry Potter&#39;s Parent"), Finished
// items whose readDates list is empty while readCount says 1, tags stored as non-arrays. None of
// this bumps _modAt — it's a repair of how the record is represented, not an edit, so it must
// never win a sync merge over a genuine change made on the phone.
const STATUS_CANON = Object.fromEntries(STATUS.map(s => [s.toLowerCase(), s]));
STATUS_CANON['dnf'] = 'Dropped'; STATUS_CANON['paused'] = 'Reading'; // legacy phone-only statuses
function normalizeItem(x) {
  if (!x || typeof x !== 'object') return x;
  const out = { ...x };
  const dec = s => (typeof s === 'string' && /&(?:amp|quot|#39|lt|gt|#\d+);/.test(s)) ? decodeTagEntities(s) : s;
  for (const f of ['title', 'author', 'fandom', 'pairing', 'genre', 'series', 'section', 'description', 'notes']) {
    if (typeof out[f] === 'string') out[f] = dec(out[f]);
  }
  out.tags = Array.isArray(out.tags) ? [...new Set(out.tags.filter(t => typeof t === 'string' && t.trim()).map(dec))] : [];
  if (typeof out.status === 'string') {
    const canon = STATUS_CANON[out.status.trim().toLowerCase()];
    if (canon) out.status = canon;
  }
  if (!STATUS.includes(out.status)) out.status = 'TBR';
  if (out.type !== 'ff' && out.type !== 'book') out.type = out.fandom || out.hearts ? 'ff' : 'book';
  for (const f of ['words', 'hearts', 'pages']) {
    if (typeof out[f] === 'string') { const n = parseInt(out[f].replace(/[^\d]/g, ''), 10); out[f] = Number.isFinite(n) ? n : null; }
  }
  if (typeof out.userRating !== 'number' || !Number.isFinite(out.userRating)) out.userRating = 0;
  // Finished ⇒ read at least once. readDates is what stats trust, so make it agree with readCount.
  if (Array.isArray(out.readDates)) {
    out.readDates = out.readDates.filter(d => d === null || (typeof d === 'string' && Number.isFinite(Date.parse(d))));
    if (out.status === 'Finished' && out.readDates.length === 0) {
      out.readDates = Array.from({ length: Math.max(1, out.readCount || 0) }, () => out.finishedAt || null);
    }
    // Chronological order (unknown dates last) so "latest re-read" and the － stepper mean what
    // they say even after a date was edited in the calendar.
    const dated = out.readDates.filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
    const undated = out.readDates.filter(d => !d);
    // Legacy migration artefact: "read 3 times" became three copies of the one finish date,
    // which stacked three events on a single day in the calendar and charts. Keep the first
    // copy dated; the others are real reads with an unknown date.
    const sameDay = dated.length > 1 && dated.every(d => d.slice(0, 10) === dated[0].slice(0, 10)) && (!out.finishedAt || dated[0].slice(0, 10) === String(out.finishedAt).slice(0, 10));
    out.readDates = sameDay ? [dated[0], ...dated.slice(1).map(() => null), ...undated] : [...dated, ...undated];
    out.readCount = out.readDates.length;
  } else if (out.status === 'Finished' && !(out.readCount > 0)) {
    out.readCount = 1;
  }
  return out;
}
function normalizeFolderConfig(fc) {
  const out = {};
  for (const [k, v] of Object.entries(fc || {})) {
    if (!v || typeof v !== 'object') continue;
    const cfg = { ...v };
    if (Array.isArray(cfg.groupTags)) cfg.groupTags = [...new Set(cfg.groupTags.map(decodeTagEntities))];
    if (typeof cfg.filterTag === 'string') cfg.filterTag = decodeTagEntities(cfg.filterTag);
    out[decodeTagEntities(k)] = cfg;
  }
  return out;
}

// ── Persistence ───────────────────────────────────────────────────────────────
async function loadData() {
  state._loadedFromFile = false;
  state._jsonHadFolderConfig = false;
  let result = null;
  try { result = await window.api.loadData(); } catch (e) { result = { error: e.message || 'load failed' }; }
  if (result && result.error) {
    // The file is there but unreadable. Do NOT fall back to the seed list — that would be saved
    // straight back over the real library on the first edit. Go read-only and say so.
    state.loadError = result;
    state.readOnly = true;
    return [];
  }
  if (result) {
    const items = Array.isArray(result) ? result : (result.items || []);
    if (!Array.isArray(result) && result.folderConfig && Object.keys(result.folderConfig).length) {
      state._jsonHadFolderConfig = true;
      state.folderConfig = normalizeFolderConfig(result.folderConfig);
    }
    if (!Array.isArray(result) && result.deletedIds) state.deletedIds = result.deletedIds;
    if (!Array.isArray(result) && result.recoveredFrom) state.recoveredFrom = result.recoveredFrom;
    if (items.length) { state._loadedFromFile = true; return items.map(normalizeItem); }
  }
  // Genuine first launch (no library file anywhere on disk): start from the bundled seed list.
  return INITIAL_DATA.map((item, i) => normalizeItem({ ...item, _addedAt: i }));
}

// Saves are coalesced: if one is already being written, remember that the state moved on and
// write again once it lands. The most recent state always ends up on disk, and rapid edits
// (five star clicks in a row) cost one or two 800 KB serialisations instead of five.
let _saving = null, _saveQueued = false, _saveErrorShown = false;
function saveData() {
  if (state.readOnly) return Promise.resolve(false);
  if (_saving) { _saveQueued = true; return _saving; }
  _saving = (async () => {
    try {
      do {
        _saveQueued = false;
        const res = await window.api.saveData({ items: state.items, folderConfig: state.folderConfig, deletedIds: state.deletedIds });
        if (res && res.ok === false) throw new Error(res.error || 'save failed');
        _saveErrorShown = false;
      } while (_saveQueued);
      return true;
    } catch (e) {
      if (!_saveErrorShown) { _saveErrorShown = true; showToast(`⚠️ Couldn't save to disk: ${e.message}`, 'error', { duration: 8000 }); }
      return false;
    } finally { _saving = null; }
  })();
  return _saving;
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
  // Tombstones are kept for good. Each is ~70 bytes and deletions run to a couple of hundred a
  // year, so there's nothing to save by expiring them — while any TTL meant a device that had
  // been offline long enough could quietly bring a deleted entry back.
  let removedByTombstone = 0;
  for (const [id, ts] of Object.entries(delMerged)) {
    if (!Number.isFinite(Date.parse(ts))) { delete delMerged[id]; continue; } // malformed stamp → drop it
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
    // Records that arrive from the phone go through the same repairs as records loaded from disk.
    state.items = merged.items.map(normalizeItem);
    state.folderConfig = normalizeFolderConfig(merged.folderConfig);
    state.deletedIds = merged.deletedIds;
    localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig));
    await saveData();
    return true;
  } catch(e) { return false; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) { return n ? Number(n).toLocaleString() : '—'; }
function genId() { return Date.now() + '_' + Math.random().toString(36).slice(2); }
const WORDS_PER_PAGE = 250;   // used when a book has a page count but no word count
const WORDS_PER_MINUTE = 250; // reading-time estimate
function itemWords(x) { return x.words || (x.pages ? x.pages * WORDS_PER_PAGE : 0); }
// Whether a word figure is an estimate rather than a real count: flagged by an import, or
// derived from pages. Surfaced as "≈" wherever the number is shown.
function wordsEstimated(x) { return !!x._wordsEstimated || (!x.words && !!x.pages); }
// ── Reading progress ─────────────────────────────────────────────────────────────
// progress = { unit: 'page' | 'chapter' | 'percent', value, total | null, at: ISO }
// Where you are in a book you're reading, or where you stopped in one you dropped. The total
// falls back to the item's own page / chapter count when it isn't given explicitly.
function progressTotal(x) {
  const p = x?.progress;
  if (!p) return null;
  if (p.unit === 'percent') return 100;
  if (p.total > 0) return p.total;
  if (p.unit === 'page' && x.pages > 0) return x.pages;
  if (p.unit === 'chapter' && x.chaptersTotal > 0) return x.chaptersTotal;
  return null;
}
function progressPct(x) {
  const p = x?.progress;
  if (!p || !(Number(p.value) >= 0)) return null;
  const total = progressTotal(x);
  if (!total) return null;
  return Math.max(0, Math.min(100, Number(p.value) / total * 100));
}
function progressLabel(x) {
  const p = x?.progress, pct = progressPct(x);
  if (!p || pct === null) return '';
  if (p.unit === 'percent') return `${Math.round(pct)}%`;
  return `${p.unit === 'chapter' ? 'ch.' : 'p.'} ${p.value}/${progressTotal(x)} · ${Math.round(pct)}%`;
}
// Words credited for ONE read event of this item. A Dropped entry was not read to the end: it
// credits the part you got to when the stopping point is known, and nothing when it isn't —
// counting the full 4.7M words of an abandoned epic was the biggest distortion in the old totals.
function wordsPerRead(x) {
  if (x.status === 'Dropped') { const pct = progressPct(x); return pct === null ? 0 : itemWords(x) * pct / 100; }
  return itemWords(x);
}
// Everything credited to this item right now: its read events, plus the part of a book still
// being read (which has no event yet, so it counts in totals but not in the dated charts).
function creditedWords(x) {
  let w = wordsPerRead(x) * timesRead(x);
  if (x.status === 'Reading') { const pct = progressPct(x); if (pct !== null) w += itemWords(x) * pct / 100; }
  return w;
}
// Median words/day across every finished, board-tracked read — the app's "typical pace".
function typicalPace() {
  const paces = state.items
    .filter(x => x.status === 'Finished' && x.readingStartedAt && x.finishedAt && itemWords(x) > 0 && Date.parse(x.finishedAt) >= Date.parse(x.readingStartedAt))
    .map(x => itemWords(x) / daysBetween(x.readingStartedAt, x.finishedAt));
  return { median: median(paces), n: paces.length };
}
// When a book in progress is likely to be finished: this book's own pace once there is real
// progress and at least a day on the shelf, otherwise the library-wide median.
function finishEstimate(x) {
  const total = itemWords(x);
  if (!total || x.status !== 'Reading') return null;
  const pct = progressPct(x);
  const done = pct === null ? 0 : total * pct / 100;
  let pace = null, basis = '';
  if (pct !== null && pct > 0 && x.readingStartedAt) {
    const days = daysBetween(x.readingStartedAt, x.progress?.at || new Date().toISOString());
    if (days >= 1 && Date.parse(x.progress?.at || 0) - Date.parse(x.readingStartedAt) >= 86400000) { pace = done / days; basis = 'at your pace on this book'; }
  }
  if (!pace) { const g = typicalPace(); if (g.n >= 1 && g.median > 0) { pace = g.median; basis = 'at your typical pace'; } }
  if (!pace) return null;
  const daysLeft = Math.max(0, Math.ceil((total - done) / pace));
  return { daysLeft, date: new Date(Date.now() + daysLeft * 86400000), basis, pace: Math.round(pace), estimated: wordsEstimated(x) || pct === null };
}
// A book that has sat on the shelf a long time with no sign of movement.
const STALE_READ_DAYS = 60, STALE_PROGRESS_DAYS = 30;
function isStaleRead(x) {
  if (x.status !== 'Reading' || !x.readingStartedAt) return false;
  const lastTouch = Math.max(Date.parse(x.readingStartedAt) || 0, Date.parse(x.progress?.at || 0) || 0, Date.parse(x._modAt || 0) || 0);
  return Date.now() - Date.parse(x.readingStartedAt) > STALE_READ_DAYS * 86400000 && Date.now() - lastTouch > STALE_PROGRESS_DAYS * 86400000;
}
// Every path that turns something into "Reading" must stamp when that happened, otherwise the
// pace, the "started · Nd" chip and the finish estimate never appear for it.
function ensureReadingStart(x, now) {
  if (x.status === 'Reading' && !x.readingStartedAt) x.readingStartedAt = now || new Date().toISOString();
  return x;
}
// Times read: prefer the per-read timestamp list, fall back to the legacy count. 0 for
// anything not actually finished (TBR/Reading/Dropped with no explicit reads logged) —
// word/time totals must NOT count books or fics that haven't been read yet.
function timesRead(x) { return Array.isArray(x.readDates) ? x.readDates.length : (x.readCount ?? (x.status === 'Finished' ? 1 : 0)); }
// Per-read timestamps, migrating legacy reads to the finish date (best-known date for old reads).
function ensureReadDates(x) {
  if (Array.isArray(x.readDates)) return x.readDates.slice();
  const n = x.readCount ?? (x.status === 'Finished' ? 1 : 0);
  return Array.from({ length: n }, () => x.finishedAt || null);
}
// Most recent read timestamp, or null. Uses the latest *date*, not the last array slot —
// dates edited via the calendar can leave the list out of order.
function lastReadAt(x) {
  let best = null, bestT = -Infinity;
  for (const d of ensureReadDates(x)) { if (!d) continue; const t = Date.parse(d); if (Number.isFinite(t) && t > bestT) { bestT = t; best = d; } }
  return best;
}
// Flatten items into individual read events, each dated when that read happened.
function readEvents(items) {
  const ev = [];
  items.forEach(x => { const w = wordsPerRead(x); ensureReadDates(x).forEach(d => { if (d) ev.push({ date: d, words: w }); }); });
  return ev;
}
function median(nums) {
  const a = nums.filter(n => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
// Integer percentages that always sum to 100 (largest-remainder method).
function percentages(values) {
  const total = values.reduce((s, v) => s + v, 0);
  if (!total) return values.map(() => 0);
  const raw = values.map(v => v / total * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((s, v) => s + v, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]).slice(0, left).forEach(([, i]) => out[i]++);
  return out;
}
// Same, but keeping the item itself (for the reading calendar, which shows titles per day).
function readEventsWithItems(items) {
  const ev = [];
  items.forEach(x => { ensureReadDates(x).forEach(d => { if (d) ev.push({ date: d, item: x }); }); });
  return ev;
}
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Group every read event into year → month → day buckets for the reading calendar.
// Each year/month carries its own ff/book counts + word total, for the header stat rows.
function getReadingCalendarYears(items) {
  const years = new Map();
  readEventsWithItems(items).forEach(({ date, item }) => {
    const d = new Date(date);
    if (isNaN(d)) return;
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    const w = wordsPerRead(item);

    if (!years.has(y)) years.set(y, { year: y, ff: 0, book: 0, words: 0, months: new Map() });
    const yEntry = years.get(y);
    yEntry.words += w; item.type === 'ff' ? yEntry.ff++ : yEntry.book++;

    if (!yEntry.months.has(m)) yEntry.months.set(m, { month: m, ff: 0, book: 0, words: 0, days: new Map() });
    const mEntry = yEntry.months.get(m);
    mEntry.words += w; item.type === 'ff' ? mEntry.ff++ : mEntry.book++;

    if (!mEntry.days.has(day)) mEntry.days.set(day, []);
    mEntry.days.get(day).push({ item, date }); // keep the exact read date, for drag-to-move
  });
  return [...years.values()].sort((a, b) => b.year - a.year); // newest year first
}

// All 12 months of a given year (present or not), each with its day/item data if any.
function getReadingCalendarForYear(items, year) {
  const years = getReadingCalendarYears(items);
  const yearData = years.find(y => y.year === year);
  const months = Array.from({length: 12}, (_, m) => {
    const mEntry = yearData?.months.get(m);
    return {
      month: m, label: MONTHS_FULL[m],
      ff: mEntry?.ff || 0, book: mEntry?.book || 0, words: mEntry?.words || 0,
      days: mEntry ? [...mEntry.days.entries()].sort((a, b) => b[0] - a[0]) : [],
    };
  });
  return {
    year,
    ff: yearData?.ff || 0, book: yearData?.book || 0, words: yearData?.words || 0,
    months,
    hasOlder: years.some(y => y.year < year),
    hasNewer: years.some(y => y.year > year),
    latestYear: years[0]?.year ?? new Date().getFullYear(),
  };
}
function fmtTime(mins) {
  if (!mins || !Number.isFinite(mins)) return '0m';
  const h = Math.floor(mins / 60);
  if (h === 0) return `${Math.round(mins)}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  if (d === 0) { const rm = Math.round(mins % 60); return rm && h < 10 ? `${h}h ${rm}m` : `${h}h`; }
  return rh ? `${d}d ${rh}h` : `${d}d`;
}
function fmtNum(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0 ? '-' : ''; n = Math.abs(n);
  if (n >= 999500) return neg + (n / 1000000).toFixed(1) + 'M';   // 999,600 is "1.0M", not "1000K"
  if (n >= 1000) return neg + Math.round(n / 1000) + 'K';
  return neg + Math.round(n).toLocaleString();
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
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Accent- and case-insensitive text for search ("Attraversaspecchi", "Diari delle streghe" and
// AO3 tags with curly apostrophes should all match what's typed on a plain keyboard).
function norm(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").toLowerCase();
}
// Next add-order stamp. `items.length` used to be reused after deletions, so 30 records share a
// value today; monotonic max+1 keeps "recently added" ordering unambiguous from here on.
function nextAddedAt() {
  return state.items.reduce((m, x) => Math.max(m, typeof x._addedAt === 'number' ? x._addedAt : -1), -1) + 1;
}
// YYYY-MM-DD in *local* time for <input type=date>. Slicing the ISO string gives the UTC date,
// which is off by one for anyone east of Greenwich in the evening.
function toDateInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
      const q = norm(state.search);
      return norm(item.title).includes(q)
        || norm(item.author).includes(q)
        || norm(item.fandom).includes(q)
        || norm(item.genre).includes(q)
        || norm(item.series).includes(q)
        || norm(item.section).includes(q)
        || (item.tags||[]).some(t => norm(t).includes(q));
    }
    return true;
  }).sort(itemComparator(state.sortBy));
}

// Sort comparator with the "last read" timestamp resolved once per item rather than on every
// comparison (lastReadAt copies the readDates array each call — n·log n of those adds up).
function itemComparator(sortBy) {
  if (sortBy === 'title') return (a, b) => (a.title||'').localeCompare(b.title||'');
  if (sortBy === 'words') return (a, b) => (b.words||0) - (a.words||0);
  if (sortBy === 'hearts') return (a, b) => (b.hearts||0) - (a.hearts||0);
  if (sortBy === 'rating') return (a, b) => (b.userRating||0) - (a.userRating||0);
  if (sortBy === 'author') return (a, b) => (a.author||'').localeCompare(b.author||'');
  // default 'recent': most recently read/finished first; not-yet-read items on top by add order
  const cache = new Map();
  const readTs = x => {
    if (!cache.has(x)) { const r = lastReadAt(x); cache.set(x, r ? Date.parse(r) : null); }
    return cache.get(x);
  };
  return (a, b) => {
    const ta = readTs(a), tb = readTs(b);
    if (ta === null && tb === null) return (b._addedAt||0) - (a._addedAt||0);
    if (ta === null) return -1;
    if (tb === null) return 1;
    if (tb !== ta) return tb - ta;
    return (b._addedAt||0) - (a._addedAt||0);
  };
}

function getStats() {
  const items = state.items;
  let totalWords = 0, estimatedWords = 0;
  for (const x of items) {
    const w = creditedWords(x);
    totalWords += w;
    if (w && wordsEstimated(x)) estimatedWords += w;
  }
  return {
    total: items.length,
    ff: items.filter(x => x.type === 'ff').length,
    books: items.filter(x => x.type === 'book').length,
    tbr: items.filter(x => x.status === 'TBR').length,
    reading: items.filter(x => x.status === 'Reading').length,
    finished: items.filter(x => x.status === 'Finished').length,
    dropped: items.filter(x => x.status === 'Dropped').length,
    totalWords,
    estimatedWords,                 // share of totalWords that rests on page-count / import estimates
    hasEstimates: estimatedWords > 0,
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
  return `<span class="tag">${esc(t)}${removable ? `<span class="tag-remove" data-tag="${esc(t)}" data-id="${esc(itemId)}" title="Remove tag">×</span>` : ''}</span>`;
}

// Cover <img> markup shared by every card style. Lazy-loaded so the list view doesn't fire 900
// image requests at once; a failed load is swapped for the emoji tile by the delegated handler
// in init (see attachCoverFallback) — no inline onerror, which the CSP forbids.
function coverImgHtml(cls, url, fallbackEmoji) {
  return `<img class="${cls} cover-img" src="${esc(url)}" alt="" loading="lazy" decoding="async" data-fallback="${esc(fallbackEmoji)}" />`;
}

// ── Card HTML ─────────────────────────────────────────────────────────────────
function cardHtml(item) {
  const isFf = item.type === 'ff';
  const expanded = state.expandedId === item.id;
  const readCount = timesRead(item);
  const _lastRead = lastReadAt(item);
  const lastReadHtml = _lastRead ? `<span class="reread-sub">Last read ${new Date(_lastRead).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'})}</span>` : '';
  const metaParts = [];
  if (item.words) metaParts.push(`<span title="${wordsEstimated(item) ? 'Estimated word count' : 'Word count'}">${wordsEstimated(item) ? '≈' : ''}${fmt(item.words)} words</span>`);
  if (isFf && item.chaptersPosted) metaParts.push(`<span title="Chapters posted${item.chaptersTotal ? ' / planned' : ''}">${item.chaptersPosted}${item.chaptersTotal ? '/' + item.chaptersTotal : '/?'} chapters</span>`);
  if (isFf && item.hearts) metaParts.push(`<span title="Kudos">${fmt(item.hearts)} kudos</span>`);
  if (!isFf && item.pages) metaParts.push(`${fmt(item.pages)} pages`);
  if (!isFf && item.section) metaParts.push(`<span class="card-section">${esc(item.section)}</span>`);
  if (!isFf && item.series) metaParts.push(`<span class="card-series" title="Series">${esc(item.series)}</span>`);
  if (item.userRating > 0) metaParts.push(starsHtml(item.userRating, item.id, true));
  const allTags = item.tags || [];
  const TAG_LIMIT = 4;
  const tags = allTags.slice(0, TAG_LIMIT).map(t => tagHtml(t)).join('') + (allTags.length > TAG_LIMIT ? `<span class="tag tag-more" title="${esc(allTags.slice(TAG_LIMIT).join(', '))}">+${allTags.length - TAG_LIMIT}</span>` : '');
  const id = esc(item.id);

  let expandedHtml = '';
  if (expanded) {
    const statusBtns = STATUS.map(s =>
      `<button class="status-btn${item.status===s?' active-'+s:''}" data-set-status="${s}" data-id="${id}">${s}</button>`
    ).join('');
    const notesHtml = item.notes ? `<p class="card-notes">"${esc(item.notes)}"</p>` : '';
    const extraParts = [];
    if (isFf) {
      if (item.pairing) extraParts.push(`Pairing: ${esc(item.pairing)}`);
      if (item.rating) extraParts.push(`Rating: ${esc(item.rating)}`);
    }
    const extraHtml = extraParts.length ? `<p class="card-extra">${extraParts.join(' · ')}</p>` : '';

    expandedHtml = `
      <div class="card-expanded">
        <div class="status-switcher">${statusBtns}</div>
        <div class="card-rating-row">
          <span class="card-rating-label">Your rating:</span>
          ${starsHtml(item.userRating, item.id)}
        </div>
        <div class="reread-row">
          <div class="reread-info">
            <span class="reread-label">Read ${readCount} time${readCount === 1 ? '' : 's'}</span>
            ${lastReadHtml}
          </div>
          <div class="reread-stepper">
            <button class="reread-step" data-reread-delta="-1" data-reread-id="${id}" title="Remove the latest re-read"${readCount <= 0 ? ' disabled' : ''}>－</button>
            <button class="reread-step" data-reread-delta="1" data-reread-id="${id}" title="I re-read this today">＋</button>
          </div>
        </div>
        ${(item.status === 'Reading' || item.status === 'Dropped') ? (() => {
          const pct = progressPct(item);
          const label = item.status === 'Dropped' ? 'Stopped at' : 'Currently at';
          const est = finishEstimate(item);
          return `<div class="card-progress">
            <span class="card-progress-lbl">${icon('pin')} ${label}</span>
            ${pct !== null ? `<span class="prog-track"><span class="prog-fill" style="width:${pct.toFixed(1)}%"></span></span><b>${esc(progressLabel(item))}</b>` : `<span class="card-progress-none">${item.status === 'Dropped' ? 'unknown — no words credited' : 'not tracked yet'}</span>`}
            <button class="link-btn" data-progress="${id}">${pct !== null ? 'Update' : 'Set'}</button>
            ${est ? `<span class="ins-sub">· ≈ ${est.daysLeft} day${est.daysLeft === 1 ? '' : 's'} left ${esc(est.basis)}</span>` : ''}
          </div>`;
        })() : ''}
        ${notesHtml}${extraHtml}
        ${item.description ? `<div class="card-synopsis"><span class="card-synopsis-label">${isFf ? 'Summary' : 'Synopsis'}</span><p>${esc(item.description)}</p></div>` : ''}
        ${item.url ? `<p class="card-extra"><button class="link-btn" data-open-url="${esc(item.url)}">${icon('external')} Open link</button></p>` : ''}
      </div>`;
  }

  const sub = isFf
    ? `by <b>${esc(item.author||'—')}</b>${item.fandom ? ' · '+esc(item.fandom) : ''}`
    : `by <b>${esc(item.author||'—')}</b>${item.genre ? ' · '+esc(item.genre) : ''}`;

  const [cc1, cc2] = coverGradient(item);
  const coverIcon = item.coverIcon || '';
  const coverIsUrl = coverIcon.startsWith('http');
  const fallbackEmoji = isFf ? '✍️' : '📚';
  const coverInner = coverIsUrl
    ? coverImgHtml('card-cover-img', coverIcon, fallbackEmoji)
    : `<span class="card-cover-emoji">${esc(coverIcon) || fallbackEmoji}</span>`;

  // Books can be dragged onto a series folder card (or the "take out of series" drop zone) —
  // fanfiction entries have no series concept, so only book cards need to be draggable.
  const dragBookAttrs = !isFf ? ` draggable="true" data-drag-item-id="${id}"` : '';
  const hasLink = /^https?:\/\//i.test(item.url || '');
  const fileMissing = !isFf && item.localFile && state.missingFiles[item.localFile];
  const fileKind = item.localFile ? (item.localFile.toLowerCase().match(/\.(epub|pdf|mobi|azw3)$/)?.[1] || 'file').toUpperCase() : '';

  // Read history on something that isn't Finished: a re-read in progress, or a finished book
  // put back on the pile. Say so instead of hiding it.
  let rereadBadge = '';
  if (readCount > 1) rereadBadge = `<span class="badge badge-reread" title="Read ${readCount} times">${icon('refresh')} ${readCount}×</span>`;
  else if (readCount === 1 && item.status !== 'Finished') rereadBadge = `<span class="badge badge-reread" title="Read once before — the earlier read still counts in your stats">${icon('refresh')} ${item.status === 'Reading' ? 're-reading' : 'read before'}</span>`;

  // Inside a series folder: a book filed under a different genre than the folder gets a pill to
  // move it in line with the rest of the series (see the series view in folderViewHtml).
  const fp = state.folderPath;
  const inSeriesView = state.viewMode === 'folder' && fp[0] === 'book' && fp.length === 3 && fp[1] !== '__none__';
  const refileHtml = (!isFf && inSeriesView && item.series === fp[2] && topGenre(item) !== fp[1])
    ? `<button class="refile-pill" data-refile="${id}" data-refile-genre="${esc(fp[1])}" title="Change this book's genre so it sits with the rest of the series">Filed under <b>${esc(topGenre(item) || 'no genre')}</b> · Move to ${esc(fp[1])}</button>`
    : '';

  return `
    <div class="card${expanded ? ' is-expanded' : ''}" data-id="${id}"${dragBookAttrs} style="${accentStyle(item)}">
      <div class="card-top">
        <div class="card-cover" data-expand="${id}" style="--c1:${cc1};--c2:${cc2}">
          ${coverInner}
          <button class="cover-edit-btn" data-edit-item-icon="${id}" title="Change cover">${icon('edit')}</button>
        </div>
        <div class="card-main" data-expand="${id}">
          <div class="card-title-row">
            <span class="card-title">${esc(item.title)}</span>
            ${item.oneshot ? '<span class="badge badge-oneshot">One-shot</span>' : ''}
            ${rereadBadge}
          </div>
          <div class="card-sub">${sub}</div>
          ${metaParts.length ? `<div class="card-meta">${metaParts.join('<span class="dot">·</span>')}</div>` : ''}
          ${tags ? `<div class="card-tags">${tags}</div>` : ''}
          ${refileHtml}
        </div>
        <div class="card-side">
          ${badgeHtml(item.status)}
          <div class="card-actions">
            <button class="icon-btn${item.favorite ? ' fav-active' : ''}" data-toggle-fav="${id}" title="${item.favorite ? 'Remove from favourites' : 'Add to favourites'}">${icon('star')}</button>
            ${hasLink ? `<button class="icon-btn" data-open-url="${esc(item.url)}" title="Open link">${icon('external')}</button>` : ''}
            ${!isFf && item.localFile ? `<button class="icon-btn${fileMissing ? ' is-missing' : ''}" data-open-local="${id}" title="${fileMissing ? `Linked ${fileKind} not found on disk — click to locate or relink` : `Open ${fileKind}`}">${icon('bookOpen')}</button>` : ''}
            ${isFf && /archiveofourown|fanfiction\.net|transformativeworks/.test(item.url||'') ? `<button class="icon-btn" data-refresh-words="${id}" title="Refresh word count from the link">${icon('refresh')}</button>` : ''}
            <button class="icon-btn" data-edit="${id}" title="Edit">${icon('edit')}</button>
            <button class="icon-btn danger" data-delete="${id}" title="Delete">${icon('trash')}</button>
          </div>
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
          <button class="modal-close" id="modal-close">${icon('x')}</button>
        </div>

        ${!isEdit ? `<div class="type-toggle">
          ${typeBtn('ff', icon('feather') + ' Fanfiction')}
          ${typeBtn('book', icon('book') + ' Book')}
        </div>` : ''}

        ${isFf ? `
        <label class="field-label">Fic URL <span class="fem-hint">(AO3 or FF.net)</span></label>
        <div class="fetch-row">
          <input type="url" id="m-url" value="${esc(item.url||'')}" placeholder="https://archiveofourown.org/… or https://www.fanfiction.net/…" />
          <button class="btn btn-primary btn-sm" id="btn-fetch">Auto-fill</button>
        </div>
        <div class="fetch-msg" id="fetch-msg"></div>
        <label class="field-label">Format</label>
        <div class="type-toggle">
          <button class="type-btn${!item.oneshot ? ' active' : ''}" data-oneshot-btn="false">Multi-chapter</button>
          <button class="type-btn${item.oneshot ? ' active' : ''}" data-oneshot-btn="true">One-shot</button>
        </div>` : ''}

        <label class="field-label">Title *</label>
        ${!isFf ? `
          <div class="ac-wrap">
            <div class="fetch-row">
              <input type="text" id="m-title" value="${esc(item.title||'')}" placeholder="Title, author, ISBN, or paste a Goodreads/Amazon link…" />
              <button class="btn btn-primary btn-sm" id="btn-book-fetch">Auto-fill</button>
            </div>
            <div class="field-suggest" id="sug-title"></div>
          </div>
          <div class="fetch-msg" id="book-fetch-msg"></div>
        ` : `<div class="ac-wrap"><input type="text" id="m-title" value="${esc(item.title||'')}" placeholder="Title" /><div class="field-suggest" id="sug-title"></div></div>`}
        <div class="dupe-warn" id="dupe-warning"></div>

        <label class="field-label">Author</label>
        <div class="ac-wrap"><input type="text" id="m-author" value="${esc(item.author||'')}" placeholder="Author / username" /><div class="field-suggest" id="sug-author"></div></div>

        <div class="field-row">
          ${isFf ? `
          <div class="ac-wrap">
            <label class="field-label">Fandom</label>
            <input type="text" id="m-fandom" value="${esc(item.fandom||'')}" placeholder="e.g. Harry Potter" />
            <div class="field-suggest" id="sug-fandom"></div>
          </div>
          <div class="ac-wrap">
            <label class="field-label">Pairing</label>
            <input type="text" id="m-pairing" value="${esc(item.pairing||'')}" placeholder="e.g. M/M or Harry/Ginny" />
            <div class="field-suggest" id="sug-pairing"></div>
          </div>
          <div style="grid-column:1 / -1">
            <label class="field-label">Summary <span class="fem-hint">(auto-filled from the AO3 link, or paste your own)</span></label>
            <textarea id="m-description" rows="4" placeholder="The fic's summary…">${esc(item.description||'')}</textarea>
          </div>` : `
          <div class="ac-wrap">
            <label class="field-label">Genre</label>
            <input type="text" id="m-genre" value="${esc(item.genre||'')}" placeholder="e.g. Romantasy" />
            <div class="field-suggest" id="sug-genre"></div>
          </div>
          <div>
            <label class="field-label">Pages</label>
            <input type="number" id="m-pages" min="0" value="${item.pages||''}" placeholder="e.g. 512" />
          </div>
          <div class="ac-wrap">
            <label class="field-label">Series <span class="fem-hint">(optional — groups books under a series folder)</span></label>
            <input type="text" id="m-series" value="${esc(item.series||'')}" placeholder="e.g. Fourth Wing" />
            <div class="field-suggest" id="sug-series"></div>
          </div>
          <div style="grid-column:1 / -1">
            <label class="field-label">Linked ebook file</label>
            <div class="local-file-row">
              <span class="local-file-name" id="m-localfile-name" title="${esc(item.localFile||'')}">${item.localFile ? esc(item.localFile.split('/').pop()) : 'No file linked'}${item.localFile && state.missingFiles[item.localFile] ? ' <span class="local-file-missing">· ⚠️ not found on disk</span>' : ''}</span>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-pick-localfile">${item.localFile ? 'Change…' : 'Link file…'}</button>
              ${item.localFile ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-clear-localfile">Remove</button>` : ''}
            </div>
          </div>
          <div style="grid-column:1 / -1">
            <label class="field-label">Synopsis <span class="fem-hint">(auto-filled by Auto-fill, or paste your own)</span></label>
            <textarea id="m-description" rows="4" placeholder="A short synopsis…">${esc(item.description||'')}</textarea>
          </div>`}
        </div>

        <div class="field-row">
          <div>
            <label class="field-label">Word count</label>
            <div class="wc-row">
              <input type="number" id="m-words" min="0" value="${item.words||''}" placeholder="e.g. 120000" />
              ${isFf ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-refresh-words" title="Refresh word count & kudos from the link (doesn't touch your other fields)">${icon('refresh')}</button>` : ''}
            </div>
          </div>
          ${isFf ? `
          <div>
            <label class="field-label">Kudos / Hearts</label>
            <input type="number" id="m-hearts" min="0" value="${item.hearts||''}" placeholder="e.g. 5000" />
          </div>` : `
          <div>
            <label class="field-label">Section</label>
            <input type="text" id="m-section" value="${esc(item.section||'')}" placeholder="e.g. Romantasy" />
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
        <input type="number" id="m-readcount" min="0" value="${Array.isArray(item.readDates) ? item.readDates.length : (item.readCount ?? (item.status === 'Finished' ? 1 : 0))}" style="width:100px" />

        <label class="field-label">Progress <span class="fem-hint">(where you are, or where you stopped if dropped — only that part counts as read)</span></label>
        <div class="progress-fields">
          <select id="m-prog-unit" class="filter-select">
            ${['page', 'chapter', 'percent'].map(u => `<option value="${u}"${(item.progress?.unit || (isFf ? 'chapter' : 'page')) === u ? ' selected' : ''}>${u[0].toUpperCase() + u.slice(1)}</option>`).join('')}
          </select>
          <input type="number" id="m-prog-value" min="0" placeholder="—" value="${item.progress?.value ?? ''}" />
          <span class="progress-of">${(item.progress?.unit || (isFf ? 'chapter' : 'page')) === 'percent' ? '%' : 'of'}</span>
          <input type="number" id="m-prog-total" min="1" placeholder="total" value="${item.progress?.total ?? (isFf ? (item.chaptersTotal || '') : (item.pages || ''))}" />
        </div>

        <label class="field-label">Date finished <span class="fem-hint">(optional)</span></label>
        <input type="date" id="m-finished" value="${item.finishedAt ? toDateInputValue(item.finishedAt) : (!isEdit && (item.status || 'TBR') === 'Finished' ? toDateInputValue(new Date().toISOString()) : '')}" />

        <label class="field-label">Notes</label>
        <textarea id="m-notes" placeholder="Personal thoughts, read again?">${esc(item.notes||'')}</textarea>

        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-submit">${isEdit ? 'Save changes' : 'Add to list'}</button>
        </div>
      </div>
    </div>`;
}

// ── Stats View ────────────────────────────────────────────────────────────────
// Every figure here follows the same three rules, stated in the footnotes:
//   1. a read counts once per read event (re-reads add up); TBR/Reading add nothing yet;
//   2. a Dropped entry's read event counts as an item but contributes 0 words;
//   3. words come from the real count when there is one, else pages × 250 (marked ≈).
function statsViewHtml() {
  const SPEED = WORDS_PER_MINUTE;
  const fin = {
    all:     state.items,
    books:   state.items.filter(x => x.type === 'book'),
    ff:      state.items.filter(x => x.type === 'ff' && !x.oneshot),
    oneshot: state.items.filter(x => x.type === 'ff' && x.oneshot),
  };
  const cat = state.statsCategory;
  const items = fin[cat];
  const totalCount = items.length;
  const wordsOf = list => list.reduce((s, x) => s + creditedWords(x), 0);
  const totalWords = wordsOf(items);
  const estWords = items.reduce((s, x) => s + (wordsEstimated(x) ? creditedWords(x) : 0), 0);
  const totalMins = totalWords / SPEED;
  const approx = estWords > 0 ? '≈' : '';

  const tab = (id, lbl) =>
    `<span class="stat-tab${cat === id ? ' active' : ''}" data-scat="${id}">${lbl}</span>`;

  // Breakdown bar (all category only)
  let breakdownHtml = '';
  if (cat === 'all' && totalWords > 0) {
    const parts = [
      { key:'books',   lbl:'Books',       cls:'green',  list: fin.books },
      { key:'ff',      lbl:'Fanfiction',  cls:'purple', list: fin.ff },
      { key:'oneshot', lbl:'One-shots',   cls:'amber',  list: fin.oneshot },
    ].filter(p => p.list.length > 0).map(p => ({ ...p, w: wordsOf(p.list) }));
    const pcts = percentages(parts.map(p => p.w));   // always sums to 100
    const rows = parts.map((p, i) => `<div class="bdrow">
        <span class="bddot ${p.cls}"></span>
        <span class="bdlabel">${p.lbl}</span>
        <span class="bdstat">${p.list.length} · ${fmtNum(p.w)} words · ${fmtTime(p.w/SPEED)}</span>
        <span class="bdpct">${pcts[i]}%</span>
      </div>`).join('');
    const segs = parts.map((p, i) => `<div class="bdseg ${p.cls}" style="width:${pcts[i]}%"></div>`).join('');
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
  // Trend: never compare a half-elapsed current bucket against a complete previous one — that
  // reads as a collapse at the start of every month. If the current bucket is under half done,
  // compare the last two *complete* buckets instead, and say so.
  const elapsed = currentBucketElapsedFraction(state.statsPeriod);
  const useComplete = elapsed < 0.5 && values.length >= 3;
  const lastV = useComplete ? (values[values.length - 2] || 0) : (values[values.length - 1] || 0);
  const prevV = useComplete ? (values[values.length - 3] || 0) : (values[values.length - 2] || 0);
  const bucketName = { week: 'day', month: 'week', year: 'month', ever: 'year' }[state.statsPeriod] || 'period';
  const trendLabel = useComplete ? `last full ${bucketName} vs the one before` : `vs previous ${bucketName}${elapsed < 1 ? ' (so far)' : ''}`;
  const pctChange = prevV > 0 ? Math.round((lastV - prevV) / prevV * 100) : null;
  const bars = groups.map((g, i) => {
    const val = values[i];
    const pct = val > 0 ? Math.max(Math.sqrt(val / maxVal) * 88, 5) : 0;
    const lbl = isWords ? fmtNum(val) : String(val);
    const isPeak = val > 0 && i === peakIdx;
    const tip = `${g.label}: ${isWords ? fmtNum(val) + ' words · ' + fmtTime(val / SPEED) : val + (val === 1 ? ' read' : ' reads')}`;
    return `<div class="chart-col" title="${tip}">
      <div class="chart-bar-wrap">
        ${val > 0 ? `<span class="chart-bar-val${isPeak ? ' peak' : ''}">${lbl}</span>` : ''}
        <div class="chart-bar${val === 0 ? ' empty' : ''}${isPeak ? ' peak' : ''}" style="height:${pct}%"></div>
      </div>
      <div class="chart-bar-lbl${isPeak ? ' peak' : ''}">${g.label}</div>
    </div>`;
  }).join('');
  // Friendly, dynamic headline for the trend
  const periodName = { week: 'this week', month: 'these 4 weeks', year: 'this year', ever: 'all time' }[state.statsPeriod] || '';
  const trendTxt = pctChange === null ? '' :
    pctChange > 0 ? ` · <span class="ins-up" title="${trendLabel}">▲ ${pctChange}%</span> <span class="ins-sub">${trendLabel}</span>` :
    pctChange < 0 ? ` · <span class="ins-down" title="${trendLabel}">▼ ${Math.abs(pctChange)}%</span> <span class="ins-sub">${trendLabel}</span>` : ` · <span class="ins-flat">→ steady</span> <span class="ins-sub">${trendLabel}</span>`;
  let insightHtml;
  if (periodTotal === 0) {
    insightHtml = `Nothing logged ${periodName} yet — finish a fic (or add a finish date) and watch this fill up.`;
  } else if (isWords) {
    const novels = periodTotal / 90000;
    const novelsTxt = novels >= 0.4 ? ` &nbsp;·&nbsp; ≈ ${novels < 10 ? novels.toFixed(1) : Math.round(novels)} novels’ worth <span class="ins-sub">(90k words each)</span>` : '';
    insightHtml = `<b>${fmtNum(periodTotal)}</b> words ${periodName}${novelsTxt} &nbsp;·&nbsp; best: <b>${groups[peakIdx].label}</b>${trendTxt}`;
  } else {
    insightHtml = `<b>${periodTotal}</b> read${periodTotal === 1 ? '' : 's'} ${periodName} &nbsp;·&nbsp; best: <b>${groups[peakIdx].label}</b>${trendTxt}`;
  }

  // What the totals leave out or estimate — said plainly rather than hidden in the number.
  // Undated read *events* (not just items): a book read three times with one known date has
  // two reads that count in the totals but can't be placed on the chart or calendar.
  let undatedEvents = 0, undatedWords = 0;
  items.forEach(x => { const n = ensureReadDates(x).filter(d => !d).length; if (n) { undatedEvents += n; undatedWords += n * wordsPerRead(x); } });
  const zeroWordReads = items.filter(x => timesRead(x) > 0 && x.status !== 'Dropped' && !itemWords(x)).length;
  const dropped = items.filter(x => x.status === 'Dropped' && timesRead(x) > 0);
  const droppedReads = dropped.length, droppedKnown = dropped.filter(x => progressPct(x) !== null).length;
  const inProgress = items.filter(x => x.status === 'Reading' && progressPct(x) !== null);
  const inProgressWords = inProgress.reduce((s, x) => s + itemWords(x) * progressPct(x) / 100, 0);
  const notes = [];
  if (inProgress.length) notes.push(`${inProgress.length} book${inProgress.length === 1 ? '' : 's'} in progress credit${inProgress.length === 1 ? 's' : ''} ${fmtNum(inProgressWords)} words read so far — in the totals, not in the charts until finished.`);
  if (undatedEvents > 0) notes.push(`${undatedEvents} read${undatedEvents === 1 ? '' : 's'} (${fmtNum(undatedWords)} words) ${undatedEvents === 1 ? 'has' : 'have'} no date, so ${undatedEvents === 1 ? 'it counts' : 'they count'} in the totals above but not in the chart or calendar — edit the item and set a finish date, or move the read on the calendar.`);
  if (zeroWordReads > 0) notes.push(`${zeroWordReads} read item${zeroWordReads === 1 ? '' : 's'} ${zeroWordReads === 1 ? 'has' : 'have'} neither a word nor a page count and add${zeroWordReads === 1 ? 's' : ''} nothing to the word totals.`);
  if (droppedReads > 0) notes.push(`${droppedReads} dropped item${droppedReads === 1 ? '' : 's'} ${droppedReads === 1 ? 'appears' : 'appear'} in the read counts and calendar. ${droppedKnown ? `${droppedKnown} with a known stopping point count only the part you read; ` : ''}${droppedReads - droppedKnown ? `${droppedReads - droppedKnown} without one add no words — set where you stopped on the card to credit them.` : ''}`);
  if (estWords > 0) notes.push(`About ${Math.round(estWords / totalWords * 100)}% of the word total rests on estimates (imported counts or pages × ${WORDS_PER_PAGE}).`);
  const noteHtml = notes.map(n => `<p class="stats-note">${n.replace(/^[^\w≈]+\s*/u, '')}</p>`).join('');

  const pBtn = (id, lbl) =>
    `<button class="speriod-btn${state.statsPeriod===id?' active':''}" data-speriod="${id}">${lbl}</button>`;
  const mBtn = (id, lbl) =>
    `<button class="smetric-btn${state.statsMetric===id?' active':''}" data-smetric="${id}">${lbl}</button>`;

  // Reading pace — books & fics tracked through the MySpace board (have both a start and finish
  // date). Uses the same word figure as everything else (real count, else pages × 250), and the
  // headline is a *median*: one fic marked Reading and Finished on the same day shows up as
  // hundreds of thousands of words/day and would make a mean meaningless.
  const pacedReads = state.items
    .filter(x => (x.type === 'ff' || x.type === 'book') && x.status !== 'Dropped' && x.readingStartedAt && x.finishedAt && itemWords(x) > 0 && Date.parse(x.finishedAt) >= Date.parse(x.readingStartedAt))
    .map(x => { const days = daysBetween(x.readingStartedAt, x.finishedAt); const w = itemWords(x); return { title: x.title, words: w, est: wordsEstimated(x), days, sameDay: Date.parse(x.finishedAt) - Date.parse(x.readingStartedAt) < 86400000, pace: Math.round(w / days), end: x.finishedAt }; })
    .sort((a, b) => Date.parse(a.end) - Date.parse(b.end));
  let paceHtml = `
      <div class="stats-trend-hdr" style="margin-top:24px">
        <span class="stats-section-ttl">Reading pace</span>
      </div>
      <div class="stats-insight">Not enough tracked reads yet — drag a book or fic through <b>TBR → Reading → Finished</b> on the MySpace board and its pace will show up here.</div>`;
  if (pacedReads.length) {
    const typical = Math.round(median(pacedReads.map(r => r.pace)));
    const maxPace = Math.max(...pacedReads.map(r => r.pace), 1);
    const fastest = pacedReads.reduce((b, r) => r.pace > b.pace ? r : b, pacedReads[0]);
    const slowest = pacedReads.reduce((b, r) => r.pace < b.pace ? r : b, pacedReads[0]);
    const sameDayN = pacedReads.filter(r => r.sameDay).length;

    // Trend: your most recent reads vs the equally-sized batch right before them (medians).
    let trendTxt = '';
    const windowN = Math.min(5, Math.floor(pacedReads.length / 2));
    if (windowN >= 2) {
      const recent = median(pacedReads.slice(-windowN).map(r => r.pace));
      const older = median(pacedReads.slice(-windowN * 2, -windowN).map(r => r.pace));
      const chg = older > 0 ? Math.round((recent - older) / older * 100) : 0;
      trendTxt = chg > 5 ? ` &nbsp;·&nbsp; <span class="ins-up">▲ ${chg}% faster</span> than your ${windowN} reads before that`
        : chg < -5 ? ` &nbsp;·&nbsp; <span class="ins-down">▼ ${Math.abs(chg)}% slower</span> than your ${windowN} reads before that`
        : ` &nbsp;·&nbsp; <span class="ins-flat">→ steady pace</span> vs your ${windowN} reads before that`;
    }

    const paceBars = pacedReads.map(r => {
      const h = Math.max(Math.sqrt(r.pace / maxPace) * 88, 5);
      const isFastest = r === fastest && fastest.pace !== slowest.pace;
      return `<div class="chart-col" title="${esc(r.title || '')} — ${fmtNum(r.pace)} words/day (${r.est ? '≈' : ''}${fmtNum(r.words)}w in ${r.days}d${r.sameDay ? ', same day' : ''})">
        <div class="chart-bar-wrap"><span class="chart-bar-val${isFastest ? ' peak' : ''}">${fmtNum(r.pace)}</span><div class="chart-bar${isFastest ? ' peak' : ''}" style="height:${h}%"></div></div>
        <div class="chart-bar-lbl">${fmtDateShort(r.end)}</div>
      </div>`;
    }).join('');
    paceHtml = `
      <div class="stats-trend-hdr" style="margin-top:24px">
        <span class="stats-section-ttl">Reading pace</span>
        <span class="stats-note" style="margin:0">${pacedReads.length} tracked read${pacedReads.length === 1 ? '' : 's'}</span>
      </div>
      <div class="stats-insight">Typical pace <b>${fmtNum(typical)}</b> words/day <span class="ins-sub">(median of your tracked reads)</span>${trendTxt}</div>
      <div class="stats-chart">${paceBars}</div>
      <div class="stats-chart-base"></div>
      ${fastest.pace !== slowest.pace ? `<p class="stats-note" style="margin-top:6px">Fastest: <b>${esc(fastest.title || '')}</b> at ${fmtNum(fastest.pace)} words/day &nbsp;·&nbsp; Slowest: <b>${esc(slowest.title || '')}</b> at ${fmtNum(slowest.pace)} words/day</p>` : ''}
      <p class="stats-note" style="margin-top:6px">Pace = words ÷ days from start to finish (a same-day finish counts as 1 day${sameDayN ? ` — ${sameDayN} of these ${sameDayN === 1 ? 'is' : 'are'} same-day and probably logged after the fact` : ''}). Reads are tracked by dragging through the <b>MySpace</b> board (TBR → Reading → Finished).</p>`;
  }

  // Reading calendar — one card per month of a chosen year, navigable year by year. Every
  // dated read event belongs here, whatever the item's status is *now*: a book being re-read
  // still had its first read, and a dropped one still had the day you gave up on it.
  const calItems = items;
  const calYear = state.statsCalendarYear ?? getReadingCalendarYears(calItems)[0]?.year ?? new Date().getFullYear();
  const calYearData = getReadingCalendarForYear(calItems, calYear);
  const calPill = (emoji, val) => `<span class="cal-year-pill">${emoji} ${val}</span>`;
  const calendarHtml = `
    <div class="stats-trend-hdr" style="margin-top:24px">
      <span class="stats-section-ttl">Reading calendar</span>
    </div>
    <div class="cal-year-nav">
      <button class="cal-year-btn" data-cal-year-nav="prev"${calYearData.hasOlder?'':' disabled'} title="Previous year">${icon('arrowLeft')}</button>
      <div class="cal-year-stats">
        <span class="cal-year-label">${calYear}</span>
        ${calPill(icon('feather'), calYearData.ff + ' fics')}
        ${calPill(icon('book'), calYearData.book + ' books')}
        ${calPill('', fmtNum(calYearData.words) + ' words')}
        ${calPill(icon('clock'), fmtTime(calYearData.words / SPEED))}
      </div>
      <button class="cal-year-btn" data-cal-year-nav="next"${calYearData.hasNewer?'':' disabled'} title="Next year"><span class="flip-h">${icon('arrowLeft')}</span></button>
    </div>
    <div class="read-calendar">
      ${calYearData.months.map(m => `
        <div class="cal-month-card" data-cal-drop-year="${calYear}" data-cal-drop-month="${m.month}">
          <div class="cal-month-hdr">
            <span class="cal-month-name">${m.label}</span>
            <span class="cal-month-stats">${m.ff||m.book ? `${m.ff ? m.ff + ' fic' + (m.ff === 1 ? '' : 's') : ''}${m.ff && m.book ? ' · ' : ''}${m.book ? m.book + ' book' + (m.book === 1 ? '' : 's') : ''} · ${fmtNum(m.words)} words` : '—'}</span>
          </div>
          <div class="cal-month-body">
            ${m.days.length ? m.days.map(([day, its]) => `
              <div class="cal-day-row">
                <span class="cal-day-date">${day}</span>
                <div class="cal-day-icons">
                  ${its.map(({item, date}) => calItemIconHtml(item, date)).join('')}
                </div>
              </div>
            `).join('') : '<div class="cal-month-empty">Nothing read</div>'}
          </div>
        </div>
      `).join('')}
    </div>`;

  return `<div id="stats-view">
    <div class="stats-cats">
      ${tab('all','All')}${tab('books','Books')}${tab('ff','Fanfiction')}${tab('oneshot','One-shots')}
    </div>
    <div class="stats-summary">
      <div class="scard"><div class="scard-num">${totalCount}</div><div class="scard-lbl">items</div></div>
      <div class="scard"><div class="scard-num">${approx}${fmtNum(totalWords)}</div><div class="scard-lbl">words read</div></div>
      <div class="scard"><div class="scard-num">${approx}${fmtTime(totalMins)}</div><div class="scard-lbl">reading time*</div></div>
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
    <p class="stats-note" style="margin-top:6px">* Reading time assumes ${WORDS_PER_MINUTE} words/min. Each read counts once (re-reads add up); TBR and Reading items add nothing until finished. Bars use a square-root scale so quiet periods stay visible — read the numbers, not the heights.</p>
    ${paceHtml}
    ${calendarHtml}
  </div>`;
}

// How far through the current chart bucket we are (0–1): day for 'week', 7-day window for
// 'month', calendar month for 'year', calendar year for 'ever'.
function currentBucketElapsedFraction(period) {
  const now = new Date();
  if (period === 'week') return (now.getHours() * 60 + now.getMinutes()) / 1440;
  if (period === 'month') return 1; // the last 7-day window always ends today, so it is complete by construction
  if (period === 'year') { const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(); return (now.getDate() - 1 + now.getHours() / 24) / days; }
  if (period === 'ever') { const start = new Date(now.getFullYear(), 0, 1), end = new Date(now.getFullYear() + 1, 0, 1); return (now - start) / (end - start); }
  return 1;
}

// ── MySpace — reading board ─────────────────────────────────────────────────────
function mySpaceCard(x) {
  const [c1, c2] = coverGradient(x);
  const coverIsUrl = (x.coverIcon || '').startsWith('http');
  const fallback = x.type === 'book' ? '📚' : '✍️';
  const cover = coverIsUrl
    ? coverImgHtml('ms-cover-img', x.coverIcon, fallback)
    : `<span class="ms-cover-emoji">${esc(x.coverIcon) || fallback}</span>`;
  const tags = [];
  if (x.status === 'Reading' && x.readingStartedAt) {
    tags.push(`<span class="ms-badge">${icon('calendar')} ${fmtDateShort(x.readingStartedAt)} · day ${daysBetween(x.readingStartedAt, new Date().toISOString())}</span>`);
  }
  if (x.status === 'Reading' && progressPct(x) !== null) tags.push(`<button class="ms-badge ms-progress-chip" data-progress="${esc(x.id)}" draggable="false" title="Update where you are">${icon('pin')} ${esc(progressLabel(x))}</button>`);
  if (x.words) tags.push(`<span class="ms-wc">${wordsEstimated(x) ? '≈' : ''}${fmtNum(x.words)}w</span>`);
  else if (x.pages) tags.push(`<span class="ms-wc">${x.pages}p</span>`);
  if (x.type === 'book' && x.series) tags.push(`<span class="ms-wc" title="Series">${esc(x.series)}</span>`);
  if (x.url) tags.push(`<button class="ms-link" data-open-url="${esc(x.url)}" draggable="false" title="Open in browser">${icon('external')}</button>`);
  if (/archiveofourown|fanfiction\.net|transformativeworks/.test(x.url || '')) tags.push(`<button class="ms-refresh" data-ms-refresh="${esc(x.id)}" draggable="false" title="Refresh word count from the link">${icon('refresh')}</button>`);
  return `<div class="ms-card" draggable="true" data-ms-id="${esc(x.id)}" title="${esc(x.title || '')}">
    <div class="ms-cover" style="background:linear-gradient(135deg,${c1},${c2})">${cover}<button class="ms-cover-edit cover-edit-btn" data-edit-item-icon="${esc(x.id)}" draggable="false" title="Change cover">${icon('edit')}</button></div>
    <div class="ms-meta">
      <div class="ms-title">${esc(x.title || 'Untitled')}</div>
      <div class="ms-author">${esc(x.author || '')}${x.fandom ? ' · ' + esc(x.fandom) : ''}</div>
      ${tags.length ? `<div class="ms-tags">${tags.join('')}</div>` : ''}
    </div>
  </div>`;
}

// ── MySpace: TBR column tools (search · sort · genre/fandom chips) ───────────────
const MS_SORTS = [
  ['added',    'Recently added'],
  ['waiting',  'Longest waiting'],
  ['shortest', 'Shortest first'],
  ['longest',  'Longest first'],
  ['author',   'Author A → Z'],
  ['series',   'By series / fandom'],
];
function msGroupOf(x) { return x.type === 'book' ? (topGenre(x) || 'No genre') : (x.fandom || 'No fandom'); }
function msApplyTools(items) {
  let list = items;
  if (state.msChip) list = list.filter(x => msGroupOf(x) === state.msChip);
  if (state.msSearch) { const q = norm(state.msSearch); list = list.filter(x => norm(x.title).includes(q) || norm(x.author).includes(q) || norm(x.series).includes(q) || norm(x.fandom).includes(q) || (x.tags || []).some(t => norm(t).includes(q))); }
  const byAdded = (a, b) => (b._addedAt || 0) - (a._addedAt || 0);
  const len = x => itemWords(x) || Infinity;
  const sorters = {
    added: byAdded,
    waiting: (a, b) => (a._addedAt || 0) - (b._addedAt || 0),
    shortest: (a, b) => len(a) - len(b) || byAdded(a, b),
    longest: (a, b) => (itemWords(b) || 0) - (itemWords(a) || 0) || byAdded(a, b),
    author: (a, b) => (a.author || '').localeCompare(b.author || '') || (a.title || '').localeCompare(b.title || ''),
    series: (a, b) => (a.series || a.fandom || '￿').localeCompare(b.series || b.fandom || '￿') || (a.title || '').localeCompare(b.title || ''),
  };
  return list.slice().sort(sorters[state.msSort] || byAdded);
}
function msToolsHtml(all, shown) {
  const counts = new Map();
  all.forEach(x => { const g = msGroupOf(x); counts.set(g, (counts.get(g) || 0) + 1); });
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
  const active = state.msChip || state.msSearch;
  return `<div class="ms-tools">
      <input type="text" class="ms-search" id="ms-search" placeholder="Filter ${all.length} ${all[0]?.type === 'book' ? 'books' : 'fics'}…" value="${esc(state.msSearch)}" autocomplete="off" spellcheck="false" />
      <select class="ms-sort" id="ms-sort" title="Sort">${MS_SORTS.map(([k, l]) => `<option value="${k}"${state.msSort === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${chips.length > 1 ? `<div class="ms-chips">${chips.map(([g, n]) => `<button class="ms-chip${state.msChip === g ? ' on' : ''}" data-ms-chip="${esc(g)}">${esc(g)} <span class="ms-chip-n">${n}</span></button>`).join('')}${active ? `<button class="ms-chip ms-chip-clear" data-ms-chip="">✕ Clear</button>` : ''}</div>` : ''}
    ${active && shown.length !== all.length ? `<div class="ms-shown">${shown.length} of ${all.length}</div>` : ''}`;
}
// Where a book was abandoned — shown in place of the shelf for the "Dropped" zone.
function msDroppedZoneHtml() {
  return `<div class="ms-finish ms-dropzone-dropped" data-ms-drop="Dropped">
      <div class="ms-finish-icon">${icon('xCircle')}</div>
      <div class="ms-finish-ttl">Dropped</div>
      <div class="ms-finish-sub">Say where you stopped — only that part counts</div>
    </div>`;
}

function mySpaceHtml() {
  const ffs = state.items.filter(x => x.type === 'ff');
  const tbrAll = ffs.filter(x => (x.status || 'TBR') === 'TBR');
  const tbr = msApplyTools(tbrAll);
  const reading = ffs.filter(x => x.status === 'Reading' && !x.waitingOnChap);
  const waiting = ffs.filter(x => x.status === 'Reading' && x.waitingOnChap);
  const byAdded = (a, b) => (b._addedAt || 0) - (a._addedAt || 0);
  const byStarted = (a, b) => ((Date.parse(b.readingStartedAt) || 0) - (Date.parse(a.readingStartedAt) || 0)) || byAdded(a, b);
  reading.sort(byStarted); waiting.sort(byStarted);
  const body = (items, empty) => items.length ? items.map(mySpaceCard).join('') : `<div class="ms-empty">${empty}</div>`;
  return `<div class="ms-board">
    <div class="ms-col" data-ms-drop="TBR">
      <div class="ms-col-hdr"><span class="ms-col-hdr-title">${icon('inbox')}<span>To Be Read</span><span class="ms-count">${tbrAll.length}</span></span></div>
      ${msToolsHtml(tbrAll, tbr)}
      <div class="ms-col-body">${body(tbr, tbrAll.length ? 'Nothing matches this filter' : 'Your to-read fics live here')}</div>
    </div>
    <div class="ms-col ms-col-reading" data-ms-drop="Reading">
      <div class="ms-col-hdr"><span class="ms-col-hdr-title">${icon('bookOpen')}<span>Reading</span><span class="ms-count">${reading.length}</span></span></div>
      <div class="ms-col-body">${body(reading, 'Drag a fic here when you start reading — the date is logged')}</div>
    </div>
    <div class="ms-col-right">
      <div class="ms-col ms-col-waiting" data-ms-drop="Waiting">
        <div class="ms-col-hdr"><span class="ms-col-hdr-title">${icon('clock')}<span>Waiting on chapters</span><span class="ms-count">${waiting.length}</span></span></div>
        <div class="ms-col-body">${body(waiting, 'WIPs you’re caught up on — waiting for new chapters')}</div>
      </div>
      <div class="ms-finish-row">
        <div class="ms-finish" data-ms-drop="Finished">
          <div class="ms-finish-icon">${icon('checkCircle')}</div>
          <div class="ms-finish-ttl">Finished</div>
          <div class="ms-finish-sub">Drop to mark finished today and log your pace</div>
        </div>
        ${msDroppedZoneHtml()}
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
  const [c1, c2] = coverGradient(x);
  const coverIsUrl = (x.coverIcon || '').startsWith('http');
  const cover = coverIsUrl
    ? coverImgHtml('ms-shelf-img', x.coverIcon, '📚')
    : `<span class="ms-shelf-emoji">${esc(x.coverIcon) || '📚'}</span>`;
  return `<div class="ms-shelf-book" draggable="true" data-ms-id="${esc(x.id)}" title="${esc(x.title || '')}" style="${accentStyle(x)}">
    <div class="ms-shelf-cover" style="background:linear-gradient(135deg,${c1},${c2})">${cover}<button class="ms-cover-edit cover-edit-btn" data-edit-item-icon="${esc(x.id)}" draggable="false" title="Change cover">${icon('edit')}</button></div>
  </div>`;
}

function mySpaceShelfCap(x) {
  const id = esc(x.id);
  // Books that became "Reading" before start dates were recorded everywhere can have theirs set
  // by hand — the app never guesses a date it doesn't know.
  const started = x.readingStartedAt
    ? `<span class="ms-shelf-since">${icon('calendar')} ${fmtDateShort(x.readingStartedAt)} · day ${daysBetween(x.readingStartedAt, new Date().toISOString())}</span>`
    : `<button class="link-btn" data-set-start="${id}" title="When did you start this one? Needed for pace and the finish estimate">${icon('calendar')} Set start date</button>`;
  const pct = progressPct(x);
  const progress = pct !== null
    ? `<button class="ms-progress" data-progress="${id}" title="Update where you are">
         <span class="ms-progress-track"><span class="ms-progress-fill" style="width:${pct.toFixed(1)}%"></span></span>
         <span class="ms-progress-lbl">${esc(progressLabel(x))}</span>
       </button>`
    : `<button class="ms-progress ms-progress-empty" data-progress="${id}" title="Track your progress to get a finish estimate">${icon('pin')} Where are you up to?</button>`;
  const est = finishEstimate(x);
  const eta = est
    ? `<div class="ms-shelf-eta" title="${est.pace.toLocaleString()} words/day ${esc(est.basis)}${est.estimated ? ' · based on an estimated length' : ''}">${est.daysLeft === 0 ? 'Almost done' : `≈ ${est.daysLeft} day${est.daysLeft === 1 ? '' : 's'} left · done by ${fmtDateShort(est.date.toISOString())}`} <span class="ins-sub">${esc(est.basis)}</span></div>`
    : '';
  const stale = isStaleRead(x)
    ? `<div class="ms-stale">Still reading? It's been ${daysBetween(x.readingStartedAt, new Date().toISOString())} days.
         <button class="link-btn" data-ms-move="${id}|Finished">Finished it</button> · <button class="link-btn" data-ms-move="${id}|Dropped">Dropped it</button> · <button class="link-btn" data-progress="${id}">Update progress</button></div>`
    : '';
  return `<div class="ms-shelf-cap">
    <div class="ms-shelf-ttl">${esc(x.title || 'Untitled')}</div>
    <div class="ms-shelf-author">${esc(x.author || '')}</div>
    <div class="ms-shelf-meta">${started}</div>
    ${progress}
    ${eta}
    ${stale}
  </div>`;
}

function mySpaceBooksHtml() {
  const books = state.items.filter(x => x.type === 'book');
  const tbrAll = books.filter(x => (x.status || 'TBR') === 'TBR');
  const tbr = msApplyTools(tbrAll);
  const reading = books.filter(x => x.status === 'Reading');
  const byAdded = (a, b) => (b._addedAt || 0) - (a._addedAt || 0);
  const byStarted = (a, b) => ((Date.parse(b.readingStartedAt) || 0) - (Date.parse(a.readingStartedAt) || 0)) || byAdded(a, b);
  reading.sort(byStarted);
  const tbrBody = tbr.length ? tbr.map(mySpaceCard).join('') : `<div class="ms-empty">${tbrAll.length ? 'Nothing matches this filter' : 'Your to-read books live here'}</div>`;
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
         <div class="ms-shelf-empty"><div class="ms-shelf-empty-ico">${icon('bookOpen')}</div><div>Drag a book here when you start reading it</div></div>
         <div class="ms-plant ms-plant-r">${HP_PLANT}</div>
       </div>
       <div class="ms-shelf-plank"></div>`;
  return `<div class="ms-board ms-board-books">
    <div class="ms-col" data-ms-drop="TBR">
      <div class="ms-col-hdr">
        <span class="ms-col-hdr-title">${icon('inbox')}<span>To Be Read</span><span class="ms-count">${tbrAll.length}</span></span>
        <button class="ms-mood-btn" id="btn-mood-picker" title="What should I read next?">${icon('dice')} <span class="ms-mood-lbl">Pick for me</span></button>
      </div>
      ${msToolsHtml(tbrAll, tbr)}
      <div class="ms-col-body">${tbrBody}</div>
    </div>
    <div class="ms-col-right">
      <div class="ms-shelf-panel" data-ms-drop="Reading">
        <div class="ms-col-hdr ms-shelf-hdr"><span class="ms-col-hdr-title">${icon('bookOpen')}<span>Reading</span><span class="ms-count">${reading.length}</span></span></div>
        ${shelf}
      </div>
      <div class="ms-finish-row">
        <div class="ms-finish ms-finish-shelf" data-ms-drop="Finished">
          <div class="ms-finish-icon">${icon('checkCircle')}</div>
          <div class="ms-finish-ttl">Finished</div>
          <div class="ms-finish-sub">Drop to mark it finished today</div>
        </div>
        ${msDroppedZoneHtml()}
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
      if (data.chaptersPosted) { item.chaptersPosted = data.chaptersPosted; item.chaptersTotal = data.chaptersTotal || null; }
      item._modAt = new Date().toISOString();
      return { ok: true, old, new: data.words };
    }
    if (data && data.needsLogin) return { ok: false, needsLogin: true };
  } catch (e) {}
  return { ok: false };
}

// One board move = one undo entry (the item as it was), on the shared ⌘Z stack and behind the
// toast's Undo button.
function pushItemUndo(item) {
  state.folderUndoStack.push({ type: 'item', id: item.id, data: JSON.stringify(item) });
  if (state.folderUndoStack.length > FOLDER_UNDO_LIMIT) state.folderUndoStack.shift();
}
function undoItemSnapshot(id, data) {
  const idx = state.items.findIndex(x => x.id === id);
  const restored = JSON.parse(data);
  if (idx >= 0) state.items[idx] = restored; else state.items.unshift(restored);
  saveData(); render();
}
// "Finished ✓" toast with a Change-date action: move both the finish date and the read event.
function finishedToast(item, message) {
  showToast(message, 'success', { duration: 8000, action: { label: 'Change date', onClick: async () => {
    const iso = await pickDateDialog({ title: `When did you finish “${item.title}”?`, defaultIso: item.finishedAt });
    if (!iso) return;
    const dates = ensureReadDates(item);
    const idx = dates.lastIndexOf(item.finishedAt);
    if (idx >= 0) dates[idx] = iso; else if (dates.length) dates[dates.length - 1] = iso; else dates.push(iso);
    item.readDates = dates.filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).concat(dates.filter(d => !d));
    item.readCount = item.readDates.length;
    item.finishedAt = iso;
    item._modAt = new Date().toISOString();
    saveData(); render();
    showToast(`Finish date set to ${fmtDateShort(iso)} ✓`, 'success');
  } } });
}

async function moveMsCard(id, target) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;
  const now = new Date().toISOString();
  const before = JSON.stringify(item);
  const undoAction = { label: 'Undo', onClick: () => undoItemSnapshot(id, before) };
  if (target === 'TBR') {
    if (item.status === 'TBR') return;
    pushItemUndo(item);
    item.status = 'TBR'; item.waitingOnChap = false; item.readingStartedAt = null; item.progress = null;
    item._modAt = now; saveData(); render();
    showToast(`Back on the pile: “${item.title}”`, 'info', { action: undoAction });
    return;
  }
  if (target === 'Reading' || target === 'Waiting') {
    const waiting = target === 'Waiting';
    if (item.status === 'Reading' && !!item.waitingOnChap === waiting) return;
    pushItemUndo(item);
    item.status = 'Reading'; item.waitingOnChap = waiting;
    ensureReadingStart(item, now);
    item._modAt = now; saveData(); render();
    showToast(waiting ? `Waiting on chapters: “${item.title}”` : `Started reading “${item.title}” ✓`, 'success', { action: undoAction });
    return;
  }
  if (target === 'Dropped') {
    // Ask where the reading stopped — that position is what gets credited as read.
    const p = await progressDialog(item, { title: 'Where did you stop?', hint: 'Only the part you got to counts towards your words read. Skip if you don’t remember.', allowSkip: true });
    if (p === null) return; // cancelled: nothing changes
    pushItemUndo(item);
    if (p !== 'skip') item.progress = { ...p, at: now };
    item.status = 'Dropped'; item.waitingOnChap = false;
    if (!(timesRead(item) > 0)) { item.readDates = [now]; item.readCount = 1; } // the day you gave up on it
    item._modAt = now; saveData(); render();
    const pct = progressPct(item);
    showToast(pct === null ? `Dropped “${item.title}” — no words credited` : `Dropped “${item.title}” at ${Math.round(pct)}% — ${fmtNum(wordsPerRead(item))} words credited`, 'info', { action: undoAction });
    return;
  }
  if (target === 'Finished') {
    if (item.status === 'Finished' && !item.readingStartedAt) return;
    pushItemUndo(item);
    // Capture the final word count from the source so stats & pace reflect the
    // complete work you actually read (WIP counts grow while you're reading).
    showToast('Marking finished — refreshing word count…', 'loading');
    const res = await refreshWordCount(item);
    const startedAt = item.readingStartedAt;
    item.status = 'Finished'; item.waitingOnChap = false; item.finishedAt = now; item.progress = null;
    // Log this read: the first one ever, or a re-read whose start (the drag onto Reading) came
    // after the last recorded read. Before, a re-read finished on the board was never counted.
    const last = lastReadAt(item);
    const isNewRead = !(timesRead(item) > 0) || (startedAt && (!last || Date.parse(startedAt) > Date.parse(last)));
    if (isNewRead) { item.readDates = [...ensureReadDates(item), now]; item.readCount = item.readDates.length; }
    item._modAt = now;
    saveData(); render();
    let msg;
    if (res && res.ok && res.new !== res.old) msg = `Finished ✓ — word count updated ${fmtNum(res.old)} → ${fmtNum(res.new)}`;
    else if (res && res.ok) msg = 'Finished ✓ — word count already current';
    else if (res && res.needsLogin) msg = 'Finished ✓ — 🔒 locked work; use “🔑 AO3 login” then ↻ to update the count.';
    else if (res === null) msg = item.type === 'book' ? '📚 Finished ✓ — onto the read pile!' : 'Finished ✓ (add the AO3/FF.net link to auto-update word count)';
    else msg = 'Finished ✓ — couldn’t reach the link to refresh word count';
    finishedToast(item, msg);
  }
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

// Muted duotones that sit inside the paper-and-sage palette (sage, clay, dusk, plum, ochre,
// slate, rose, teal) — replacing the saturated rainbow that made the folder grid look like a
// dashboard. Still hash-stable per folder so a tile keeps its colour.
const GRADIENTS = [
  ['#7c5cff', '#4b2ee0'], // electric violet
  ['#ff5fb0', '#c8329a'], // hot pink
  ['#37c6ff', '#1f7fe0'], // sky → blue
  ['#c8f04b', '#3fb37a'], // lime → teal
  ['#ffb648', '#ff5f7e'], // sunset
  ['#8a5cff', '#ff5fb0'], // violet → pink
  ['#2fd4c2', '#2a6fe8'], // aqua → blue
  ['#ff7a59', '#ffd84d'], // coral → yellow
];

function loadFolderConfig() {
  try { return JSON.parse(localStorage.getItem('folderConfig') || '{}'); } catch { return {}; }
}
function saveFolderConfig() {
  localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig));
  saveData(); // also persist to JSON file so git backup pushes it to GitHub
}

// Undo (⌘Z / Ctrl+Z) for folder structure changes (merges, renames, deletes, creates) AND
// book series drag-and-drop moves — one shared stack, tagged by what it snapshots, so ⌘Z always
// undoes whichever of the two happened most recently rather than needing two separate shortcuts.
const FOLDER_UNDO_LIMIT = 20;
function pushFolderUndo() {
  state.folderUndoStack.push({ type: 'folder', data: JSON.stringify(state.folderConfig) });
  if (state.folderUndoStack.length > FOLDER_UNDO_LIMIT) state.folderUndoStack.shift();
}
function pushItemsUndo() {
  state.folderUndoStack.push({ type: 'items', data: JSON.stringify(state.items) });
  if (state.folderUndoStack.length > FOLDER_UNDO_LIMIT) state.folderUndoStack.shift();
}
function undoFolderChange() {
  const entry = state.folderUndoStack.pop();
  if (entry === undefined) { showToast('Nothing to undo', 'info'); return; }
  if (entry.type === 'item') {
    undoItemSnapshot(entry.id, entry.data);
    showToast('Undid last board move ↩️', 'info');
    return;
  }
  if (entry.type === 'items') {
    state.items = JSON.parse(entry.data);
    saveData();
  } else {
    state.folderConfig = JSON.parse(entry.data);
    saveFolderConfig();
  }
  render();
  showToast('Undid last folder change ↩️', 'info');
}
function getCfg(key) {
  let cfg = state.folderConfig[key];
  // A series is one thing even when its books sit under several genres, so a name/icon set on
  // "book|Romance|Fourth Wing" should also apply when the same series shows under "To Sort".
  if (!cfg) {
    const m = /^book\|[^|]+\|(.+)$/.exec(key);
    if (m) {
      const suffix = '|' + m[1];
      const alt = Object.keys(state.folderConfig).find(k => k.startsWith('book|') && k.endsWith(suffix) && k.split('|').length === 3);
      if (alt) cfg = state.folderConfig[alt];
    }
  }
  return { ...(FOLDER_DEFAULTS[key] || {}), ...(cfg || {}) };
}
function folderGradient(key) {
  key = String(key || '');
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h) ^ key.charCodeAt(i);
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

// ── Cover-derived accent colours ────────────────────────────────────────────────
// Each remote cover is sampled once (fetched via main so the canvas isn't tainted), reduced to
// one representative colour, and cached in localStorage. Cards, the shelf and the mood picker
// then use that colour instead of the id-hash gradient — a shelf that echoes the covers on it.
const COVER_COLORS_KEY = 'coverColors:v1';
let _coverColors = null;
function loadCoverColors() {
  if (_coverColors) return _coverColors;
  try { _coverColors = JSON.parse(localStorage.getItem(COVER_COLORS_KEY) || '{}'); } catch { _coverColors = {}; }
  if (!_coverColors || typeof _coverColors !== 'object') _coverColors = {};
  return _coverColors;
}
let _coverColorsSaveTimer = null;
function saveCoverColors() {
  clearTimeout(_coverColorsSaveTimer);
  _coverColorsSaveTimer = setTimeout(() => { try { localStorage.setItem(COVER_COLORS_KEY, JSON.stringify(_coverColors || {})); } catch {} }, 400);
}
function coverAccent(item) {
  const c = loadCoverColors()[item?.coverIcon || ''];
  return Array.isArray(c) && c.length === 3 ? c : null;
}
function accentStyle(item) {
  const c = coverAccent(item);
  return c ? `--accent:rgb(${c[0]},${c[1]},${c[2]});` : '';
}
// Gradient pair for a cover tile: the sampled colour → a deeper shade of it, or the hash fallback.
function coverGradient(item) {
  const c = coverAccent(item);
  if (!c) return folderGradient(item?.id || item?.title || '');
  const d = k => Math.round(k * 0.62);
  return [`rgb(${c[0]},${c[1]},${c[2]})`, `rgb(${d(c[0])},${d(c[1])},${d(c[2])})`];
}

async function sampleCoverColor(url) {
  const res = await window.api.fetchImage(url);
  if (!res || !res.ok) throw new Error(res?.error || 'fetch failed');
  const blob = new Blob([res.data], { type: res.type || 'image/jpeg' });
  const bmp = await createImageBitmap(blob);
  const W = 24, H = 24;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close?.();
  const { data } = ctx.getImageData(0, 0, W, H);
  // Saturation-weighted mean of mid-tones, so a white border or a black spine doesn't dominate.
  let r = 0, g = 0, b = 0, wsum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const R = data[i], G = data[i + 1], B = data[i + 2];
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 510;
    const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255) || 1);
    const w = 0.12 + s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.7);
    r += R * w; g += G * w; b += B * w; wsum += w;
  }
  if (!wsum) throw new Error('no pixels');
  let out = [r / wsum, g / wsum, b / wsum].map(v => Math.round(v));
  // Keep the accent usable on both light and dark surfaces.
  const lum = (0.299 * out[0] + 0.587 * out[1] + 0.114 * out[2]) / 255;
  if (lum > 0.78) out = out.map(v => Math.round(v * 0.7));
  if (lum < 0.12) out = out.map(v => Math.min(255, v + 45));
  return out;
}

let _coverQueueRunning = false;
async function runCoverColorQueue() {
  if (_coverQueueRunning || !window.api.fetchImage) return;
  _coverQueueRunning = true;
  try {
    const cache = loadCoverColors();
    const RETRY_MS = 7 * 86400000; // failed URLs are retried weekly, not on every launch
    const urls = [...new Set(state.items.map(x => x.coverIcon).filter(u => typeof u === 'string' && /^https?:\/\//.test(u)))]
      .filter(u => { const c = cache[u]; return !c || (typeof c === 'number' && Date.now() - c > RETRY_MS); });
    if (!urls.length) return;
    let done = 0;
    const worker = async () => {
      while (urls.length) {
        const url = urls.shift();
        try { cache[url] = await sampleCoverColor(url); } catch { cache[url] = Date.now(); }
        if (++done % 6 === 0) { saveCoverColors(); applyCoverAccents(); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    saveCoverColors(); applyCoverAccents();
  } finally { _coverQueueRunning = false; }
}
// Paint newly sampled colours onto whatever is on screen without a full re-render.
function applyCoverAccents() {
  const byId = new Map(state.items.map(x => [x.id, x]));
  document.querySelectorAll('.card[data-id], .ms-shelf-book[data-ms-id]').forEach(el => {
    const item = byId.get(el.dataset.id || el.dataset.msId);
    if (!item) return;
    const c = coverAccent(item);
    if (!c) return;
    el.style.setProperty('--accent', `rgb(${c[0]},${c[1]},${c[2]})`);
    const [c1, c2] = coverGradient(item);
    const tile = el.querySelector('.card-cover, .ms-shelf-cover');
    if (!tile) return;
    tile.style.setProperty('--c1', c1); tile.style.setProperty('--c2', c2);
    if (tile.classList.contains('ms-shelf-cover')) tile.style.background = `linear-gradient(135deg,${c1},${c2})`;
  });
}

// A small square icon for the reading calendar — shows the item's cover if it has one,
// otherwise a gradient tile with its type emoji, matching folder/MySpace card styling.
function calItemIconHtml(item, date) {
  const [c1, c2] = coverGradient(item);
  const coverIsUrl = (item.coverIcon || '').startsWith('http');
  const fallback = item.type === 'ff' ? '✍️' : '📚';
  const cover = coverIsUrl
    ? coverImgHtml('cal-item-img', item.coverIcon, fallback)
    : `<span class="cal-item-emoji">${esc(item.coverIcon) || fallback}</span>`;
  const status = item.status === 'Dropped' ? ' · dropped' : (item.status === 'TBR' || item.status === 'Reading') ? ` · now ${item.status}` : '';
  return `<div class="cal-item-icon${item.status === 'Dropped' ? ' cal-item-dropped' : ''}" draggable="true" style="background:linear-gradient(135deg,${c1},${c2})" data-cal-title="${esc((item.title || 'Untitled') + status)}" data-edit="${esc(item.id)}" data-cal-item-id="${esc(item.id)}" data-cal-date="${esc(date || '')}">${cover}</div>`;
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
  const iconHtml = isUrl ? coverImgHtml('fc-img', icon, '📁')
    : icon.startsWith('icon:') ? `<span class="fc-glyph">${window.icon(icon.slice(5))}</span>`
    : `<span class="fc-emoji">${esc(icon)}</span>`;
  // Draggable so tag/group folders can be dropped onto one another to nest — only real
  // tag-level ff folders qualify (not All/Untagged, not fandom tiles, not book genres).
  const isDraggable = navPath.length === 3 && navPath[0] === 'ff' && !['__all__','__untagged__'].includes(navPath[2]);
  const dragAttrs = isDraggable ? ` draggable="true" data-drag-key="${editKey}"` : '';
  // Book series folders (Books → genre → series) accept a book card dropped onto them —
  // that's how a standalone book joins a series, no editing required.
  const isSeriesFolder = navPath.length === 3 && navPath[0] === 'book';
  const dropAttrs = isSeriesFolder ? ` data-drop-series-name="${esc(navPath[2])}"` : '';
  return `<div class="folder-card${pinned?' fc-pinned':''}" data-folder-nav="${nav}"${dragAttrs}${dropAttrs}>
    <div class="fc-thumb" style="--c1:${c1};--c2:${c2}">
      ${iconHtml}
      ${pinned ? '<span class="fc-pin">📌</span>' : ''}
      <button class="fc-edit-btn" data-edit-folder="${editKey}">${window.icon('edit')} Edit</button>
    </div>
    <div class="fc-info">
      <div class="fc-name">${esc(label)}</div>
      <div class="fc-count">${count} ${count===1?'item':'items'}</div>
    </div>
  </div>`;
}

function addFolderCard(parentPath) {
  const ap = JSON.stringify(parentPath).replace(/"/g,'&quot;');
  const isSeries = parentPath[0] === 'book' && parentPath.length === 2;
  return `<div class="folder-card folder-card-add" data-add-folder="${ap}">
    <div class="fc-thumb fc-thumb-add"><span class="fc-add-plus">${icon('plus')}</span></div>
    <div class="fc-info">
      <div class="fc-name fc-add-name">${isSeries ? 'New series' : 'New folder'}</div>
      <div class="fc-count fc-add-sub">Customise</div>
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

// ── Auto tag cleanup ────────────────────────────────────────────────────────
// Runs on every launch: any trope/AU tag that isn't already sorted into a group
// folder gets checked against the existing groups (in the same fandom) for a
// meaningful word-overlap match, and gets filed in automatically if it's similar
// enough. Nothing is ever deleted or force-grouped — a tag with no good match
// just stays as its own loose folder, same as before this existed.
const TAG_CLEANUP_STOPWORDS = new Set([
  'a','an','the','and','or','of','in','on','to','for','with','at','is','are','not','be','being',
  'been','it','this','that','au','fic','&','harry potter',
]);
function decodeTagEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}
function tagCleanupWords(raw) {
  return decodeTagEntities(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !TAG_CLEANUP_STOPWORDS.has(w));
}
function tagCleanupJaccard(aWords, bWords) {
  const a = new Set(aWords), b = new Set(bWords);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  a.forEach(w => { if (b.has(w)) inter++; });
  return inter / (a.size + b.size - inter);
}
const TAG_CLEANUP_THRESHOLD = 0.2; // deliberately low/sensitive — a single solid shared word is enough

function autoGroupSimilarTags() {
  let changed = 0;
  const before = JSON.stringify(state.folderConfig);
  const byFandom = {};
  state.items.forEach(x => {
    if (x.type !== 'ff') return;
    const f = x.fandom || '__none__';
    (byFandom[f] = byFandom[f] || new Set());
    (x.tags || []).forEach(t => byFandom[f].add(t));
  });

  Object.entries(byFandom).forEach(([fandom, tagSet]) => {
    const prefix = `ff|${fandom}|`;
    const groupKeys = Object.keys(state.folderConfig).filter(k => k.startsWith(prefix) && state.folderConfig[k].isGroup);
    if (!groupKeys.length) return; // nothing to sort into yet for this fandom

    // A word that shows up in most of this fandom's tags (usually the fandom's own name/characters)
    // is noise for similarity purposes — drop it dynamically rather than hardcoding per fandom.
    const wordDocCount = {};
    tagSet.forEach(t => { new Set(tagCleanupWords(t)).forEach(w => { wordDocCount[w] = (wordDocCount[w] || 0) + 1; }); });
    const fandomStop = new Set(Object.keys(wordDocCount).filter(w => wordDocCount[w] / tagSet.size > 0.3));
    const words = raw => tagCleanupWords(raw).filter(w => !fandomStop.has(w));

    const groupedTagSet = new Set(groupKeys.flatMap(k => state.folderConfig[k].groupTags || []));
    const groupWordCache = groupKeys.map(k => {
      const cfg = state.folderConfig[k];
      const memberWords = (cfg.groupTags || []).map(words);
      return { key: k, memberWords: [words(cfg.displayName || ''), ...memberWords] };
    });

    tagSet.forEach(tag => {
      if (groupedTagSet.has(tag)) return;
      const key = prefix + tag;
      if (isPairingTag(tag, key.split('|'))) return; // ships aren't tropes — leave them alone
      const tagW = words(tag);
      if (!tagW.length) return;
      let best = null, bestScore = 0;
      groupWordCache.forEach(g => {
        g.memberWords.forEach(mw => {
          const score = tagCleanupJaccard(tagW, mw);
          if (score > bestScore) { bestScore = score; best = g.key; }
        });
      });
      if (best && bestScore >= TAG_CLEANUP_THRESHOLD) {
        const cfg = state.folderConfig[best];
        cfg.groupTags = [...(cfg.groupTags || []), tag];
        cfg._modAt = new Date().toISOString();
        groupedTagSet.add(tag);
        changed++;
      }
    });
  });

  if (changed) {
    // Snapshot BEFORE persisting so ⌘Z (or the toast's Undo) can put the folders back exactly as
    // they were — an automatic reshuffle with a deliberately low match threshold must be reversible.
    state.folderUndoStack.push({ type: 'folder', data: before });
    if (state.folderUndoStack.length > FOLDER_UNDO_LIMIT) state.folderUndoStack.shift();
    saveFolderConfig();
    showToast(`🧹 Auto-sorted ${changed} tag${changed === 1 ? '' : 's'} into existing categories`, 'info', {
      duration: 9000,
      action: { label: 'Undo', onClick: undoFolderChange },
    });
  }
  return changed;
}

// A manually-typed Pairing value like "Harry/Ginny" is a real ship name and should act as a
// tag (so it gets its own folder). AO3-style relationship-category shorthand isn't a ship.
const PAIRING_CATEGORY_WORDS = new Set(['gen','m/m','f/f','f/m','m/f','multi','other','various','none','poly']);

// Alternate names for the same character — so "Harry", "Harry Potter", "Tom", "Voldemort" etc.
// all resolve to one canonical form when comparing ships. Extend this as new fandoms come up.
const CHARACTER_ALIASES = {
  'harry': 'Harry Potter', 'harry potter': 'Harry Potter',
  'tom': 'Tom Riddle', 'tom riddle': 'Tom Riddle', 'voldemort': 'Tom Riddle',
  'lord voldemort': 'Tom Riddle', 'you-know-who': 'Tom Riddle', 'riddle': 'Tom Riddle',
  'draco': 'Draco Malfoy', 'draco malfoy': 'Draco Malfoy',
  'hermione': 'Hermione Granger', 'hermione granger': 'Hermione Granger',
  'ron': 'Ron Weasley', 'ron weasley': 'Ron Weasley',
  'ginny': 'Ginny Weasley', 'ginny weasley': 'Ginny Weasley',
  'severus': 'Severus Snape', 'severus snape': 'Severus Snape', 'snape': 'Severus Snape',
  'sirius': 'Sirius Black', 'sirius black': 'Sirius Black', 'padfoot': 'Sirius Black',
  'remus': 'Remus Lupin', 'remus lupin': 'Remus Lupin', 'moony': 'Remus Lupin', 'lupin': 'Remus Lupin',
  'james': 'James Potter', 'james potter': 'James Potter',
  'lily': 'Lily Evans', 'lily evans': 'Lily Evans', 'lily potter': 'Lily Evans',
  'neville': 'Neville Longbottom', 'neville longbottom': 'Neville Longbottom',
  'luna': 'Luna Lovegood', 'luna lovegood': 'Luna Lovegood',
  'blaise': 'Blaise Zabini', 'blaise zabini': 'Blaise Zabini',
  'pansy': 'Pansy Parkinson', 'pansy parkinson': 'Pansy Parkinson',
  'charlie': 'Charlie Weasley', 'charlie weasley': 'Charlie Weasley',
  'bill': 'Bill Weasley', 'bill weasley': 'Bill Weasley',
  'fred': 'Fred Weasley', 'fred weasley': 'Fred Weasley',
  'george': 'George Weasley', 'george weasley': 'George Weasley',
  'cedric': 'Cedric Diggory', 'cedric diggory': 'Cedric Diggory',
  'theo': 'Theodore Nott', 'theodore': 'Theodore Nott', 'theodore nott': 'Theodore Nott',
  'daphne': 'Daphne Greengrass', 'daphne greengrass': 'Daphne Greengrass',
};

// Known ship portmanteaus (no separator, so name-splitting can't parse them) mapped to the
// canonical "Name/Name" pair they stand for. Extend this list as new ship nicknames come up.
const SHIP_PORTMANTEAUS = {
  'tomarry': 'Harry Potter/Tom Riddle',
  'harrymort': 'Harry Potter/Tom Riddle',
  'drarry': 'Draco Malfoy/Harry Potter',
  'dramione': 'Draco Malfoy/Hermione Granger',
  'romione': 'Hermione Granger/Ron Weasley',
  'harmony': 'Harry Potter/Hermione Granger',
  'wolfstar': 'Remus Lupin/Sirius Black',
  'jily': 'James Potter/Lily Evans',
  'blarry': 'Blaise Zabini/Harry Potter',
  'drapansy': 'Draco Malfoy/Pansy Parkinson',
  'theodaphne': 'Daphne Greengrass/Theodore Nott',
};

function canonicalizeName(n) {
  const raw = (n || '').trim();
  if (!raw) return '';
  // AO3 exports relationship tags as "Character | Alias" (e.g. "Tom Riddle | Voldemort") —
  // try every alternative against the alias map before falling back to the first one as-is.
  const alts = raw.split('|').map(s => s.trim()).filter(Boolean);
  for (const alt of alts) {
    const hit = CHARACTER_ALIASES[alt.toLowerCase()];
    if (hit) return hit;
  }
  return alts[0] || raw;
}

// Turn a pairing string into a fandom-agnostic, order-independent key so equivalent ships
// (different name order, nicknames, or a known portmanteau) compare equal — e.g.
// "Tom Riddle/Harry Potter", "Harry/Tom", and "Tomarry" all produce the same key.
// Returns null for anything that isn't a recognizable ship (AO3 category shorthand, plain tropes).
function shipKey(raw) {
  const v = (raw || '').trim();
  if (!v || PAIRING_CATEGORY_WORDS.has(v.toLowerCase())) return null;
  const portmanteau = SHIP_PORTMANTEAUS[v.toLowerCase()];
  if (portmanteau) return portmanteau;
  if (!/\/|\s&\s/.test(v)) return null;
  const parts = [...new Set(v.split(/\s*\/\s*|\s+&\s+/).map(canonicalizeName).filter(Boolean))];
  if (parts.length < 2) return null;
  return parts.sort((a, b) => a.localeCompare(b)).join('/');
}
function isShipPairing(s) { return shipKey(s) !== null; }

// A book's genre folder is keyed on the text before " / " — if that top-level part matches an
// existing genre folder case-insensitively (typo, different casing, or an auto-filled value that
// isn't phrased the way you've been using), snap it to the existing folder's exact spelling
// instead of splintering off a near-duplicate ("Romanzo storico" vs "Romanzo Storico").
function normalizeGenre(raw) {
  const v = (raw || '').trim();
  if (!v) return v;
  const parts = v.split(' / ');
  const top = parts[0].trim();
  const existingTops = [...new Set(state.items.filter(x => x.type === 'book' && x.genre).map(x => x.genre.split(' / ')[0].trim()))];
  const match = existingTops.find(g => g.toLowerCase() === top.toLowerCase());
  if (match && match !== top) parts[0] = match;
  return parts.join(' / ');
}

function folderCrumbs(crumbs) {
  return `<div class="folder-breadcrumb">
    <span class="fcrumb" data-folder-go="[]">${icon('home')} Home</span>
    ${crumbs.map((c,i) => {
      const go = JSON.stringify(c.path).replace(/"/g,'&quot;');
      const last = i === crumbs.length-1;
      return `<span class="fcrumb-sep">${icon('chevron')}</span><span class="fcrumb${last?' fcrumb-active':''}" data-folder-go="${go}">${esc(c.label)}</span>`;
    }).join('')}
  </div>`;
}

const FOLDER_ITEM_FILTERS = [
  ['favorite', 'Favourites', x => x.favorite],
  ['TBR',      'TBR',        x => (x.status||'TBR')==='TBR'],
  ['Reading',  'Reading',    x => x.status==='Reading'],
  ['Finished', 'Finished',   x => x.status==='Finished'],
  ['Dropped',  'Dropped',    x => x.status==='Dropped'],
  ['oneshot',  'One-shots',  x => !!x.oneshot],
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
    <div id="list">${(_pendingCards = filtered.length ? filtered : null, filtered.length)
      ? ''
      : emptyStateHtml(filteredActive
          ? { icon: '🔍', title: 'Nothing matches this filter.', sub: 'Try another status, or clear the filter to see everything in this folder.', actions: [{ label: 'Clear filter', action: 'clear-folder-filter', primary: true }] }
          : { icon: '📭', title: 'Nothing here yet.', sub: state.folderPath[0] === 'book' ? 'Add a book and give it this genre or series, or drag one onto the folder.' : 'Add a fic with this tag and it will show up here.', actions: [{ label: '＋ Add an entry', action: state.folderPath[0] === 'book' ? 'add-book' : 'add-ff', primary: true }] })
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
    : `<span style="font-size:38px;line-height:1">${esc(icon) || '📁'}</span>`;
  return `<div class="folder-edit-backdrop" id="folder-edit-backdrop">
    <div class="folder-edit-modal">
      <div class="fem-header">
        <span class="fem-title">Edit folder</span>
        <button class="fem-close" id="fem-close">${icon('x')}</button>
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
  const isBookSeries = path[0]==='book' && path.length===2;
  const base = needsTag ? state.items.filter(x=>x.type==='ff'&&(path[1]==='__none__'?!x.fandom:x.fandom===path[1])) : [];
  const tagOpts = needsTag ? [...new Set(base.flatMap(x=>x.tags||[]))].sort().map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('') : '';
  return `<div class="folder-edit-backdrop" id="folder-create-backdrop">
    <div class="folder-edit-modal">
      <div class="fem-header">
        <span class="fem-title">${isBookSeries ? 'New series' : 'New folder'}</span>
        <button class="fem-close" id="fcm-close">${icon('x')}</button>
      </div>
      <div class="fem-body">
        <label class="field-label">${isBookSeries ? 'Series name' : 'Name'}</label>
        <input type="text" id="fcm-name" placeholder="${isBookSeries ? 'e.g. Harry Potter, Percy Jackson…' : 'Folder name…'}" />
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
  const [c1, c2] = coverGradient(item);
  const preview = isUrl
    ? `<img src="${esc(icon)}" style="width:100%;height:100%;object-fit:cover;border-radius:10px" />`
    : `<span style="font-size:38px;line-height:1">${esc(icon) || (isFf?'✍️':'📚')}</span>`;
  return `<div class="folder-edit-backdrop" id="item-icon-backdrop">
    <div class="folder-edit-modal">
      <div class="fem-header">
        <span class="fem-title">Cover icon</span>
        <button class="fem-close" id="iim-close">${icon('x')}</button>
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

// Prompt shown after dragging a reading-calendar icon to a different month — asks for the
// exact new date rather than silently guessing, since the drop only tells us the target month.
function calMoveModalHtml() {
  if (!state.calMoveDraft) return '';
  const { title, defaultDateStr } = state.calMoveDraft;
  return `<div class="folder-edit-backdrop" id="cal-move-backdrop">
    <div class="folder-edit-modal">
      <div class="fem-header">
        <span class="fem-title">Move reading date</span>
        <button class="fem-close" id="cal-move-close">${icon('x')}</button>
      </div>
      <div class="fem-body">
        <label class="field-label">New date read for <b>${esc(title)}</b></label>
        <input type="date" id="cal-move-date" value="${defaultDateStr}" />
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="cal-move-cancel">Cancel</button>
        <button class="btn btn-primary" id="cal-move-save">Save</button>
      </div>
    </div>
  </div>`;
}

// "What should I read next?" — pick a mood, get a random matching TBR book.
function moodPickerModalHtml() {
  if (!state.moodPickerOpen) return '';

  if (!state.moodPickerMood) {
    return `<div class="folder-edit-backdrop" id="mood-picker-backdrop">
      <div class="folder-edit-modal mood-modal">
        <div class="fem-header">
          <span class="fem-title">What are you in the mood for?</span>
          <button class="fem-close" id="mood-close">${icon('x')}</button>
        </div>
        <div class="mood-grid">
          ${MOODS.map(m => `<button class="mood-tile" data-mood="${m.key}">
            <span class="mood-emoji">${m.emoji}</span>
            <span class="mood-label">${esc(m.label)}</span>
          </button>`).join('')}
        </div>
      </div>
    </div>`;
  }

  const mood = MOODS.find(m => m.key === state.moodPickerMood);
  const book = state.items.find(x => x.id === state.moodPickerBookId);
  if (!book) {
    return `<div class="folder-edit-backdrop" id="mood-picker-backdrop">
      <div class="folder-edit-modal mood-modal">
        <div class="fem-header">
          <span class="fem-title">${mood.emoji} ${esc(mood.label)}</span>
          <button class="fem-close" id="mood-close">${icon('x')}</button>
        </div>
        <div class="mood-empty">
          <p>Nothing on your TBR shelf right now — add some books first!</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="mood-back">← Different mood</button>
        </div>
      </div>
    </div>`;
  }

  const [c1, c2] = coverGradient(book);
  const coverIsUrl = (book.coverIcon || '').startsWith('http');
  const cover = coverIsUrl
    ? coverImgHtml('mood-cover-img', book.coverIcon, '📚')
    : `<span class="mood-cover-emoji">${esc(book.coverIcon) || '📚'}</span>`;
  const wasFallback = state.moodPickerFallback;

  return `<div class="folder-edit-backdrop" id="mood-picker-backdrop">
    <div class="folder-edit-modal mood-modal">
      <div class="fem-header">
        <span class="fem-title">${mood.emoji} ${esc(mood.label)}</span>
        <button class="fem-close" id="mood-close">${icon('x')}</button>
      </div>
      ${wasFallback ? `<div class="mood-fallback-note">Nothing on your TBR quite matched this mood — here's a random pick instead.</div>` : ''}
      <div class="mood-result">
        <div class="mood-result-cover" style="--c1:${c1};--c2:${c2}">${cover}</div>
        <div class="mood-result-title">${esc(book.title)}</div>
        <div class="mood-result-author">by ${esc(book.author || '—')}${book.genre ? ' · ' + esc(book.genre) : ''}</div>
        <div class="mood-result-desc">
          ${state.moodPickerDesc === 'loading'
            ? `<span class="mood-desc-loading">Fetching a synopsis…</span>`
            : state.moodPickerDesc && state.moodPickerDesc !== 'none'
              ? `<p>${esc(state.moodPickerDesc.text)}</p><span class="mood-desc-source">via ${esc(state.moodPickerDesc.source)}</span>`
              : state.moodPickerDesc === 'none'
                ? `<span class="mood-desc-loading">No synopsis found for this one.</span>`
                : ''}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="mood-back">← Different mood</button>
        <button class="btn btn-secondary" id="mood-reroll"${state.moodPickerDesc === 'loading' ? ' disabled' : ''}>🎲 Pick another</button>
        <button class="btn btn-primary" id="mood-start-reading">📖 Start reading</button>
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
      const inGenre = sub==='__none__'
        ? state.items.filter(x=>x.type==='book'&&!x.genre)
        : state.items.filter(x=>x.type==='book'&&(x.genre||'').split(' / ')[0].trim()===sub);
      if (!tag) return inGenre.length;
      // A series folder created ahead of time (empty, via the ＋ tile) is allowed to stay open.
      if (state.folderConfig[`book|${sub}|${tag}`]?.isSeries) return 1;
      return state.items.filter(x=>x.type==='book'&&x.series===tag).length; // series span genres
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
        ${folderCard(['ff'],'icon:feather','Fanfiction',ffN)}
        ${folderCard(['book'],'icon:book','Books',bkN)}
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
    if (none.length) raw.push([['ff','__none__'],'icon:folder','Other',none.length]);
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
    const allEntry = [['ff',sub,'__all__'],'icon:layers','All',base.length];
    const tagEntries = tagSet.map(t => {
      const n = base.filter(x=>(x.tags||[]).includes(t)).length;
      return [['ff',sub,t],'icon:tag',t,n];
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
      + (untagged.length ? folderCard(['ff',sub,'__untagged__'], 'icon:tag', 'Untagged', untagged.length) : '');
    if (pairings.length) {
      gridContent += `<div class="fv-section-hdr fv-section-full"><span>Pairings</span><span class="fv-section-n">${pairings.length}</span></div>` + pairings.map(([p,e,l,c])=>folderCard(p,e,l,c)).join('');
    }
    if (tropes.length) {
      gridContent += `<div class="fv-section-hdr fv-section-full"><span>Tropes &amp; AUs</span><span class="fv-section-n">${tropes.length}</span></div>` + tropes.map(([p,e,l,c])=>folderCard(p,e,l,c)).join('');
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
        return [['ff',sub,tag,t], flatCfg.icon || 'icon:tag', flatCfg.displayName || t, n];
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
    if (none.length) raw.push([['book','__none__'],'icon:folder','Other',none.length]);
    const cards = sortedCards(filterCards(raw)).map(([p,e,l,c]) => folderCard(p,e,l,c));
    return `<div id="folder-view">
      ${folderCrumbs([{label:'Books',path:['book']}])}
      ${folderControlBar(false)}
      <div class="folder-grid">${cards.join('')}</div>
    </div>`;
  }

  // Books → genre → series list (series folders up top) + standalone items below
  if (type==='book' && sub && !tag) {
    const items = sub==='__none__'
      ? state.items.filter(x=>x.type==='book'&&!x.genre)
      : state.items.filter(x=>x.type==='book'&&(x.genre||'').split(' / ')[0].trim()===sub);
    const subLbl = getCfg(`book|${sub}`).displayName || (sub==='__none__'?'Other':sub);

    // A series folder "exists" either because at least one book already carries that series
    // name, or because it was created ahead of time (empty, via the add-folder tile) — union
    // of both keeps freshly-created empty series visible without needing a placeholder book.
    const fromItems = new Set(items.filter(x=>x.series).map(x=>x.series));
    const fromConfig = Object.keys(state.folderConfig).filter(k=>{
      const p = k.split('|');
      return state.folderConfig[k].isSeries && p.length===3 && p[0]==='book' && p[1]===sub;
    }).map(k=>k.split('|')[2]);
    const seriesNames = [...new Set([...fromItems, ...fromConfig])];
    const seriesEntries = seriesNames.map(name => {
      // Whole-series count: a series can span genres, and its folder always shows every book.
      const n = state.items.filter(x=>x.type==='book'&&x.series===name).length;
      return [['book',sub,name], 'icon:bookmark', name, n];
    });
    const standalone = items.filter(x=>!x.series);
    // Series folders are always pinned above the standalone list and are never hit by the
    // search box below — that only searches titles/authors in the flat list, not series names.
    const cards = sortedCards(seriesEntries).map(([p,e,l,c])=>folderCard(p,e,l,c));
    cards.push(addFolderCard(['book',sub]));

    return `<div id="folder-view">
      ${folderCrumbs([{label:'Books',path:['book']},{label:subLbl,path:['book',sub]}])}
      ${folderControlBar(true)}
      <div class="series-sticky-section">
        ${seriesEntries.length ? `<div class="fv-section-hdr fv-section-full"><span>Series</span><span class="fv-section-n">${seriesEntries.length}</span></div>` : ''}
        <div class="folder-grid series-grid">${cards.join('')}</div>
      </div>
      ${folderItemList(standalone)}
    </div>`;
  }

  // Books → genre → series → items. A series is a single grouping across genres: the folder
  // lists every book in it, and any book filed under a different genre gets a one-click pill
  // (rendered by cardHtml) to move it in line with the rest of the series.
  if (type==='book' && sub && tag) {
    const items = state.items.filter(x=>x.type==='book'&&x.series===tag);
    const elsewhere = sub==='__none__' ? [] : items.filter(x=>topGenre(x)!==sub);
    const subLbl = getCfg(`book|${sub}`).displayName || (sub==='__none__'?'Other':sub);
    const seriesLbl = getCfg(`book|${sub}|${tag}`).displayName || tag;
    const crossNote = elsewhere.length
      ? `<div class="series-cross-note">${elsewhere.length} of these ${items.length} books ${elsewhere.length===1?'is':'are'} filed under another genre — use the amber pill on a card to move it to <b>${esc(subLbl)}</b>.</div>`
      : '';
    return `<div id="folder-view">
      ${folderCrumbs([{label:'Books',path:['book']},{label:subLbl,path:['book',sub]},{label:seriesLbl,path:['book',sub,tag]}])}
      <div class="series-unassign-zone" id="series-unassign-zone">${icon('arrowLeft')} Drop a book here to take it out of “${esc(seriesLbl)}”</div>
      ${crossNote}
      ${folderControlBar(true)}
      ${folderItemList(items)}
    </div>`;
  }

  // A path that no longer resolves (folder deleted on the phone, stale remembered view).
  return `<div id="folder-view">${emptyStateHtml({
    icon: '🗂️', title: 'This folder isn’t here anymore',
    sub: 'It may have been renamed or emptied on another device.',
    actions: [{ label: '← Back to Home', action: 'home', primary: true }],
  })}</div>`;
}

// Shared empty-state block with optional call-to-action buttons (handled via data-empty-action).
function emptyStateHtml({ icon = '📭', title, sub = '', actions = [] }) {
  const btns = actions.map(a => `<button class="btn ${a.primary ? 'btn-primary' : 'btn-secondary'} btn-sm" data-empty-action="${esc(a.action)}">${esc(a.label)}</button>`).join('');
  return `<div class="empty">
    <div class="empty-icon">${icon}</div>
    <p>${esc(title)}</p>
    ${sub ? `<div class="empty-sub">${esc(sub)}</div>` : ''}
    ${btns ? `<div class="empty-actions">${btns}</div>` : ''}
  </div>`;
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

  const genres = getGenres();

  return `
    <div class="stat-row">
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
      <div class="search-wrap">${icon('search', 'search-ico')}<input id="search-input" type="text" placeholder="Search title, author, fandom, tag…" value="${esc(state.search)}" autocomplete="off" spellcheck="false" /></div>
      <label class="sort-wrap" title="Sort">${icon('sort')}<select class="filter-select sort-select" id="sort-select">
        <option value="added"${state.sortBy==='added'?' selected':''}>Recent (last read/added)</option>
        <option value="title"${state.sortBy==='title'?' selected':''}>A → Z</option>
        <option value="author"${state.sortBy==='author'?' selected':''}>Author A → Z</option>
        <option value="words"${state.sortBy==='words'?' selected':''}>Most words</option>
        <option value="hearts"${state.sortBy==='hearts'?' selected':''}>Most hearts</option>
        <option value="rating"${state.sortBy==='rating'?' selected':''}>My rating</option>
      </select>${icon('chevron', 'sort-chev')}</label>
    </div>

    <div class="filter-bar">
      <span class="fpill${state.filterType==='all'&&state.filterFandom==='all'&&state.filterGenre==='all'&&state.filterSection==='all'?' active':''}" data-type="all">All</span>
      <div class="dd${(state.filterType==='ff'||state.filterType==='oneshot'||state.filterFandom!=='all')?' dd-on':''}">
        <button class="dd-btn" aria-haspopup="menu" aria-expanded="false">${icon('feather')} Fanfiction <span class="dd-chev">${icon('chevron')}</span></button>
        <div class="dd-menu" role="menu">
          <div class="dd-item${state.filterType==='ff'?' sel':''}" role="menuitem" tabindex="0" data-type="ff">All fanfiction</div>
          <div class="dd-item${state.filterType==='oneshot'?' sel':''}" role="menuitem" tabindex="0" data-type="oneshot">One-shots</div>
          ${fandoms.length ? '<div class="dd-sep"></div>' : ''}
          ${fandoms.map(f => `<div class="dd-item${state.filterFandom===f?' sel':''}" role="menuitem" tabindex="0" data-fandom="${esc(f)}">${esc(f)}</div>`).join('')}
        </div>
      </div>
      <div class="dd${(state.filterType==='book'||state.filterGenre!=='all')?' dd-on':''}">
        <button class="dd-btn" aria-haspopup="menu" aria-expanded="false">${icon('book')} Books <span class="dd-chev">${icon('chevron')}</span></button>
        <div class="dd-menu" role="menu">
          <div class="dd-item${state.filterType==='book'?' sel':''}" role="menuitem" tabindex="0" data-type="book">All books</div>
          ${genres.length ? '<div class="dd-sep"></div>' : ''}
          ${genres.map(g => `<div class="dd-item${state.filterGenre===g?' sel':''}" role="menuitem" tabindex="0" data-genre="${esc(g)}">${esc(g)}</div>`).join('')}
        </div>
      </div>
      <span class="fpill fpill-fav${state.filterFavorite ? ' active-fav' : ''}" data-fav-filter="true">${icon('star')} Favourites</span>
    </div>

    ${state.filterFandom !== 'all' ? (() => {
      const fandomTags = getTagsForFandom();
      if (!fandomTags.length) return '';
      const opts = fandomTags.map(t =>
        `<option value="${esc(t)}"${state.filterTag === t ? ' selected' : ''}>${esc(t)}</option>`
      ).join('');
      return `<div class="tag-filter-row">
        <span class="tag-filter-label">Tag:</span>
        <select class="filter-select" id="tag-filter-select">
          <option value="all"${state.filterTag === 'all' ? ' selected' : ''}>All tags</option>
          ${opts}
        </select>
      </div>`;
    })() : ''}

    <div id="results-meta">${filtered.length} ${filtered.length===1?'entry':'entries'}${state.search ? ` matching "<b>${esc(state.search)}</b>"` : ''}</div>

    <div id="list">
      ${(_pendingCards = filtered.length ? filtered : null, filtered.length !== 0) ? '' : (state.search
            ? emptyStateHtml({ icon: '🔍', title: `No matches for “${state.search}”`, sub: 'Search looks at titles, authors, fandoms, genres, series and tags — accents and case don’t matter.', actions: [{ label: 'Clear search', action: 'clear-search', primary: true }, { label: '＋ Add it as a new entry', action: 'add' }] })
            : (state.items.length
                ? emptyStateHtml({ icon: '🗂️', title: 'Nothing matches these filters.', sub: 'Clear the status or type filter to see the whole library.', actions: [{ label: 'Show everything', action: 'clear-search', primary: true }] })
                : emptyStateHtml({ icon: '📚', title: 'Your library is empty.', sub: 'Paste an AO3 or FF.net link to add a fic with all its details filled in, or add a book and let Auto-fill find the cover and synopsis.', actions: [{ label: '＋ Add a fic', action: 'add-ff', primary: true }, { label: '＋ Add a book', action: 'add-book' }] })))}
    </div>
  `;
}

// Shown instead of the library when the data file exists but can't be parsed. Nothing is
// written to disk while this is up, so the broken file (and its .bak / dated snapshots in the
// same folder) stay exactly as they are for recovery.
function recoveryPanelHtml() {
  const err = state.loadError || {};
  return `<div id="recovery-panel">
    <div class="recovery-card">
      <div class="recovery-icon">🛟</div>
      <h2>Your library file couldn't be read</h2>
      <p>The app found <code>${esc(err.path || 'library-data.json')}</code> but it isn't valid JSON, and no readable backup copy was found next to it.</p>
      <p>Nothing has been changed or overwritten. Your entries are still in that file — it most likely just needs the last few characters repaired, or you can restore <code>library-data.json.bak</code> or a dated copy from the <code>backups</code> folder.</p>
      <div class="recovery-actions">
        <button class="btn btn-primary" id="recovery-open-folder">${icon('folder')} Open data folder</button>
        <button class="btn btn-secondary" id="recovery-retry">${icon('refresh')} Try again</button>
      </div>
    </div>
  </div>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
let _lastViewKey = null;
// viewKey → last scrollTop, so leaving a view and coming back lands where you were.
const _scrollMemory = new Map();
// "Back" = the new view is an ancestor of the one just left: a shallower folder path, the library
// after Stats, or the folders after the board. Filters/search changes are not "back".
function isBackNavigation(prevKey, nextKey) {
  if (!prevKey || prevKey === nextKey) return false;
  const p = prevKey.split('|'), n = nextKey.split('|');
  const [pView, pMode, pPath] = p, [nView, nMode, nPath] = n;
  if (pView === 'stats' && nView !== 'stats') return true;
  if (pMode === 'myspace' && nMode === 'folder') return true;
  if (pMode === 'folder' && nMode === 'folder' && pPath !== nPath && (nPath === '' || pPath.startsWith(nPath + '/'))) return true;
  return false;
}
function render() {
  document.querySelectorAll('.cal-tooltip').forEach(t => t.remove()); // avoid an orphaned tooltip surviving a re-render mid-hover
  persistUiState();
  // Replay the card entrance only when the view itself changes (first paint, navigating into a
  // folder, switching pages) — not on every in-place state change like a star or status click.
  const viewKey = `${state.view}|${state.viewMode}|${state.folderPath.join('/')}|${state.mySpaceTab}|${state.search}|${state.filterStatus}|${state.filterType}|${state.filterFandom}|${state.filterGenre}|${state.filterTag}|${state.filterFavorite}|${state.folderItemFilter}|${state.folderSearch}`;
  const sameView = viewKey === _lastViewKey;
  const prevKey = _lastViewKey;
  document.body.classList.toggle('settled', sameView);
  _lastViewKey = viewKey;
  if (state.loadError) {
    document.getElementById('app').innerHTML = recoveryPanelHtml();
    document.getElementById('recovery-open-folder')?.addEventListener('click', () => window.api.openDataFolder());
    document.getElementById('recovery-retry')?.addEventListener('click', () => location.reload());
    return;
  }
  // Scroll memory. Same-view re-renders (delete, undo, add, status change) keep their position.
  // Going *back* — out of a folder, out of Stats, off the board — returns to where you were in
  // the view you left. Going forward into a new view starts at the top.
  const curScroller = document.getElementById('folder-view') || document.getElementById('list') || document.getElementById('stats-view') || document.getElementById('myspace-page');
  if (prevKey && curScroller) _scrollMemory.set(prevKey, curScroller.scrollTop);
  const scrollTop = sameView ? (curScroller ? curScroller.scrollTop : 0)
    : (isBackNavigation(prevKey, viewKey) ? (_scrollMemory.get(viewKey) || 0) : 0);
  const folderScrollTop = scrollTop;
  const stats = getStats();

  const titlebarHtml = `
    <div id="titlebar">
      <div>
        <div id="titlebar-title">My Library${state.readOnly ? ' <span class="badge badge-Dropped" title="Nothing is being saved to disk">read-only</span>' : ''}</div>
        <div class="subtitle" title="${stats.hasEstimates ? `About ${Math.round(stats.estimatedWords / stats.totalWords * 100)}% of this figure is estimated (imported counts or pages × ${WORDS_PER_PAGE}). Dropped items add no words.` : 'Words across every finished read'}">${stats.ff} fics · ${stats.books} books · ${stats.hasEstimates ? '≈' : ''}${stats.totalWords.toLocaleString()} words read</div>
      </div>
      <div id="titlebar-actions">
        <div class="dd">
          <button class="btn btn-ghost btn-sm dd-btn" aria-haspopup="menu" aria-expanded="false">${icon('sliders')} Settings <span class="dd-chev">${icon('chevron')}</span></button>
          <div class="dd-menu dd-menu-right" role="menu">
            <div class="dd-item" role="menuitem" tabindex="0" id="btn-export">Export to Excel…</div>
            <div class="dd-item" role="menuitem" tabindex="0" id="btn-data-folder">Open data folder</div>
            <div class="dd-item" role="menuitem" tabindex="0" id="btn-ao3-login">Log in to AO3…</div>
            <div class="dd-item" role="menuitem" tabindex="0" id="btn-sync">Sync from GitHub</div>
            <div class="dd-sep"></div>
            <div class="dd-item" role="menuitem" tabindex="0" id="btn-settings">Page banners…</div>
            <div class="dd-item" role="menuitem" tabindex="0" id="btn-relink" title="Find linked PDFs/EPUBs that were moved or renamed inside their folder">Relink moved files…</div>
            <div class="dd-item dd-item-toggle" role="menuitem" tabindex="0" id="btn-density" title="Switch between comfortable and compact cards"><span>Density</span><span class="dd-val">${state.density === 'compact' ? 'Compact' : 'Comfortable'}</span></div>
          </div>
        </div>
        <button class="btn btn-tint btn-tint-sky btn-sm${state.view === 'stats' ? ' is-on' : ''}" id="btn-stats" title="${state.view === 'stats' ? 'Back to the library' : 'Reading statistics'}">${icon(state.view === 'stats' ? 'book' : 'chart')} ${state.view === 'stats' ? 'Library' : 'Stats'}</button>
        <button class="btn btn-tint btn-tint-lilac btn-sm${state.view !== 'stats' && state.viewMode === 'myspace' ? ' is-on' : ''}" id="btn-view-myspace" title="${state.view !== 'stats' && state.viewMode === 'myspace' ? 'Back to the library' : 'Reading board — TBR, Reading, Finished'}">${icon('layers')} Board</button>
        <button class="btn btn-ghost btn-sm" id="btn-backup" title="Back up — merge the GitHub copy in, then save everything to GitHub"><span class="btn-ico">${icon('cloud')}</span><span class="btn-lbl">Back up</span></button>
        <button class="btn btn-primary btn-sm" id="btn-add">${icon('plus')} Add entry</button>
      </div>
    </div>`;

  // A persistent (dismissable) notice beats a toast here — "your main file was damaged and this
  // is a restored copy" must not be pushed off-screen by the next routine toast.
  const noticeHtml = state.recoveredFrom ? `
    <div class="notice-bar" role="alert">
      <span class="notice-icon">🛟</span>
      <span class="notice-msg">Your main library file was missing or unreadable, so this library was restored from <b>${esc(state.recoveredFrom)}</b>. Everything you change from now on is saved normally. If anything looks out of date, check the <b>backups</b> folder.</span>
      <button class="btn btn-secondary btn-sm" id="notice-open-folder">${icon('folder')} Open folder</button>
      <button class="notice-close" id="notice-dismiss" title="Dismiss">${icon('x')}</button>
    </div>` : '';
  const titlebarHtmlWithNotice = titlebarHtml + noticeHtml;

  if (state.view === 'stats') {
    document.getElementById('app').innerHTML = titlebarHtmlWithNotice + statsViewHtml() + (state.modalOpen ? modalHtml() : '') + settingsModalHtml() + calMoveModalHtml();
    const newScrollable = document.getElementById('stats-view');
    if (newScrollable) newScrollable.scrollTop = scrollTop;
    bindEvents();
    return;
  }

  if (state.viewMode === 'folder') {
    document.getElementById('app').innerHTML = titlebarHtmlWithNotice + folderViewHtml() + folderEditModalHtml() + folderCreateModalHtml() + itemIconModalHtml() + (state.modalOpen ? modalHtml() : '') + settingsModalHtml();
    const newFolderView = document.getElementById('folder-view');
    mountPendingCards(newFolderView, folderScrollTop);
    if (newFolderView) newFolderView.scrollTop = folderScrollTop;
    bindEvents();
    return;
  }

  if (state.viewMode === 'myspace') {
    const msTab = state.mySpaceTab === 'books' ? 'books' : 'ff';
    document.getElementById('app').innerHTML = titlebarHtmlWithNotice +
      `<div id="myspace-page">
        <div class="ms-tabs">
          <button class="ms-tab${msTab==='ff'?' active':''}" data-ms-tab="ff">${icon('feather')} Fanfiction</button>
          <button class="ms-tab${msTab==='books'?' active':''}" data-ms-tab="books">${icon('book')} Books</button>
        </div>
        ${msTab==='books' ? mySpaceBooksHtml() : mySpaceHtml()}
      </div>` +
      (state.modalOpen ? modalHtml() : '') + itemIconModalHtml() + settingsModalHtml() + moodPickerModalHtml();
    const msPage = document.getElementById('myspace-page');
    if (msPage && scrollTop) msPage.scrollTop = scrollTop;
    bindEvents();
    return;
  }

  document.getElementById('app').innerHTML = titlebarHtmlWithNotice + listViewContentHtml() + `
    ${state.modalOpen ? modalHtml() : ''}
    ${itemIconModalHtml()}
    ${settingsModalHtml()}
    ${moodPickerModalHtml()}
  `;

  mountPendingCards(document.getElementById('list'), scrollTop);
  bindEvents();
}

// ── Card list: chunked mounting + per-card patching ─────────────────────────────
// 958 cards is ~19k DOM nodes; committing and laying them out in one go cost ~1.2 s on every
// render. Cards are now streamed in chunks (first chunk synchronously, the rest one chunk per
// frame behind a height spacer so the scrollbar doesn't jump), and single-item changes replace
// just that card instead of re-rendering the page.
let _pendingCards = null, _mountToken = 0;
const CARD_CHUNK = 48;
function mountPendingCards(scroller, restoreTop) {
  const items = _pendingCards; _pendingCards = null;
  const listEl = document.getElementById('list');
  if (!listEl || !items || !items.length) return;
  const token = ++_mountToken;
  let i = 0;
  const append = () => {
    const tpl = document.createElement('template');
    tpl.innerHTML = items.slice(i, i + CARD_CHUNK).map(cardHtml).join('');
    listEl.appendChild(tpl.content);
    i = Math.min(items.length, i + CARD_CHUNK);
  };
  append();
  const avg = Math.max(60, listEl.scrollHeight / Math.max(1, i));
  const spacer = () => { listEl.style.paddingBottom = i < items.length ? `${Math.round(40 + (items.length - i) * avg)}px` : ''; };
  spacer();
  if (restoreTop > 0 && scroller) {
    // Fill up to the saved position so the restored scroll lands on real cards, not the spacer.
    while (i < items.length && scroller.scrollHeight - (parseFloat(listEl.style.paddingBottom) || 0) < restoreTop + scroller.clientHeight) { append(); spacer(); }
    scroller.scrollTop = restoreTop;
  }
  const more = () => {
    if (token !== _mountToken || !listEl.isConnected) return;
    if (i >= items.length) { spacer(); applyCoverAccents(); return; }
    append(); spacer();
    requestAnimationFrame(more);
  };
  if (i < items.length) requestAnimationFrame(more);
}
// Replace the DOM for just these items (used after a star, favourite, status or read change).
function patchCards(ids) {
  let stale = false;
  for (const id of ids) {
    const el = document.querySelector(`.card[data-id="${CSS.escape(String(id))}"]`);
    const item = state.items.find(x => x.id === id);
    if (!el) continue;                       // card not on screen (or not mounted yet) — nothing to patch
    if (!item) { el.remove(); continue; }
    const tpl = document.createElement('template');
    tpl.innerHTML = cardHtml(item).trim();
    const fresh = tpl.content.firstElementChild;
    if (fresh) el.replaceWith(fresh); else stale = true;
  }
  if (stale) render();
}
// Titlebar subtitle and status pills, recomputed without a full render.
function refreshChrome() {
  const stats = getStats();
  const sub = document.querySelector('#titlebar .subtitle');
  if (sub) sub.textContent = `${stats.ff} fics · ${stats.books} books · ${stats.hasEstimates ? '≈' : ''}${stats.totalWords.toLocaleString()} words read`;
  const set = (sel, v) => { const n = document.querySelector(sel); if (n) n.textContent = v; };
  set('.stat-num.tbr', stats.tbr); set('.stat-num.reading', stats.reading); set('.stat-num.finished', stats.finished); set('.stat-num.dropped', stats.dropped);
}
// After an item changed: patch in place when the list's membership can't have changed, else re-render.
function afterItemChange(ids) {
  const listView = state.view === 'library' && (state.viewMode === 'list' || (state.viewMode === 'folder' && state.folderPath.length === 0));
  const membershipSensitive = state.filterStatus !== 'all' || state.filterFavorite;
  if (listView && !membershipSensitive && document.getElementById('list')) { patchCards(ids); refreshChrome(); }
  else render();
}
function updateItem(id, mutate) {
  const idx = state.items.findIndex(x => x.id === id);
  if (idx < 0) return null;
  const now = new Date().toISOString();
  const next = mutate({ ...state.items[idx] }, now);
  if (!next) return null;
  next._modAt = now;
  state.items[idx] = next;
  return next;
}
function toggleExpand(id) {
  const prev = state.expandedId;
  state.expandedId = prev === id ? null : id;
  if (document.getElementById('list')) patchCards([...new Set([prev, id].filter(Boolean))]); else render();
}
function toggleFavourite(id) {
  if (updateItem(id, x => ({ ...x, favorite: !x.favorite }))) { saveData(); afterItemChange([id]); }
}
function rateItem(id, val) {
  if (!Number.isFinite(val)) return;
  if (updateItem(id, x => ({ ...x, userRating: x.userRating === val ? 0 : val }))) { saveData(); afterItemChange([id]); }
}
function stepReread(id, delta) {
  const it = updateItem(id, x => {
    const dates = ensureReadDates(x);
    if (delta > 0) dates.push(new Date().toISOString());  // "I re-read this" — today
    else if (dates.length) dates.pop();                    // drop the most recent read (list is chronological)
    return { ...x, readDates: dates, readCount: dates.length };
  });
  if (it) { saveData(); afterItemChange([id]); }
}
async function setItemStatus(id, status) {
  if (!STATUS.includes(status)) return;
  const current = state.items.find(x => x.id === id);
  if (!current || current.status === status) return;
  // Dropping asks where you stopped (skippable) — that position is what gets credited.
  let dropProgress;
  if (status === 'Dropped') {
    dropProgress = await progressDialog(current, { title: 'Where did you stop?', hint: 'Only the part you got to counts towards your words read. Skip if you don’t remember.', allowSkip: true });
    if (dropProgress === null) return;
  }
  const it = updateItem(id, (x, now) => {
    const update = { ...x, status };
    if (status === 'Reading') ensureReadingStart(update, now);
    if (status === 'TBR') { update.readingStartedAt = null; update.progress = null; update.waitingOnChap = false; }
    if (status === 'Dropped') {
      if (dropProgress && dropProgress !== 'skip') update.progress = { ...dropProgress, at: now };
      if (!(timesRead(x) > 0)) { update.readDates = [now]; update.readCount = 1; }
    }
    if (status === 'Finished') {
      update.progress = null;
      if (!x.finishedAt) update.finishedAt = now;
      // Finished means "read at least once" — and readDates is what the stats trust. A re-read
      // started on the board (readingStartedAt after the last read) is a new read too.
      const last = lastReadAt(x);
      const isNewRead = !(timesRead(x) > 0) || (x.readingStartedAt && (!last || Date.parse(x.readingStartedAt) > Date.parse(last)));
      if (isNewRead) {
        const when = timesRead(x) > 0 ? now : update.finishedAt;
        update.readDates = [...ensureReadDates(x), when]; update.readCount = update.readDates.length; update.finishedAt = when;
      }
    }
    return update;
  });
  if (it) { saveData(); afterItemChange([id]); }
}
// Record when a book on the shelf was started (for books that predate automatic start dates).
async function setStartDateFor(id) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;
  const iso = await pickDateDialog({ title: `When did you start “${item.title}”?`, defaultIso: item.readingStartedAt || item._modAt || null });
  if (!iso) return;
  pushItemUndo(item);
  item.readingStartedAt = iso;
  item._modAt = new Date().toISOString();
  saveData(); render();
  showToast(`Started ${fmtDateShort(iso)} ✓`, 'success');
}
// Set (or update) where you are in a book — from the shelf, a card, or the stale-read nudge.
async function updateProgressFor(id) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;
  const p = await progressDialog(item, { title: item.status === 'Dropped' ? 'Where did you stop?' : 'Where are you up to?' });
  if (!p || p === 'skip') return;
  const now = new Date().toISOString();
  pushItemUndo(item);
  item.progress = { ...p, at: now };
  item._modAt = now;
  saveData();
  if (state.viewMode === 'myspace' || state.view === 'stats') render(); else afterItemChange([id]);
  const pct = progressPct(item);
  if (item.status === 'Reading' && pct !== null && pct >= 100) {
    showToast('That’s the end — mark it finished?', 'info', { duration: 8000, action: { label: 'Finished ✓', onClick: () => moveMsCard(id, 'Finished') } });
  }
}
function refileToGenre(id, target) {
  const item = state.items.find(x => x.id === id);
  if (!item || !target) return;
  pushItemsUndo();
  const parts = (item.genre || '').split(' / ').map(s => s.trim()).filter(Boolean);
  if (parts.length) parts[0] = target; else parts.push(target);
  item.genre = parts.join(' / ');
  item._modAt = new Date().toISOString();
  saveData(); render();
  showToast(`Moved “${item.title}” to ${target} — ⌘Z to undo`, 'success');
}
async function deleteItemFlow(id) {
  const item = state.items.find(x => x.id === id);
  if (!item) return;
  const ok = await confirmDialog({
    title: 'Delete this entry?',
    message: `“${item.title || 'Untitled'}” will be removed from your library.`,
    confirmLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  const idx = state.items.indexOf(item);
  state.items = state.items.filter(x => x.id !== id);
  state.deletedIds = { ...state.deletedIds, [id]: new Date().toISOString() };
  saveData(); render();
  showToast(`Deleted “${item.title || 'Untitled'}”`, 'info', {
    duration: 7000,
    action: { label: 'Undo', onClick: () => {
      if (state.items.some(x => x.id === id)) return;
      const restored = [...state.items];
      restored.splice(Math.min(idx, restored.length), 0, item);
      state.items = restored;
      const { [id]: _dropped, ...rest } = state.deletedIds;
      state.deletedIds = rest;
      saveData(); render();
    } },
  });
}
async function openLocalFor(id) {
  const item = state.items.find(x => x.id === id);
  if (!item?.localFile) return;
  if (state.missingFiles[item.localFile]) { relinkLocalFile(item); return; }
  const res = await window.api.openLocalFile(item.localFile);
  if (res?.error) {
    state.missingFiles = { ...state.missingFiles, [item.localFile]: true };
    patchCards([id]);
    showToast(res.error, 'error', { duration: 8000, action: { label: 'Locate…', onClick: () => relinkLocalFile(item) } });
  }
}
async function refreshWordsFor(btn) {
  const item = state.items.find(x => x.id === btn.dataset.refreshWords);
  if (!item) return;
  btn.textContent = '…'; btn.disabled = true;
  showToast('Refreshing word count…', 'loading');
  const res = await refreshWordCount(item);
  if (res && res.ok && res.new !== res.old) { saveData(); afterItemChange([item.id]); showToast(`${item.title || 'Fic'}: ${fmtNum(res.old)} → ${fmtNum(res.new)} words`, 'success'); return; }
  if (res && res.ok) showToast('Word count already up to date ✓', 'success');
  else if (res && res.needsLogin) showToast('🔒 Locked work — use “🔑 AO3 login” (Settings), then retry.', 'info');
  else showToast('Couldn’t refresh — check the link.', 'error');
  btn.innerHTML = icon('refresh'); btn.disabled = false;
}

// ── Card actions: one delegated listener for the whole app ─────────────────────
// Cards are mounted in chunks and patched individually, so their handlers can't be bound per
// element at render time. Every card control is resolved here from the click target, most
// specific first, so a click on ⭐ never also toggles the card open.
let _dragItemId = null;
function initCardDelegation() {
  document.addEventListener('click', async e => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const hit = sel => t.closest(sel);
    let el;
    if ((el = hit('[data-toggle-fav]'))) { e.stopPropagation(); toggleFavourite(el.dataset.toggleFav); return; }
    if ((el = hit('[data-open-url]'))) { e.stopPropagation(); const res = await window.api.openExternal(el.dataset.openUrl); if (res?.error) showToast(res.error, 'error'); return; }
    if ((el = hit('[data-open-local]'))) { e.stopPropagation(); openLocalFor(el.dataset.openLocal); return; }
    if ((el = hit('[data-refresh-words]'))) { e.stopPropagation(); refreshWordsFor(el); return; }
    if ((el = hit('[data-delete]'))) { e.stopPropagation(); deleteItemFlow(el.dataset.delete); return; }
    if ((el = hit('[data-edit]'))) { e.stopPropagation(); const item = state.items.find(x => x.id === el.dataset.edit); if (item) { state.editItem = { ...item }; state.modalOpen = true; render(); } return; }
    if ((el = hit('.cover-edit-btn'))) { e.stopPropagation(); state.editingItemIcon = el.dataset.editItemIcon; render(); return; }
    if ((el = hit('[data-set-status]'))) { e.stopPropagation(); setItemStatus(el.dataset.id, el.dataset.setStatus); return; }
    if ((el = hit('[data-reread-delta]'))) { e.stopPropagation(); if (!el.disabled) stepReread(el.dataset.rereadId, parseInt(el.dataset.rereadDelta, 10)); return; }
    if ((el = hit('.stars:not(.readonly) .star'))) { e.stopPropagation(); rateItem(el.dataset.id, parseInt(el.dataset.val, 10)); return; }
    if ((el = hit('[data-refile]'))) { e.stopPropagation(); refileToGenre(el.dataset.refile, el.dataset.refileGenre); return; }
    if ((el = hit('[data-progress]'))) { e.stopPropagation(); updateProgressFor(el.dataset.progress); return; }
    if ((el = hit('[data-set-start]'))) { e.stopPropagation(); setStartDateFor(el.dataset.setStart); return; }
    if ((el = hit('[data-ms-move]'))) { e.stopPropagation(); const [id, target] = el.dataset.msMove.split('|'); moveMsCard(id, target); return; }
    if ((el = hit('[data-expand]'))) { toggleExpand(el.dataset.expand); return; }
  });
  // Star hover preview (mouseover/mouseout bubble; mouseenter/leave don't)
  document.addEventListener('mouseover', e => {
    const star = e.target instanceof Element && e.target.closest('.stars:not(.readonly) .star');
    if (!star) return;
    const val = parseInt(star.dataset.val, 10);
    star.closest('.stars').querySelectorAll('.star').forEach((s, i) => s.classList.toggle('lit', i < val));
  });
  document.addEventListener('mouseout', e => {
    const star = e.target instanceof Element && e.target.closest('.stars:not(.readonly) .star');
    if (!star) return;
    const wrap = star.closest('.stars');
    if (e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget)) return;
    const item = state.items.find(x => x.id === star.dataset.id);
    wrap.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('lit', i < (item?.userRating || 0)));
  });
}

// ── Progress dialog: page / chapter / percent ─────────────────────────────────────
// Resolves to { unit, value, total } · 'skip' (allowSkip only) · null (cancelled).
function progressDialog(item, { title = 'Where are you up to?', hint = '', allowSkip = false } = {}) {
  return new Promise(resolve => {
    document.getElementById('progress-backdrop')?.remove();
    const cur = item.progress || {};
    const unit = cur.unit || (item.type === 'book' ? (item.pages ? 'page' : 'percent') : (item.chaptersTotal || item.chaptersPosted ? 'chapter' : 'percent'));
    const total = cur.total || (unit === 'page' ? item.pages : unit === 'chapter' ? (item.chaptersTotal || item.chaptersPosted) : null) || '';
    const wrap = document.createElement('div');
    wrap.id = 'progress-backdrop';
    wrap.className = 'folder-edit-backdrop confirm-backdrop';
    wrap.innerHTML = `
      <div class="folder-edit-modal confirm-modal progress-modal" role="dialog" aria-modal="true">
        <div class="confirm-body">
          <div class="confirm-title">${esc(title)}</div>
          <div class="confirm-msg progress-book">${esc(item.title || 'Untitled')}${item.author ? ` <span class="ins-sub">· ${esc(item.author)}</span>` : ''}</div>
          ${hint ? `<p class="confirm-msg">${esc(hint)}</p>` : ''}
          <div class="progress-fields">
            <select id="pg-unit" class="filter-select">
              <option value="page"${unit === 'page' ? ' selected' : ''}>Page</option>
              <option value="chapter"${unit === 'chapter' ? ' selected' : ''}>Chapter</option>
              <option value="percent"${unit === 'percent' ? ' selected' : ''}>Percent</option>
            </select>
            <input type="number" id="pg-value" min="0" step="1" placeholder="${unit === 'percent' ? '0–100' : 'where you are'}" value="${cur.value ?? ''}" />
            <span class="progress-of" id="pg-of">${unit === 'percent' ? '%' : 'of'}</span>
            <input type="number" id="pg-total" min="1" step="1" placeholder="${unit === 'page' ? 'pages' : 'chapters'}" value="${esc(total)}"${unit === 'percent' ? ' hidden' : ''} />
          </div>
          <div class="progress-quick">${[10, 25, 50, 75, 90].map(q => `<button class="ms-chip" data-pg-quick="${q}">${q}%</button>`).join('')}</div>
          <div class="field-hint-err" id="pg-err" hidden></div>
        </div>
        <div class="modal-footer confirm-footer">
          ${allowSkip ? `<button class="btn btn-secondary" data-pg="skip" title="Drop it without recording where you stopped">Skip</button>` : ''}
          <button class="btn btn-secondary" data-pg="cancel">Cancel</button>
          <button class="btn btn-primary" data-pg="save">Save</button>
        </div>
      </div>`;
    const $ = sel => wrap.querySelector(sel);
    const syncUnit = () => {
      const u = $('#pg-unit').value;
      $('#pg-total').hidden = u === 'percent';
      $('#pg-of').textContent = u === 'percent' ? '%' : 'of';
      $('#pg-value').placeholder = u === 'percent' ? '0–100' : 'where you are';
      if (u !== 'percent' && !$('#pg-total').value) $('#pg-total').value = (u === 'page' ? item.pages : (item.chaptersTotal || item.chaptersPosted)) || '';
      $('#pg-total').placeholder = u === 'page' ? 'pages' : 'chapters';
    };
    const finish = result => { document.removeEventListener('keydown', onKey, true); wrap.classList.add('confirm-out'); setTimeout(() => wrap.remove(), 160); resolve(result); };
    const save = () => {
      const u = $('#pg-unit').value;
      const value = parseFloat($('#pg-value').value);
      const totalV = u === 'percent' ? 100 : parseFloat($('#pg-total').value);
      const err = $('#pg-err');
      if (!(value >= 0)) { err.textContent = 'Enter where you are.'; err.hidden = false; $('#pg-value').classList.add('field-invalid'); return; }
      if (!(totalV > 0)) { err.textContent = u === 'page' ? 'How many pages does it have?' : 'How many chapters does it have?'; err.hidden = false; $('#pg-total').classList.add('field-invalid'); return; }
      if (value > totalV) { err.textContent = `That’s past the end (${totalV}).`; err.hidden = false; $('#pg-value').classList.add('field-invalid'); return; }
      finish({ unit: u, value: Math.round(value), total: u === 'percent' ? null : Math.round(totalV) });
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(null); }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); save(); }
    };
    document.addEventListener('keydown', onKey, true);
    $('#pg-unit').addEventListener('change', syncUnit);
    wrap.querySelectorAll('[data-pg-quick]').forEach(b => b.addEventListener('click', () => { $('#pg-unit').value = 'percent'; syncUnit(); $('#pg-value').value = b.dataset.pgQuick; }));
    wrap.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.pg; if (k === 'save') save(); else finish(k === 'skip' ? 'skip' : null); }));
    wrap.addEventListener('click', e => { if (e.target === wrap) finish(null); });
    document.body.appendChild(wrap);
    $('#pg-value').focus(); $('#pg-value').select();
  });
}

// ── Date dialog (used by "Change date" on the Finished toast) ────────────────────
function pickDateDialog({ title = 'Pick a date', defaultIso = null } = {}) {
  return new Promise(resolve => {
    document.getElementById('date-backdrop')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'date-backdrop';
    wrap.className = 'folder-edit-backdrop confirm-backdrop';
    wrap.innerHTML = `
      <div class="folder-edit-modal confirm-modal" role="dialog" aria-modal="true">
        <div class="confirm-body">
          <div class="confirm-title">${esc(title)}</div>
          <input type="date" id="pd-date" value="${toDateInputValue(defaultIso || new Date().toISOString())}" max="${toDateInputValue(new Date().toISOString())}" style="margin-top:12px" />
        </div>
        <div class="modal-footer confirm-footer">
          <button class="btn btn-secondary" data-pd="cancel">Cancel</button>
          <button class="btn btn-primary" data-pd="save">Save</button>
        </div>
      </div>`;
    const finish = v => { document.removeEventListener('keydown', onKey, true); wrap.classList.add('confirm-out'); setTimeout(() => wrap.remove(), 160); resolve(v); };
    const save = () => { const v = wrap.querySelector('#pd-date').value; finish(v ? new Date(v + 'T12:00:00').toISOString() : null); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(null); } else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); save(); } };
    document.addEventListener('keydown', onKey, true);
    wrap.querySelectorAll('[data-pd]').forEach(b => b.addEventListener('click', () => b.dataset.pd === 'save' ? save() : finish(null)));
    wrap.addEventListener('click', e => { if (e.target === wrap) finish(null); });
    document.body.appendChild(wrap);
    wrap.querySelector('#pd-date').focus();
  });
  // Book cards dragged onto series folders / the unassign zone (drop targets bind per render).
  document.addEventListener('dragstart', e => {
    const el = e.target instanceof Element && e.target.closest('[data-drag-item-id]');
    if (!el) return;
    _dragItemId = el.dataset.dragItemId;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', _dragItemId); } catch {}
    el.classList.add('card-dragging');
  });
  document.addEventListener('dragend', e => {
    const el = e.target instanceof Element && e.target.closest('[data-drag-item-id]');
    if (!el) return;
    el.classList.remove('card-dragging');
    document.querySelectorAll('.fc-drop-hover, .series-unassign-hover').forEach(x => x.classList.remove('fc-drop-hover', 'series-unassign-hover'));
    _dragItemId = null;
  });
}

// Click-to-open menus with full keyboard support. Bound once at the document level so they
// survive every re-render: ↓/↑ move, Enter/Space choose, Esc closes, click-outside closes.
function initDropdowns() {
  const closeAll = except => document.querySelectorAll('.dd.dd-open').forEach(d => {
    if (d === except) return;
    d.classList.remove('dd-open');
    d.querySelector('.dd-btn')?.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('.dd-btn');
    if (btn) {
      const dd = btn.closest('.dd');
      const open = !dd.classList.contains('dd-open');
      closeAll(dd);
      dd.classList.toggle('dd-open', open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) {
        const first = dd.querySelector('.dd-item.sel, .dd-item');
        first?.focus({ preventScroll: true });
        if (document.activeElement !== first) setTimeout(() => first?.focus({ preventScroll: true }), 0);
      }
      return;
    }
    // A menu item's own handler has already run by the time this bubbles up; just close.
    if (e.target.closest('.dd-item') || !e.target.closest('.dd')) closeAll();
  });
  document.addEventListener('keydown', e => {
    const dd = e.target.closest?.('.dd') || (e.key === 'Escape' ? document.querySelector('.dd.dd-open') : null);
    if (!dd) return;
    const items = [...dd.querySelectorAll('.dd-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      if (!dd.classList.contains('dd-open')) return;
      e.stopPropagation(); closeAll(); dd.querySelector('.dd-btn')?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!dd.classList.contains('dd-open')) dd.querySelector('.dd-btn')?.click();
      else items[(i + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
      e.preventDefault(); items[i].click();
    } else if (e.key === 'Home' && items.length) { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End' && items.length) { e.preventDefault(); items[items.length - 1].focus(); }
  });
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
  const series  = v('m-series');  if (series  !== null) patch.series  = series.trim() || undefined;
  const section = v('m-section'); if (section !== null) patch.section = section.trim();
  const pairing = v('m-pairing'); if (pairing !== null) patch.pairing = pairing.trim();
  const notes   = v('m-notes');   if (notes   !== null) patch.notes   = notes.trim();
  const desc    = v('m-description'); if (desc !== null) patch.description = desc.trim();
  const status  = v('m-status');  if (status  !== null) patch.status  = status;
  const rating  = v('m-rating');  if (rating  !== null) patch.rating  = rating;
  const fin     = v('m-finished'); if (fin    !== null) patch.finishedAt = fin ? new Date(fin + 'T12:00:00').toISOString() : null;
  const lit = document.querySelectorAll('#star-picker span.lit').length;
  if (document.getElementById('star-picker')) patch.userRating = lit;
  const pgv = v('m-prog-value');
  if (pgv !== null) patch.progress = readProgressFields(base);
  // An emptied number field means "clear it", not "keep the old value".
  const ws = v('m-words');     if (ws !== null) patch.words  = ws.trim()  ? (parseInt(ws)  || null) : null;
  const hs = v('m-hearts');    if (hs !== null) patch.hearts = hs.trim()  ? (parseInt(hs)  || null) : null;
  const ps = v('m-pages');     if (ps !== null) patch.pages  = ps.trim()  ? (parseInt(ps)  || null) : null;
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

// Re-rendering ~1000 cards on every keystroke made typing in the search box lag. Debounce the
// render (state updates immediately, the DOM catches up once typing pauses) and restore the caret
// in the recreated input so it never feels like focus was stolen.
let _searchTimer = null;
function bindDebouncedSearch(inputId, apply) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.addEventListener('input', e => {
    apply(e.target.value);
    const cursorPos = e.target.selectionStart;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      render();
      const newEl = document.getElementById(inputId);
      if (newEl && document.activeElement !== newEl) { newEl.focus(); try { newEl.setSelectionRange(cursorPos, cursorPos); } catch {} }
    }, 140);
  });
}

// The edit form's Progress fields → a progress object (or null when empty), keeping the timestamp
// of an unchanged position.
function readProgressFields(base) {
  const unit = document.getElementById('m-prog-unit')?.value || 'page';
  const value = parseFloat(document.getElementById('m-prog-value')?.value);
  const totalRaw = parseFloat(document.getElementById('m-prog-total')?.value);
  if (!(value >= 0)) return null;
  const total = unit === 'percent' ? null : (totalRaw > 0 ? Math.round(totalRaw) : null);
  const prev = base?.progress;
  const same = prev && prev.unit === unit && prev.value === Math.round(value) && (prev.total || null) === total;
  return { unit, value: Math.round(value), total, at: same ? prev.at : new Date().toISOString() };
}

function bindEvents() {
  // Search
  document.getElementById('m-prog-unit')?.addEventListener('change', e => {
    const pct = e.target.value === 'percent';
    const total = document.getElementById('m-prog-total'); const of = document.querySelector('.modal .progress-of');
    if (total) total.hidden = pct; if (of) of.textContent = pct ? '%' : 'of';
  });
  if (document.getElementById('m-prog-unit')?.value === 'percent') { const t = document.getElementById('m-prog-total'); if (t) t.hidden = true; }
  document.getElementById('notice-dismiss')?.addEventListener('click', () => { state.recoveredFrom = null; render(); });
  document.getElementById('notice-open-folder')?.addEventListener('click', () => window.api.openDataFolder());

  bindDebouncedSearch('search-input', v => { state.search = v; });

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

  // View mode toggle (list / folder)
  document.getElementById('btn-view-list')?.addEventListener('click', () => {
    state.viewMode = 'list'; render();
  });
  document.getElementById('btn-view-folder')?.addEventListener('click', () => {
    state.viewMode = 'folder'; render();
  });
  document.getElementById('btn-view-myspace')?.addEventListener('click', () => {
    const onBoard = state.view !== 'stats' && state.viewMode === 'myspace';
    state.viewMode = onBoard ? 'folder' : 'myspace'; state.view = 'library'; render();
  });

  // ── MySpace: Fanfiction / Books tab switch ──
  document.querySelectorAll('[data-ms-tab]').forEach(btn => {
    btn.addEventListener('click', () => { state.mySpaceTab = btn.dataset.msTab; state.msChip = null; state.msSearch = ''; render(); });
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
    c.addEventListener('click', e => {
      if (_msDragged || (e.target instanceof Element && e.target.closest('button'))) return;
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
      else if (res && res.ok) { showToast('Already up to date ✓', 'success'); btn.innerHTML = icon('refresh'); btn.disabled = false; }
      else if (res && res.needsLogin) { showToast('🔒 Locked work — use “🔑 AO3 login” (top bar), then retry.', 'info'); btn.innerHTML = icon('refresh'); btn.disabled = false; }
      else { showToast('Couldn’t refresh — check the link', 'error'); btn.innerHTML = icon('refresh'); btn.disabled = false; }
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
  bindDebouncedSearch('folder-search', v => { state.folderSearch = v; });

  // MySpace TBR column tools
  bindDebouncedSearch('ms-search', v => { state.msSearch = v; });
  document.getElementById('ms-sort')?.addEventListener('change', e => { state.msSort = e.target.value; render(); });
  document.querySelectorAll('[data-ms-chip]').forEach(b => b.addEventListener('click', () => {
    const g = b.dataset.msChip;
    if (!g) { state.msChip = null; state.msSearch = ''; } else state.msChip = state.msChip === g ? null : g;
    render();
  }));
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

  // Drag a book card onto a series folder (joins the series) or onto the "take out of series"
  // zone inside a series view (clears it) — mirrors the folder-merge drag above but for items.
  {
    // dragstart/dragend for book cards are delegated in initCardDelegation(); only drop targets bind here.

    const setSeries = (itemId, seriesName) => {
      const item = state.items.find(x => x.id === itemId);
      if (!item || item.type !== 'book' || item.series === seriesName) return;
      pushItemsUndo();
      item.series = seriesName || undefined;
      item._modAt = new Date().toISOString();
      saveData();
      render();
      showToast(seriesName ? `Added to "${seriesName}" ↩️⌘Z to undo` : 'Removed from series ↩️⌘Z to undo', 'success');
    };

    document.querySelectorAll('[data-drop-series-name]').forEach(el => {
      el.addEventListener('dragover', e => {
        if (!_dragItemId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('fc-drop-hover');
      });
      el.addEventListener('dragleave', () => el.classList.remove('fc-drop-hover'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('fc-drop-hover');
        const id = _dragItemId || e.dataTransfer.getData('text/plain');
        setSeries(id, el.dataset.dropSeriesName);
      });
    });

    const unassignZone = document.getElementById('series-unassign-zone');
    if (unassignZone) {
      unassignZone.addEventListener('dragover', e => {
        if (!_dragItemId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        unassignZone.classList.add('series-unassign-hover');
      });
      unassignZone.addEventListener('dragleave', () => unassignZone.classList.remove('series-unassign-hover'));
      unassignZone.addEventListener('drop', e => {
        e.preventDefault();
        unassignZone.classList.remove('series-unassign-hover');
        const id = _dragItemId || e.dataTransfer.getData('text/plain');
        setSeries(id, null);
      });
    }
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
        ? `<img src="${esc(val)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px" />`
        : `<span style="font-size:38px;line-height:1">${esc(val) || '📁'}</span>`;
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
    febDelete.addEventListener('click', async () => {
      const key = state.editingFolder;
      if (!key) return;
      const ok = await confirmDialog({
        title: 'Delete this folder?',
        message: 'The items inside keep their tags — only this custom folder is removed. ⌘Z undoes it.',
        confirmLabel: 'Delete folder', danger: true,
      });
      if (!ok || state.editingFolder !== key) return;
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
      // Book series folders are keyed by the series name itself (like genre folders) rather
      // than an opaque id, so a book dropped onto it later (item.series = name) matches directly.
      const isBookSeries = parentPath[0] === 'book' && parentPath.length === 2;
      const id = isBookSeries ? name : 'custom_' + Date.now();
      const newPath = [...parentPath, id];
      const key = newPath.join('|');
      if (isBookSeries && state.folderConfig[key]) { showToast('A series with that name already exists', 'error'); return; }
      pushFolderUndo();
      state.folderConfig[key] = { displayName: name, isCustom: true, _modAt: new Date().toISOString() };
      if (isBookSeries) state.folderConfig[key].isSeries = true;
      if (icon) state.folderConfig[key].icon = icon;
      if (filterTag) state.folderConfig[key].filterTag = filterTag;
      saveFolderConfig();
      state.creatingFolderIn = null;
      render();
    });
  }

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
        ? `<img src="${esc(val)}" style="width:100%;height:100%;object-fit:cover;border-radius:10px" />`
        : `<span style="font-size:38px;line-height:1">${esc(val) || (isFf?'✍️':'📚')}</span>`;
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
    el.addEventListener('click', () => { state.statsCategory = el.dataset.scat; state.statsCalendarYear = null; render(); });
  });
  document.querySelectorAll('[data-speriod]').forEach(el => {
    el.addEventListener('click', () => { state.statsPeriod = el.dataset.speriod; render(); });
  });
  document.querySelectorAll('[data-smetric]').forEach(el => {
    el.addEventListener('click', () => { state.statsMetric = el.dataset.smetric; render(); });
  });
  document.querySelectorAll('[data-cal-year-nav]').forEach(el => {
    el.addEventListener('click', () => {
      const cat = state.statsCategory;
      const items = (cat === 'books' ? state.items.filter(x => x.type === 'book')
        : cat === 'ff' ? state.items.filter(x => x.type === 'ff' && !x.oneshot)
        : cat === 'oneshot' ? state.items.filter(x => x.type === 'ff' && x.oneshot)
        : state.items);
      const current = state.statsCalendarYear ?? getReadingCalendarYears(items)[0]?.year ?? new Date().getFullYear();
      state.statsCalendarYear = current + (el.dataset.calYearNav === 'next' ? 1 : -1);
      render();
    });
  });

  // Reading calendar icon tooltips — a floating element appended to <body>, positioned from
  // the icon's real screen coords, so it always shows in full instead of being clipped by the
  // month box's own scroll area.
  document.querySelectorAll('.cal-item-icon[data-cal-title]').forEach(el => {
    el.addEventListener('mouseenter', () => {
      const tip = document.createElement('div');
      tip.className = 'cal-tooltip';
      tip.textContent = el.dataset.calTitle;
      document.body.appendChild(tip);
      const r = el.getBoundingClientRect();
      const above = r.top > tip.offsetHeight + 12;
      tip.classList.add(above ? 'cal-tooltip-above' : 'cal-tooltip-below');
      tip.style.left = `${r.left + r.width / 2}px`;
      tip.style.top = above ? `${r.top - 8}px` : `${r.bottom + 8}px`;
      el._calTip = tip;
    });
    el.addEventListener('mouseleave', () => {
      el._calTip?.remove();
      el._calTip = null;
    });
  });

  // Drag a calendar icon onto a different month to change its exact read date.
  let _calDragPayload = null;
  document.querySelectorAll('.cal-item-icon[draggable="true"]').forEach(el => {
    el.addEventListener('dragstart', e => {
      _calDragPayload = { itemId: el.dataset.calItemId, oldDate: el.dataset.calDate };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.calItemId);
      el.classList.add('cal-dragging');
      el._calTip?.remove(); el._calTip = null; // don't leave a tooltip stuck mid-drag
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('cal-dragging');
      document.querySelectorAll('.cal-month-card.cal-drop-hover').forEach(c => c.classList.remove('cal-drop-hover'));
      _calDragPayload = null;
    });
  });
  document.querySelectorAll('.cal-month-card[data-cal-drop-year]').forEach(el => {
    el.addEventListener('dragover', e => {
      if (!_calDragPayload) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('cal-drop-hover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('cal-drop-hover'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('cal-drop-hover');
      if (!_calDragPayload) return;
      const { itemId, oldDate } = _calDragPayload;
      _calDragPayload = null;
      const item = state.items.find(x => x.id === itemId);
      if (!item) return;
      const targetYear = parseInt(el.dataset.calDropYear, 10);
      const targetMonth = parseInt(el.dataset.calDropMonth, 10);
      const oldD = new Date(oldDate);
      const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
      const defaultDay = Math.min(oldD.getDate() || 1, daysInTargetMonth);
      const defaultDate = new Date(targetYear, targetMonth, defaultDay, 12, 0, 0);
      state.calMoveDraft = {
        itemId, oldDate, title: item.title || 'Untitled',
        defaultDateStr: defaultDate.toISOString().slice(0, 10),
      };
      render();
    });
  });

  // Move-read-date modal (opened by the drag above)
  const calMoveClose = () => { state.calMoveDraft = null; render(); };
  document.getElementById('cal-move-close')?.addEventListener('click', calMoveClose);
  document.getElementById('cal-move-cancel')?.addEventListener('click', calMoveClose);
  document.getElementById('cal-move-backdrop')?.addEventListener('click', e => {
    if (e.target.id === 'cal-move-backdrop') calMoveClose();
  });
  document.getElementById('cal-move-save')?.addEventListener('click', () => {
    const draft = state.calMoveDraft;
    if (!draft) return;
    const newDateVal = document.getElementById('cal-move-date')?.value;
    if (!newDateVal) return;
    const item = state.items.find(x => x.id === draft.itemId);
    if (!item) { state.calMoveDraft = null; render(); return; }
    const newDateIso = new Date(newDateVal + 'T12:00:00').toISOString();
    const dates = ensureReadDates(item);
    const idx = dates.findIndex(d => d === draft.oldDate);
    if (idx !== -1) dates[idx] = newDateIso; else dates.push(newDateIso);
    item.readDates = dates;
    item.readCount = dates.length;
    const validTimes = dates.filter(Boolean).map(d => Date.parse(d)).filter(n => !isNaN(n));
    if (validTimes.length) item.finishedAt = new Date(Math.max(...validTimes)).toISOString();
    item._modAt = new Date().toISOString();
    state.calMoveDraft = null;
    saveData();
    render();
  });

  // Mood picker ("What should I read next?")
  const moodClose = () => { state.moodPickerOpen = false; state.moodPickerMood = null; state.moodPickerBookId = null; render(); };
  document.getElementById('btn-mood-picker')?.addEventListener('click', () => {
    state.moodPickerOpen = true; state.moodPickerMood = null; state.moodPickerBookId = null; render();
  });
  document.getElementById('mood-close')?.addEventListener('click', moodClose);
  document.getElementById('mood-picker-backdrop')?.addEventListener('click', e => {
    if (e.target.id === 'mood-picker-backdrop') moodClose();
  });
  document.getElementById('mood-back')?.addEventListener('click', () => {
    state.moodPickerMood = null; state.moodPickerBookId = null; render();
  });
  const revealMoodBook = (moodKey) => {
    const { book, fallback } = pickMoodBook(moodKey);
    state.moodPickerMood = moodKey;
    state.moodPickerBookId = book?.id || null;
    state.moodPickerFallback = fallback;
    state.moodPickerDesc = book ? 'loading' : null;
    render();
    if (book) {
      const requestedId = book.id;
      window.api.getBookDescription(book.title, book.author).then(res => {
        // The user may have rerolled or closed the picker while this was in flight —
        // only apply the result if it's still showing the same book.
        if (state.moodPickerBookId !== requestedId) return;
        state.moodPickerDesc = res?.description ? { text: res.description, source: res.source } : 'none';
        render();
      }).catch(() => {
        if (state.moodPickerBookId === requestedId) { state.moodPickerDesc = 'none'; render(); }
      });
    }
  };
  document.querySelectorAll('[data-mood]').forEach(btn => {
    btn.addEventListener('click', () => revealMoodBook(btn.dataset.mood));
  });
  document.getElementById('mood-reroll')?.addEventListener('click', () => revealMoodBook(state.moodPickerMood));
  document.getElementById('mood-start-reading')?.addEventListener('click', () => {
    const item = state.items.find(x => x.id === state.moodPickerBookId);
    if (item) {
      const now = new Date().toISOString();
      pushItemUndo(item);
      item.status = 'Reading'; item.waitingOnChap = false;
      ensureReadingStart(item, now);
      item._modAt = now;
      saveData();
    }
    moodClose();
    if (item) showToast(`Started reading “${item.title}” ✓`, 'success');
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
      refreshWordsBtn.disabled = false; refreshWordsBtn.innerHTML = icon('refresh');
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




  // Empty-state call-to-action buttons
  document.querySelectorAll('[data-empty-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = btn.dataset.emptyAction;
      if (a === 'clear-search') { state.search = ''; state.filterStatus = 'all'; state.filterType = 'all'; state.filterFandom = 'all'; state.filterGenre = 'all'; state.filterSection = 'all'; state.filterTag = 'all'; state.filterFavorite = false; render(); return; }
      if (a === 'clear-folder-filter') { state.folderItemFilter = null; state.folderSearch = ''; render(); return; }
      if (a === 'home') { state.folderPath = []; render(); return; }
      if (a === 'add' || a === 'add-ff' || a === 'add-book') {
        state.editItem = a === 'add-book' ? { type: 'book' } : (a === 'add-ff' ? { type: 'ff' } : null);
        if (a === 'add' && state.search) state.editItem = { type: 'ff', title: state.search };
        state.modalOpen = true; render();
        setTimeout(() => document.getElementById(a === 'add-book' ? 'm-title' : 'm-url')?.focus(), 60);
      }
    });
  });

  // Density toggle (Settings menu)
  document.getElementById('btn-relink')?.addEventListener('click', () => relinkMovedFiles());
  document.getElementById('btn-density')?.addEventListener('click', () => {
    state.density = state.density === 'compact' ? 'comfortable' : 'compact';
    try { localStorage.setItem('density:v2', state.density); } catch {}
    document.body.dataset.density = state.density;
    render();
    showToast(state.density === 'compact' ? 'Compact cards' : 'Comfortable cards', 'info', { duration: 1800 });
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
  attachAutocomplete('m-series', 'sug-series', distinctVals('series'));
  // Pairing suggestions pool both past Pairing values (M/M, F/F…) and ship-name tags already in use.
  const shipTagPool = [...new Set(state.items.flatMap(x => x.tags || []).filter(isShipPairing))];
  attachAutocomplete('m-pairing', 'sug-pairing', [...new Set([...distinctVals('pairing'), ...shipTagPool])].sort((a,b)=>a.localeCompare(b)));
  // Genre suggestions from existing top-level genre folders only (not the "Fantasy / Romantasy" sub-part).
  const genreFolderNames = [...new Set(state.items.filter(x => x.type === 'book' && x.genre).map(x => x.genre.split(' / ')[0].trim()))].sort((a,b)=>a.localeCompare(b));
  attachAutocomplete('m-genre', 'sug-genre', genreFolderNames);

  // Title: required-field validation as you leave the field, plus a live duplicate warning.
  const titleEl = document.getElementById('m-title');
  const dupeWarnEl = document.getElementById('dupe-warning');
  if (titleEl && dupeWarnEl) {
    const isNew = !state.editItem?.id;
    titleEl.addEventListener('blur', () => {
      const raw = titleEl.value.trim();
      if (!raw) {
        titleEl.classList.add('field-invalid');
        dupeWarnEl.textContent = 'A title is required.'; dupeWarnEl.className = 'field-hint-err';
        return;
      }
      titleEl.classList.remove('field-invalid'); dupeWarnEl.className = 'dupe-warn';
      if (!isNew) { dupeWarnEl.textContent = ''; return; }
      const dupe = state.items.find(x => norm(x.title) === norm(raw));
      dupeWarnEl.textContent = dupe
        ? `⚠️ Already in library: "${dupe.title}" (${dupe.type === 'ff' ? 'FF' : 'Book'}, ${dupe.status})`
        : '';
    });
    titleEl.addEventListener('input', () => {
      if (titleEl.value.trim()) { titleEl.classList.remove('field-invalid'); if (dupeWarnEl.className === 'field-hint-err') { dupeWarnEl.textContent = ''; dupeWarnEl.className = 'dupe-warn'; } }
    });
  }

  // Book auto-fill (Google Books, falling back to OpenLibrary)
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
        if (data.genre)  { const el = document.getElementById('m-genre');  if (el) el.value = normalizeGenre(data.genre); }
        // No cover preview lives in this form, so just stash it on editItem — it'll carry
        // through to the save (via the ...editItem spread) and show up once the card renders.
        if (data.cover) { state.editItem = { ...(state.editItem || {}), coverIcon: data.cover }; }
        if (msgEl) { msgEl.textContent = `✓ Details filled in from ${data.source || 'the catalog'}${data.cover ? ' (cover included)' : ''} — check and adjust!`; msgEl.className = 'fetch-msg ok'; }

        // Synopsis lookup (OpenLibrary → Goodreads → Google Books) can take up to ~20s on a slow
        // connection, so it runs after the fields are already filled in rather than blocking the
        // rest of the form — the message line just updates in place once it lands.
        const fetchedTitle = data.title || query;
        const fetchedAuthor = data.author || document.getElementById('m-author')?.value?.trim();
        if (fetchedTitle) {
          if (msgEl) msgEl.textContent += ' Fetching synopsis…';
          window.api.getBookDescription(fetchedTitle, fetchedAuthor).then(res => {
            if (res?.description) {
              state.editItem = { ...(state.editItem || {}), description: res.description };
              const descEl = document.getElementById('m-description');
              if (descEl) descEl.value = res.description;
              if (msgEl && document.body.contains(msgEl)) {
                msgEl.textContent = `✓ Details filled in from ${data.source || 'the catalog'}${data.cover ? ' (cover included)' : ''}, synopsis added — check and adjust!`;
              }
            } else if (msgEl && document.body.contains(msgEl)) {
              msgEl.textContent = `✓ Details filled in from ${data.source || 'the catalog'}${data.cover ? ' (cover included)' : ''} — no synopsis found anywhere, add one manually if you'd like.`;
            }
          }).catch(() => {});
        }
      } catch(e) {
        if (msgEl) { msgEl.textContent = 'Not found — fill in manually.'; msgEl.className = 'fetch-msg err'; }
      }
      bookFetchBtn.disabled = false; bookFetchBtn.textContent = 'Auto-fill';
    });
  }

  // Manually link (or replace) the local PDF/EPUB for books the auto-matcher didn't catch
  const pickLocalBtn = document.getElementById('btn-pick-localfile');
  if (pickLocalBtn) {
    pickLocalBtn.addEventListener('click', async () => {
      const picked = await window.api.pickLocalFile();
      if (!picked) return;
      state.editItem = { ...(state.editItem || {}), localFile: picked };
      render();
    });
  }
  const clearLocalBtn = document.getElementById('btn-clear-localfile');
  if (clearLocalBtn) {
    clearLocalBtn.addEventListener('click', () => {
      state.editItem = { ...(state.editItem || {}), localFile: undefined };
      render();
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
          fetchBtn.disabled = false; fetchBtn.textContent = 'Auto-fill';
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
          description: data.description || state.editItem?.description || '',
          chaptersPosted: data.chaptersPosted || state.editItem?.chaptersPosted || null,
          chaptersTotal: data.chaptersTotal || state.editItem?.chaptersTotal || null,
          url,
        };
        render();
        const newMsgEl = document.getElementById('fetch-msg');
        if (newMsgEl) { newMsgEl.textContent = `✓ Details fetched!${data.description ? ' Summary included.' : ''}`; newMsgEl.className = 'fetch-msg ok'; }
      } catch(e) {
        if (msgEl) { msgEl.textContent = 'Could not fetch — fill in manually.'; msgEl.className='fetch-msg err'; }
        fetchBtn.disabled = false; fetchBtn.textContent = 'Auto-fill';
      }
    });
  }

  // Submit
  document.getElementById('modal-submit')?.addEventListener('click', async () => {
    const titleInput = document.getElementById('m-title');
    const title = titleInput?.value?.trim();
    if (!title) {
      showToast('A title is required.', 'error');
      titleInput?.focus(); titleInput?.classList.add('field-invalid');
      titleInput?.addEventListener('input', () => titleInput.classList.remove('field-invalid'), { once: true });
      return;
    }
    if (!state.editItem?.id) {
      const dupe = state.items.find(x => norm(x.title) === norm(title));
      if (dupe) {
        const ok = await confirmDialog({
          title: 'Already in your library',
          message: `“${title}” is already saved as a ${dupe.type === 'ff' ? 'fanfiction' : 'book'} (${dupe.status}). Add it again anyway?`,
          confirmLabel: 'Add anyway',
        });
        if (!ok) return;
        if (!state.modalOpen) return; // the modal was closed while the dialog was up
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

    // A ship typed into Pairing (e.g. "Harry/Ginny", "Tomarry", "Tom Riddle/Harry Potter") also
    // becomes a tag. If an equivalent ship already has a tag somewhere in the library — same
    // pair under a different name order, nickname, or portmanteau — reuse that exact tag string
    // so this entry joins the existing folder instead of splintering off a near-duplicate one.
    const tags = (() => {
      const base = state.editItem?.tags || [];
      if (!pairing) return base;
      const shipStrings = pairing.split(',').map(s => s.trim()).filter(Boolean);
      const allTags = [...new Set(state.items.flatMap(x => x.tags || []))];
      const resolved = [];
      for (const s of shipStrings) {
        const key = shipKey(s);
        if (!key) continue;
        const existing = allTags.find(t => shipKey(t) === key);
        resolved.push(existing || s);
      }
      if (!resolved.length) return base;
      return [...new Set([...base, ...resolved])];
    })();

    const item = {
      ...(state.editItem||{}),
      id: state.editItem?.id || genId(),
      type,
      title,
      author: document.getElementById('m-author')?.value?.trim() || '',
      fandom: isFf ? (document.getElementById('m-fandom')?.value?.trim() || '') : '',
      genre: !isFf ? normalizeGenre(document.getElementById('m-genre')?.value) : '',
      series: !isFf ? (document.getElementById('m-series')?.value?.trim() || undefined) : undefined,
      section: !isFf ? (document.getElementById('m-section')?.value?.trim() || state.editItem?.section || '') : '',
      pairing,
      rating: isFf ? (document.getElementById('m-rating')?.value || '') : '',
      status,
      words: words ? parseInt(words) : null,
      hearts: hearts ? parseInt(hearts) : null,
      pages: pages ? parseInt(pages) : null,
      userRating: modalRating,
      notes: document.getElementById('m-notes')?.value?.trim() || '',
      description: document.getElementById('m-description')?.value?.trim() || '',
      tags,
      url: document.getElementById('m-url')?.value?.trim() || state.editItem?.url || '',
      oneshot: isFf ? (state.editItem?.oneshot || false) : undefined,
      finishedAt,
      readCount,
      readDates,
      progress: status === 'Finished' || status === 'TBR' ? null : readProgressFields(state.editItem),
      _addedAt: state.editItem?._addedAt ?? nextAddedAt(),
      _modAt: new Date().toISOString(),
    };
    // Any route into "Reading" stamps the start date; leaving it for TBR clears it.
    if (status === 'Reading') ensureReadingStart(item, item._modAt);
    if (status === 'TBR') item.readingStartedAt = null;

    const idx = state.items.findIndex(x => x.id === item.id);
    if (idx >= 0) state.items[idx] = item;
    else state.items.unshift(item);

    state.modalOpen = false; state.editItem = null;
    saveData(); render();
    showToast(idx >= 0 ? 'Changes saved ✓' : `Added “${item.title}” ✓`, 'success', { duration: 2500 });
  });
}

// ── Toast notifications ───────────────────────────────────────────────────────
// showToast(message, type, { duration, action: { label, onClick } })
// Styled in CSS (.toast); wraps long messages instead of running off-screen; an optional action
// button (used for Undo) keeps the toast up until it's clicked or the timer runs out.
let _toastTimer = null;
function showToast(message, type = 'info', opts = {}) {
  document.getElementById('toast')?.remove();
  clearTimeout(_toastTimer);

  const icon = { loading: '⏳', success: '✅', error: '❌', info: 'ℹ️' }[type] || 'ℹ️';
  const toast = document.createElement('div');
  toast.id = 'toast';
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${message}</span>${opts.action ? `<button class="toast-action" type="button">${esc(opts.action.label)}</button>` : ''}`;
  if (opts.action) {
    toast.querySelector('.toast-action').addEventListener('click', () => {
      toast.remove(); clearTimeout(_toastTimer);
      try { opts.action.onClick(); } catch (e) { console.error(e); }
    });
  }
  document.body.appendChild(toast);
  const duration = opts.duration ?? (type === 'loading' ? 0 : 4000);
  if (duration > 0) {
    _toastTimer = setTimeout(() => {
      toast.classList.add('toast-out');
      setTimeout(() => toast.remove(), 220);
    }, duration);
  }
  return toast;
}

// ── In-app confirm dialog (replaces the OS `confirm()` sheet) ─────────────────
// Returns a Promise<boolean>. Enter confirms, Escape cancels, clicking the backdrop cancels.
function confirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    document.getElementById('confirm-backdrop')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'confirm-backdrop';
    wrap.className = 'folder-edit-backdrop confirm-backdrop';
    wrap.innerHTML = `
      <div class="folder-edit-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-body">
          <div class="confirm-title" id="confirm-title">${esc(title)}</div>
          ${message ? `<p class="confirm-msg">${esc(message)}</p>` : ''}
        </div>
        <div class="modal-footer confirm-footer">
          <button class="btn btn-secondary" data-confirm="0">${esc(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm="1">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const previouslyFocused = document.activeElement;
    const finish = ok => {
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.add('confirm-out');
      setTimeout(() => wrap.remove(), 160);
      if (previouslyFocused && previouslyFocused.focus) try { previouslyFocused.focus(); } catch {}
      resolve(ok);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', e => { if (e.target === wrap) finish(false); });
    wrap.querySelectorAll('[data-confirm]').forEach(b => b.addEventListener('click', () => finish(b.dataset.confirm === '1')));
    document.body.appendChild(wrap);
    wrap.querySelector(danger ? '[data-confirm="0"]' : '[data-confirm="1"]').focus();
  });
}

// ── GitHub backup ─────────────────────────────────────────────────────────────
// Sync = pull only. Back up = push only. They used to be entangled (Back up silently pulled
// and merged first), which meant deleting something and then backing up could resurrect it —
// the pull-in-merge only knows an id is "missing", not "deleted on purpose".
async function handleSync() {
  if (state.readOnly) { showToast('Read-only mode — fix the data file first, then sync.', 'error'); return; }
  showToast('Getting the latest from GitHub…', 'loading');
  try {
    const res = await window.api.pullData();
    document.getElementById('toast')?.remove();
    if (!res || !res.ok) { showToast('Sync failed: ' + ((res && res.error) || 'no connection'), 'error'); return; }
    if (res.data) {
      const merged = mergeLibrary(state.items, state.folderConfig, res.data.items, res.data.folderConfig, state.deletedIds, res.data.deletedIds);
      // Safety: never lose data for any reason other than an explicit, tracked deletion.
      if (merged.items.length >= Math.max(state.items.length, (res.data.items||[]).length) - merged.removedByTombstone) {
        state.items = merged.items.map(normalizeItem);
        state.folderConfig = normalizeFolderConfig(merged.folderConfig);
        state.deletedIds = merged.deletedIds;
        localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig));
        await saveData();
        await refreshFileStatus();
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
  if (state.readOnly) { showToast('Read-only mode — fix the data file first, then back up.', 'error'); return; }
  // Busy state is a class (spinner ring + label swap), so the button keeps its size and place.
  const setBusy = busy => {
    const b = document.getElementById('btn-backup'); if (!b) return;
    b.classList.toggle('is-busy', busy); b.setAttribute('aria-busy', String(busy));
    const lbl = b.querySelector('.btn-lbl'); if (lbl) lbl.textContent = busy ? 'Backing up…' : 'Back up';
  };
  setBusy(true);
  showToast('Saving to GitHub…', 'loading');

  try {
    // Merge whatever the phone pushed since we last looked BEFORE committing. Without this, a
    // push rejected as "remote ahead" was resolved with `-X ours`, which threw away the phone's
    // entries wholesale. Deletions are safe to merge now thanks to the tombstones in deletedIds.
    const pulled = await syncFromCloud();
    if (pulled) { await refreshFileStatus(); render(); setBusy(true); }
    const result = await window.api.gitBackup();
    document.getElementById('toast')?.remove();
    showToast(result.ok ? result.message : result.error, result.ok ? 'success' : 'error');
  } catch(e) {
    document.getElementById('toast')?.remove();
    showToast('Backup failed: ' + e.message, 'error');
  } finally { setBusy(false); }
}

// ── Excel export ──────────────────────────────────────────────────────────────
// The workbook is built in the main process (see data:export in main.js) — this sandboxed
// renderer has no `require`, which is why the old in-renderer ExcelJS call never worked.
async function exportToExcel() {
  const filePath = await window.api.exportPath();
  if (!filePath) return;
  showToast('Exporting…', 'loading');
  try {
    const res = await window.api.exportExcel(filePath, state.items);
    if (!res?.ok) throw new Error(res?.error || 'export failed');
    showToast(`Exported ${res.count} entries to ${filePath.split('/').pop()} ✓`, 'success', { duration: 6000 });
  } catch (e) {
    showToast('Export failed: ' + e.message, 'error', { duration: 8000 });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // Close the top-most overlay only — one Escape per layer, like every native Mac app.
    if (state.editingFolder)      { state.editingFolder = null; render(); return; }
    if (state.creatingFolderIn)   { state.creatingFolderIn = null; render(); return; }
    if (state.editingItemIcon)    { state.editingItemIcon = null; render(); return; }
    if (state.calMoveDraft)       { state.calMoveDraft = null; render(); return; }
    if (state.settingsOpen)       { state.settingsOpen = false; render(); return; }
    if (state.moodPickerOpen)     { state.moodPickerOpen = false; state.moodPickerMood = null; state.moodPickerBookId = null; render(); return; }
    if (state.modalOpen)          { state.modalOpen = false; state.editItem = null; render(); return; }
  }
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
let _swipeArmed = true;         // false from the moment a swipe navigates until the trackpad goes quiet
const SWIPE_THRESHOLD = 45;
const SWIPE_COOLDOWN = 650;
const SWIPE_IDLE_RESET = 160;

function fireSwipe(action) {
  _navSwipeAt = Date.now();
  _swipeAccumX = 0;
  _swipeArmed = false;
  action();
}

window.addEventListener('wheel', e => {
  // The horizontally-scrolling series shelf has its own left/right scroll — trackpad scrolling
  // through it must never be misread as a back-navigation swipe.
  if (e.target.closest && e.target.closest('.series-grid')) { _swipeAccumX = 0; return; }
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) + 4) { _swipeAccumX = 0; return; }  // must be a horizontal swipe

  _swipeAccumX += e.deltaX;
  clearTimeout(_swipeResetTimer);
  // The gesture is over once the trackpad has been quiet for a moment — only then may the next
  // swipe navigate. Momentum after a flick keeps sending wheel events for a second or more, which
  // used to fire "back" two or three times in a row and land on the home screen.
  _swipeResetTimer = setTimeout(() => { _swipeAccumX = 0; _swipeArmed = true; }, SWIPE_IDLE_RESET);
  if (!_swipeArmed) return;                                              // one step per gesture
  if (Date.now() - _navSwipeAt < SWIPE_COOLDOWN) return;

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

// A cover image that fails to load (dead Pinterest link, offline) turns into the emoji tile
// instead of the browser's broken-image glyph. One delegated listener, capture phase, because
// `error` doesn't bubble — and no inline onerror attributes, which the CSP blocks.
function attachCoverFallback() {
  document.addEventListener('error', e => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('cover-img')) return;
    const span = document.createElement('span');
    span.className = img.className.replace('cover-img', '').replace(/-img\b/, '-emoji').trim() || 'card-cover-emoji';
    span.textContent = img.dataset.fallback || '📚';
    img.replaceWith(span);
  }, true);
  document.addEventListener('load', e => {
    if (e.target instanceof HTMLImageElement && e.target.classList.contains('cover-img')) e.target.classList.add('is-loaded');
  }, true);
}

(async () => {
  attachCoverFallback();
  initDropdowns();
  initCardDelegation();
  restoreUiState();
  // Re-derive banner ink when the system switches between light and dark.
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyBanner()); } catch {}
  state.items = await loadData();
  state.bannerConfig = loadBannerConfig();
  await refreshFileStatus();
  // The JSON file is the source of truth for folder config (it's what syncs to the phone).
  // localStorage only matters for libraries from before folderConfig lived in the file: pick it
  // up once, persist it, and from then on it's just a mirror.
  const legacyLocal = loadFolderConfig();
  if (!state._jsonHadFolderConfig && Object.keys(legacyLocal).length) {
    state.folderConfig = normalizeFolderConfig(legacyLocal);
    if (state._loadedFromFile) saveData();
  }
  try { localStorage.setItem('folderConfig', JSON.stringify(state.folderConfig)); } catch {}
  render();
  if (state.loadError) return; // recovery mode — never sync or auto-group over a broken file
  // Pull any changes made on the phone (or elsewhere) and merge them in, then re-render.
  if (await syncFromCloud()) { await refreshFileStatus(); render(); }
  relinkMovedFiles({ silent: true }); // self-healing links: files moved into sub-folders are found again
  if (autoGroupSimilarTags()) render();
  // Sample cover colours in the background once the UI is settled; cached after the first run.
  setTimeout(runCoverColorQueue, 1500);
})();
