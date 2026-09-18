'use strict'
// ── Self-healing ebook links ────────────────────────────────────────────────────
// When linked PDFs/EPUBs have been moved into sub-folders (or renamed to "Author - Title.ext"),
// find them again without asking the user to relink 400 books by hand.
//
// Strategy, per missing path:
//   1. Search root = the nearest ancestor folder that still exists (e.g. ".../Desktop/PDF and FF"
//      when the files moved into ".../PDF and FF/01 Books/Read"). Never wider than that, so a
//      same-named file somewhere else on the Mac can't be picked up.
//   2. Exact match on the file name (case-insensitive) → confidence "exact".
//   3. Otherwise a normalised-title match: strip download-site junk ("(z-lib.org)", "-- <hash> --
//      Anna's Archive", "(Z-Lib.io)"), compare against the candidates' normalised stems, allowing
//      an "Author - Title" prefix. Unique → confidence "title". Several → reported as ambiguous
//      and left for the user's picker.
// Pure Node (fs/path only) so it can be unit-tested and dry-run outside Electron.

const fs = require('fs')
const path = require('path')

const EBOOK_EXT = new Set(['.pdf', '.epub', '.mobi', '.azw3'])
const MAX_DEPTH = 8
const MAX_ENTRIES = 80000

function nearestExistingDir(filePath, stopAt) {
  let dir = path.dirname(filePath)
  for (let i = 0; i < 12; i++) {
    if (stopAt && (dir === stopAt || dir === path.dirname(stopAt))) return dir === stopAt ? stopAt : null
    try { if (fs.statSync(dir).isDirectory()) return dir } catch {}
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

// Index every ebook under the given roots: by lowercase file name and by normalised stem.
function buildIndex(roots) {
  const byName = new Map()
  const entries = [] // { full, name, norm, ext }
  let budget = MAX_ENTRIES
  const seen = new Set()
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || budget <= 0) return
    let list = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      if (--budget <= 0) return
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!/\.(app|photoslibrary|bundle)$/i.test(e.name)) walk(full, depth + 1); continue }
      const ext = path.extname(e.name).toLowerCase()
      if (!EBOOK_EXT.has(ext) || seen.has(full)) continue
      seen.add(full)
      const key = e.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, [])
      byName.get(key).push(full)
      entries.push({ full, name: e.name, norm: normaliseStem(e.name), ext })
    }
  }
  for (const r of roots) walk(r, 0)
  return { byName, entries, scanned: MAX_ENTRIES - budget }
}

// "Stuck with You (Ali Hazelwood) (z-lib.org).epub" → "stuck with you"
// "The Wolf King -- Lauren Palphreyman -- 2023 -- <hash> -- Anna’s Archive.epub" → "the wolf king"
// "Lauren Palphreyman - The Wolf King.epub" → "lauren palphreyman the wolf king"
function normaliseStem(fileName) {
  let s = path.basename(fileName, path.extname(fileName)).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = s.replace(/^\s*\d{1,3}\s*[.\-–_)]\s*/, '') // "6. Title" / "02 - Title"
  s = s.replace(/\(z-lib\.(org|io)\)|\(z-library\)|_z-lib\.org_|z-lib\.org|anna.s archive|libgen/g, ' ')
  s = s.split(' -- ')[0]
  s = s.replace(/\s+by\s+.*$/, '')
  s = s.replace(/\(.*?\)|\[.*?\]/g, ' ')
  return s.replace(/[^a-z0-9]+/g, ' ').trim()
}

function normaliseText(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

// Decide the new path for one missing link, or null. `used` prevents two books resolving to
// the same file.
function matchOne(item, index, used) {
  const oldName = path.basename(item.path)
  const exact = (index.byName.get(oldName.toLowerCase()) || []).filter(f => !used.has(f))
  if (exact.length === 1) return { to: exact[0], confidence: 'exact' }
  if (exact.length > 1) return { ambiguous: exact }

  const key = normaliseStem(oldName)
  const title = normaliseText(item.title)
  const author = normaliseText(item.author)
  if (!key && !title) return null
  const oldExt = path.extname(oldName).toLowerCase()

  const cands = index.entries.filter(e => !used.has(e.full))
  const eq = (n, k) => k && (n === k || (author && (n === `${author} ${k}` || n === `${k} ${author}`)))
  // Tier 1: normalised stem equals the old stem or the catalogue title (optionally "Author Title").
  let hits = cands.filter(e => eq(e.norm, key) || eq(e.norm, title))
  // Tier 2: the candidate stem ends with the key ("author title" where author wasn't recorded).
  if (!hits.length && key.length >= 8) hits = cands.filter(e => e.norm.endsWith(' ' + key) || e.norm === key)
  // Tier 3: containment, same extension only, and prefer the shortest (least extra words).
  if (!hits.length && key.length >= 12) {
    const c = cands.filter(e => e.ext === oldExt && (e.norm.includes(key) || (title.length >= 12 && e.norm.includes(title))))
    if (c.length) {
      const min = Math.min(...c.map(e => e.norm.length))
      hits = c.filter(e => e.norm.length === min)
    }
  }
  if (hits.length === 1) return { to: hits[0].full, confidence: 'title' }
  if (hits.length > 1) {
    // Same-extension candidates beat a format change; then an exact-title candidate beats a
    // "Title IV" / "Title Bonus Epilogue" one.
    const sameExt = hits.filter(e => e.ext === oldExt)
    const pool = sameExt.length ? sameExt : hits
    const tight = pool.filter(e => eq(e.norm, key) || eq(e.norm, title))
    if (tight.length === 1) return { to: tight[0].full, confidence: 'title' }
    if (pool.length === 1) return { to: pool[0].full, confidence: 'title' }
    return { ambiguous: pool.map(e => e.full) }
  }
  return null
}

// items: [{ id, path, title, author }] — every linked file that is missing on disk.
// Returns { relinked: [{id, from, to, confidence}], ambiguous: [{id, from, candidates}], notFound: [id], roots, scanned }
function relinkMissing(items, opts = {}) {
  const home = opts.home || process.env.HOME || ''
  const list = (Array.isArray(items) ? items : []).filter(x => x && typeof x.path === 'string' && x.path)
  const roots = new Set()
  for (const it of list) {
    const r = nearestExistingDir(it.path, home)
    if (r && r !== home && r !== path.dirname(home)) roots.add(r)
  }
  // Drop roots that are inside another chosen root (avoid double scanning).
  const rootList = [...roots].filter(r => ![...roots].some(o => o !== r && r.startsWith(o + path.sep)))
  const index = buildIndex(rootList)
  const used = new Set()
  const relinked = [], ambiguous = [], notFound = []
  // Exact matches first so a renamed sibling can't steal a file that still exists under its old name.
  const pending = []
  for (const it of list) {
    const exact = index.byName.get(path.basename(it.path).toLowerCase()) || []
    if (exact.length === 1 && !used.has(exact[0])) { used.add(exact[0]); relinked.push({ id: it.id, from: it.path, to: exact[0], confidence: 'exact' }) }
    else pending.push(it)
  }
  for (const it of pending) {
    const m = matchOne(it, index, used)
    if (m && m.to) { used.add(m.to); relinked.push({ id: it.id, from: it.path, to: m.to, confidence: m.confidence }) }
    else if (m && m.ambiguous) ambiguous.push({ id: it.id, from: it.path, candidates: m.ambiguous.slice(0, 5) })
    else notFound.push(it.id)
  }
  return { relinked, ambiguous, notFound, roots: rootList, scanned: index.scanned }
}

module.exports = { relinkMissing, normaliseStem, nearestExistingDir, buildIndex }
