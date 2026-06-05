'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  items: [],
  search: '',
  filterStatus: 'all',
  filterType: 'all',
  filterFandom: 'all',
  filterSection: 'all',
  sortBy: 'added',
  expandedId: null,
  modalOpen: false,
  editItem: null,
};

const STATUS = ['TBR','Reading','Finished','Dropped'];
const STATUS_COLOR = { TBR:'purple', Reading:'amber', Finished:'green', Dropped:'red' };

// ── Persistence ───────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const saved = await window.api.loadData();
    if (saved && saved.length) return saved;
  } catch(e) {}
  return INITIAL_DATA.map((item, i) => ({ ...item, _addedAt: i }));
}

async function saveData() {
  try { await window.api.saveData(state.items); } catch(e) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) { return n ? Number(n).toLocaleString() : '—'; }
function genId() { return Date.now() + '_' + Math.random().toString(36).slice(2); }

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

function getFiltered() {
  return state.items.filter(item => {
    if (state.filterType !== 'all' && item.type !== state.filterType) return false;
    if (state.filterStatus !== 'all' && item.status !== state.filterStatus) return false;
    if (state.filterFandom !== 'all' && item.fandom !== state.filterFandom) return false;
    if (state.filterSection !== 'all' && item.section !== state.filterSection) return false;
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
    return (a._addedAt||0) - (b._addedAt||0);
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
    totalWords: items.reduce((s,x) => s + (x.words||0), 0),
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
  return `<span class="tag">${t}${removable ? `<span class="tag-remove" data-tag="${t}" data-id="${itemId}">×</span>` : ''}</span>`;
}

// ── Card HTML ─────────────────────────────────────────────────────────────────
function cardHtml(item) {
  const isFf = item.type === 'ff';
  const expanded = state.expandedId === item.id;
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
        ${notesHtml}${extraHtml}
        ${item.url ? `<p class="card-extra"><a href="${item.url}" style="color:#6366f1">Open link ↗</a></p>` : ''}
      </div>`;
  }

  const sub = isFf
    ? `by <b>${item.author||'—'}</b>${item.fandom ? ' · '+item.fandom : ''}`
    : `by <b>${item.author||'—'}</b>${item.genre ? ' · '+item.genre : ''}`;

  return `
    <div class="card" data-id="${item.id}">
      <div class="card-top">
        <div class="card-main" data-expand="${item.id}">
          <div class="card-title-row">
            <span class="card-title">${item.title}</span>
            ${badgeHtml(item.status)}
          </div>
          <div class="card-sub">${sub}</div>
          <div class="card-meta">
            ${metaParts.join('\n')}
            ${tags}
          </div>
        </div>
        <div class="card-actions">
          ${item.url ? `<button class="icon-btn" data-open-url="${item.url}" title="Open link">🔗</button>` : ''}
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
        <label class="field-label">AO3 / Fic URL</label>
        <div class="fetch-row">
          <input type="url" id="m-url" value="${item.url||''}" placeholder="https://archiveofourown.org/works/…" />
          <button class="btn btn-primary btn-sm" id="btn-fetch">Auto-fill ✦</button>
        </div>
        <div class="fetch-msg" id="fetch-msg"></div>` : ''}

        <label class="field-label">Title *</label>
        <input type="text" id="m-title" value="${item.title||''}" placeholder="Title" />

        <label class="field-label">Author</label>
        <input type="text" id="m-author" value="${item.author||''}" placeholder="Author / username" />

        <div class="field-row">
          ${isFf ? `
          <div>
            <label class="field-label">Fandom</label>
            <input type="text" id="m-fandom" value="${item.fandom||''}" placeholder="e.g. Harry Potter" />
          </div>
          <div>
            <label class="field-label">Pairing</label>
            <input type="text" id="m-pairing" value="${item.pairing||''}" placeholder="e.g. M/M" />
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
            <input type="number" id="m-words" value="${item.words||''}" placeholder="e.g. 120000" />
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
          <input type="text" id="m-tag-input" placeholder="Add tag + Enter (e.g. Drarry, slow burn)" />
          <button class="btn btn-secondary btn-sm" id="btn-add-tag">+</button>
        </div>
        <div class="tags-display" id="tags-display">${tags}</div>

        <label class="field-label">Notes</label>
        <textarea id="m-notes" placeholder="Personal thoughts, read again?">${item.notes||''}</textarea>

        <div class="modal-footer">
          <button class="btn btn-secondary" id="modal-cancel">Cancel</button>
          <button class="btn btn-primary" id="modal-submit">${isEdit ? 'Save changes' : 'Add to list'}</button>
        </div>
      </div>
    </div>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const listEl = document.getElementById('list');
  const scrollTop = listEl ? listEl.scrollTop : 0;
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

  document.getElementById('app').innerHTML = `
    <div id="titlebar">
      <div>
        <div id="titlebar-title">My Library</div>
        <div class="subtitle">${stats.ff} fics · ${stats.books} books · ${stats.totalWords.toLocaleString()} words read</div>
      </div>
      <div id="titlebar-actions">
        <button class="btn btn-secondary btn-sm btn-icon" id="btn-export" title="Export to Excel">📊 Export</button>
        <button class="btn btn-secondary btn-sm btn-icon" id="btn-data-folder" title="Open data folder">📁</button>
        <button class="btn btn-backup btn-sm btn-icon" id="btn-backup" title="Back up to GitHub">☁️ Back up</button>
        <button class="btn btn-primary btn-sm btn-icon" id="btn-add">＋ Add entry</button>
      </div>
    </div>

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
      <div class="stat-divider"></div>
      <span class="stat-words">📚 ${stats.books} books &nbsp;·&nbsp; 📖 ${stats.ff} fics</span>
    </div>

    <div class="controls">
      <input id="search-input" type="text" placeholder="Search title, author, fandom, tag…" value="${state.search}" />
      <select class="filter-select" id="sort-select">
        <option value="added"${state.sortBy==='added'?' selected':''}>Recently added</option>
        <option value="title"${state.sortBy==='title'?' selected':''}>A → Z</option>
        <option value="author"${state.sortBy==='author'?' selected':''}>Author A → Z</option>
        <option value="words"${state.sortBy==='words'?' selected':''}>Most words</option>
        <option value="hearts"${state.sortBy==='hearts'?' selected':''}>Most hearts</option>
        <option value="rating"${state.sortBy==='rating'?' selected':''}>My rating</option>
      </select>
    </div>

    <div class="filter-pills">
      ${fpill('All', state.filterType==='all', 'type="all"')}
      ${fpill('📖 Fanfiction', state.filterType==='ff', 'type="ff"')}
      ${fpill('📚 Books', state.filterType==='book', 'type="book"')}
      <span class="fpill divider">|</span>
      ${state.filterType !== 'book' ? fandomPills : ''}
      ${state.filterType !== 'ff' ? sectionPills : ''}
    </div>

    <div id="results-meta">${filtered.length} ${filtered.length===1?'entry':'entries'}${state.search ? ` matching "<b>${state.search}</b>"` : ''}</div>

    <div id="list">
      ${filtered.length === 0 ? `
        <div class="empty">
          <div class="empty-icon">📭</div>
          <p>${state.search ? 'No entries match your search.' : 'No entries yet — add your first one!'}</p>
        </div>` : filtered.map(cardHtml).join('')}
    </div>

    ${state.modalOpen ? modalHtml() : ''}
  `;

  const newListEl = document.getElementById('list');
  if (newListEl) newListEl.scrollTop = scrollTop;
  bindEvents();
}

// ── Event binding ─────────────────────────────────────────────────────────────
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

  // Add button
  const addBtn = document.getElementById('btn-add');
  if (addBtn) addBtn.addEventListener('click', () => { state.editItem = null; state.modalOpen = true; render(); });

  // Export
  const expBtn = document.getElementById('btn-export');
  if (expBtn) expBtn.addEventListener('click', exportToExcel);

  // Data folder
  const dfBtn = document.getElementById('btn-data-folder');
  if (dfBtn) dfBtn.addEventListener('click', () => window.api.openDataFolder());

  // GitHub backup
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

  // Filter pills
  document.querySelectorAll('[data-type]').forEach(el => {
    el.addEventListener('click', () => {
      state.filterType = el.dataset.type;
      state.filterFandom = 'all';
      state.filterSection = 'all';
      render();
    });
  });
  document.querySelectorAll('[data-fandom]').forEach(el => {
    el.addEventListener('click', () => {
      const f = el.dataset.fandom;
      state.filterFandom = state.filterFandom === f ? 'all' : f;
      render();
    });
  });
  document.querySelectorAll('[data-section]').forEach(el => {
    el.addEventListener('click', () => {
      const s = el.dataset.section;
      state.filterSection = state.filterSection === s ? 'all' : s;
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
        state.items = state.items.filter(x => x.id !== el.dataset.delete);
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

  // Status change in expanded card
  document.querySelectorAll('[data-set-status]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const id = el.dataset.id;
      const status = el.dataset.setStatus;
      state.items = state.items.map(x => x.id === id ? { ...x, status } : x);
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
        return { ...x, userRating: x.userRating === val ? 0 : val };
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
      state.editItem = { ...(state.editItem||{}), type: btn.dataset.typeBtn };
      render();
    });
  });

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
      state.editItem = { ...(state.editItem||{}), tags: (state.editItem?.tags||[]).filter(t=>t!==tag) };
      render();
    });
  });

  // Tag add
  const tagInput = document.getElementById('m-tag-input');
  const addTag = () => {
    const t = tagInput?.value.trim();
    if (!t) return;
    const existing = state.editItem?.tags || [];
    if (!existing.includes(t)) {
      state.editItem = { ...(state.editItem||{}), tags: [...existing, t] };
      render();
    } else { if(tagInput) tagInput.value = ''; }
  };
  tagInput?.addEventListener('keydown', e => e.key==='Enter' && addTag());
  document.getElementById('btn-add-tag')?.addEventListener('click', addTag);

  // AO3 fetch
  const fetchBtn = document.getElementById('btn-fetch');
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      const url = document.getElementById('m-url')?.value?.trim();
      if (!url || !url.includes('archiveofourown')) return;
      const msgEl = document.getElementById('fetch-msg');
      if (msgEl) { msgEl.textContent = 'Fetching from AO3…'; msgEl.className='fetch-msg'; }
      fetchBtn.disabled = true; fetchBtn.textContent = '…';
      try {
        const data = await window.api.fetchAO3(url);
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

    const type = state.editItem?.type || 'ff';
    const isFf = type === 'ff';
    const words = document.getElementById('m-words')?.value;
    const hearts = document.getElementById('m-hearts')?.value;
    const pages = document.getElementById('m-pages')?.value;

    const item = {
      ...(state.editItem||{}),
      id: state.editItem?.id || genId(),
      type,
      title,
      author: document.getElementById('m-author')?.value?.trim() || '',
      fandom: isFf ? (document.getElementById('m-fandom')?.value?.trim() || '') : '',
      genre: !isFf ? (document.getElementById('m-genre')?.value?.trim() || '') : '',
      section: !isFf ? (document.getElementById('m-section')?.value?.trim() || state.editItem?.section || '') : '',
      pairing: isFf ? (document.getElementById('m-pairing')?.value?.trim() || '') : '',
      rating: isFf ? (document.getElementById('m-rating')?.value || '') : '',
      status: document.getElementById('m-status')?.value || 'TBR',
      words: words ? parseInt(words) : null,
      hearts: hearts ? parseInt(hearts) : null,
      pages: pages ? parseInt(pages) : null,
      userRating: modalRating,
      notes: document.getElementById('m-notes')?.value?.trim() || '',
      tags: state.editItem?.tags || [],
      url: document.getElementById('m-url')?.value?.trim() || state.editItem?.url || '',
      _addedAt: state.editItem?._addedAt ?? state.items.length,
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
  if (e.key === 'Escape' && state.modalOpen) { state.modalOpen = false; state.editItem = null; render(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    document.getElementById('search-input')?.focus();
  }
});

(async () => {
  state.items = await loadData();
  render();
})();
