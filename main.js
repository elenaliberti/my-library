const { app, BrowserWindow, ipcMain, dialog, shell, session, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')

const DATA_PATH = path.join(app.getPath('userData'), 'library-data.json')
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png')

function createWindow() {
  const icon = nativeImage.createFromPath(ICON_PATH)
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafaf9',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // Always load fresh renderer code: drop any stale V8 bytecode cache from a
  // previous app version before loading, so code updates always take effect.
  session.defaultSession.clearCodeCaches({ urls: [] }).finally(() => {
    win.loadFile('src/index.html')
  })
}

app.whenReady().then(() => {
  const icon = nativeImage.createFromPath(ICON_PATH)
  if (process.platform === 'darwin') app.dock.setIcon(icon)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// ── Data ──────────────────────────────────────────────────────────────────────
ipcMain.handle('data:load', () => {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = fs.readFileSync(DATA_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return { items: parsed, folderConfig: {}, deletedIds: {} }
      if (parsed && parsed.items) return { items: parsed.items, folderConfig: parsed.folderConfig || {}, deletedIds: parsed.deletedIds || {} }
    }
    return null
  } catch { return null }
})

ipcMain.handle('data:save', (_, data) => {
  try {
    const toSave = Array.isArray(data) ? { items: data, folderConfig: {} } : data
    fs.writeFileSync(DATA_PATH, JSON.stringify(toSave, null, 2), 'utf-8')
    return true
  } catch { return false }
})

ipcMain.handle('data:export-path', async () => {
  const { filePath } = await dialog.showSaveDialog({
    title: 'Export to Excel',
    defaultPath: path.join(app.getPath('downloads'), 'my-library.xlsx'),
    filters: [{ name: 'Excel', extensions: ['xlsx'] }]
  })
  return filePath || null
})

ipcMain.handle('data:open-location', () => {
  shell.showItemInFolder(DATA_PATH)
})

// ── Local ebook file linking ────────────────────────────────────────────────────
// Opens a book's linked PDF/EPUB with whatever app the user has set as the system default.
ipcMain.handle('files:open-local', (_, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'That file no longer exists at its linked location.' }
  const err = shell.openPath(filePath)
  return err ? { error: err } : { ok: true }
})

// Manual override for books the auto-matcher couldn't confidently link — lets the user pick
// any file directly instead.
ipcMain.handle('files:pick-local', async () => {
  const { filePaths } = await dialog.showOpenDialog({
    title: 'Link a book file',
    properties: ['openFile'],
    filters: [{ name: 'Ebook', extensions: ['pdf', 'epub'] }],
  })
  return filePaths?.[0] || null
})

// ── Electron-native fetch (uses Chromium TLS — bypasses Cloudflare JA3 checks) ─
let _fetchSession = null
function getFetchSession() {
  if (!_fetchSession) _fetchSession = session.fromPartition('persist:fetch')
  return _fetchSession
}

async function electronFetch(url, preCookies = []) {
  const s = getFetchSession()
  for (const c of preCookies) await s.cookies.set(c)
  const resp = await s.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    }
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

function isRealWorkPage(html) {
  return html.length > 20000 && (
    html.includes('class="work meta') ||
    html.includes('rel="author"') ||
    html.includes('class="title heading"')
  )
}

// ── AO3 fetch ─────────────────────────────────────────────────────────────────
ipcMain.handle('ao3:fetch', async (_, url) => {
  try {
    url = url.replace('archive.transformativeworks.org', 'archiveofourown.org')  // alternate AO3 domain
    // /works/{id}/chapters/{cid} → strip to the work; a bare /chapters/{cid} is fetched as-is (AO3 redirects it to the work)
    const workUrl = url.includes('/works/') ? url.replace(/\/chapters\/[^?#]+/, '').replace(/#.*$/, '') : url.replace(/#.*$/, '')
    const fetchUrl = workUrl.includes('?') ? workUrl + '&view_adult=true' : workUrl + '?view_adult=true'

    // Pre-set age verification cookie so AO3 doesn't redirect to warning page
    const ao3Cookies = [
      { url: 'https://archiveofourown.org', name: 'age_verified', value: '1' },
      { url: 'https://archiveofourown.org', name: 'view_adult', value: 'true' },
    ]

    let html = await electronFetch(fetchUrl, ao3Cookies)

    // If we got a challenge/interstitial page, wait 2s and retry once
    if (!isRealWorkPage(html)) {
      await new Promise(r => setTimeout(r, 2000))
      html = await electronFetch(fetchUrl, ao3Cookies)
    }

    if (!isRealWorkPage(html)) {
      if (/id="loginform"|name="user\[login\]"|name="user_session\[login\]"|>\s*Log\s*In\s*<\/|Please log in|registered users of the Archive/i.test(html)) {
        return { error: '🔒 This work is locked — only logged-in AO3 users can see it. Use “🔑 AO3 login”, then try again.', needsLogin: true }
      }
      return { error: 'AO3 is busy right now — please try again in a few seconds.' }
    }

    const stripTags = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    const getSection = cls => { const m = html.match(new RegExp(`<dd[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/dd>`, 'i')); return m ? m[1] : null }
    const firstTag = s => { const m = (s||'').match(/<a[^>]*class="[^"]*tag[^"]*"[^>]*>([^<]+)<\/a>/i); return m ? m[1].trim() : null }
    const allTags = s => { const tags = []; const r = /<a[^>]*class="[^"]*tag[^"]*"[^>]*>([^<]+)<\/a>/gi; let m; while ((m = r.exec(s||'')) !== null) tags.push(m[1].trim()); return tags }

    const titleBlock = html.match(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)
    const title = titleBlock
      ? stripTags(titleBlock[1])
      : html.match(/<title>([^|<]+)/i)?.[1]?.replace(/ - Archive of Our Own$/, '').trim() || null

    const authorMatch = html.match(/<a[^>]*rel="author"[^>]*>([^<]+)<\/a>/i)
    const author = authorMatch ? authorMatch[1].trim() : null

    const fandomSection = getSection('fandom')
    const fandoms = allTags(fandomSection)

    const wordsText = stripTags(getSection('words') || '').replace(/,/g, '')
    const words = wordsText ? parseInt(wordsText) || null : null

    const kudosText = stripTags(getSection('kudos') || '').replace(/,/g, '')
    const kudos = kudosText ? parseInt(kudosText) || null : null

    const rating = firstTag(getSection('rating'))
    const pairing = firstTag(getSection('relationship'))
    const tags = allTags(getSection('freeform')).slice(0, 6)

    // The author's own "Summary:" blurb — front matter they wrote specifically to preview the
    // fic, same idea as a book's back-cover synopsis. Paragraphs are <p> tags inside the
    // blockquote; keep the breaks between them instead of squashing everything onto one line.
    const summaryBlock = html.match(/<div class="summary module">[\s\S]*?<blockquote class="userstuff">([\s\S]*?)<\/blockquote>/i)
    const description = summaryBlock
      ? decodeHtmlEntities(summaryBlock[1].replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim()
      : null

    return { title, author, fandom: fandoms[0] || null, words, hearts: kudos, rating, pairing, tags, description }
  } catch(e) { return { error: e.message } }
})

ipcMain.handle('shell:open-external', (_, url) => {
  shell.openExternal(url)
})

// Open an AO3 login window in the SAME session the scraper uses (persist:fetch),
// so afterwards locked / restricted works can be fetched with the login cookie.
ipcMain.handle('ao3:login', async () => {
  return await new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520, height: 700, title: 'Log in to AO3',
      autoHideMenuBar: true,
      webPreferences: { partition: 'persist:fetch' },
    })
    win.loadURL('https://archiveofourown.org/users/login')
    let done = false
    const finish = (ok) => { if (done) return; done = true; resolve({ ok }); if (!win.isDestroyed()) win.close() }
    // After a successful login AO3 redirects away from /users/login (to the dashboard/home).
    win.webContents.on('did-navigate', (_e, navUrl) => {
      if (/archiveofourown\.org/.test(navUrl) && !/\/users\/login/.test(navUrl)) finish(true)
    })
    win.on('closed', () => { if (!done) { done = true; resolve({ ok: true, closed: true }) } })
  })
})

// Whether the scraper session currently holds an AO3 login cookie.
ipcMain.handle('ao3:logged-in', async () => {
  try {
    const cookies = await getFetchSession().cookies.get({ domain: 'archiveofourown.org' })
    return cookies.some(c => /_otwarchive_session|remember_user_token/.test(c.name))
  } catch (e) { return false }
})

// ── FF.net fetch ──────────────────────────────────────────────────────────────
ipcMain.handle('ffnet:fetch', async (_, url) => {
  try {
    const storyMatch = url.match(/fanfiction\.net\/s\/(\d+)/)
    if (!storyMatch) return { error: 'Not a valid fanfiction.net story URL' }
    const storyId = storyMatch[1]
    const fetchUrl = `https://www.fanfiction.net/s/${storyId}/`

    const html = await electronFetch(fetchUrl)
    const stripTags = s => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

    // ── Title + Fandom from <title> tag (most reliable source) ──────────────
    // FF.net format: "Story Title, a Fandom fanfic | FanFiction"
    // or:            "Story Title, a Fandom + Fandom2 Crossover fanfic | FanFiction"
    let title = null, fandom = null
    const pageTitleRaw = html.match(/<title>([^<]+)<\/title>/i)?.[1] || ''
    const pageTitleClean = pageTitleRaw.replace(/\s*\|\s*FanFiction\s*$/i, '').trim()
    const fanficTitleMatch = pageTitleClean.match(/^(.+?),\s+a\s+(.+?)\s+(?:Crossover\s+)?fanfic$/i)
    if (fanficTitleMatch) {
      title = fanficTitleMatch[1].trim()
      fandom = fanficTitleMatch[2].trim()
    } else {
      title = pageTitleClean.replace(/,.*$/, '').trim() || null
    }

    // ── Author from <a href='/u/ID/name'> ───────────────────────────────────
    const authorMatch = html.match(/<a[^>]+href=['"]\/u\/\d+\/[^'"]+['"][^>]*>([^<]+)<\/a>/i)
    const author = authorMatch ? authorMatch[1].trim() : null

    // ── Words + Favs from inline metadata text ───────────────────────────────
    const wordsMatch = html.match(/Words:\s*([\d,]+)/i)
    const words = wordsMatch ? parseInt(wordsMatch[1].replace(/,/g, '')) : null
    const favsMatch = html.match(/Favs:\s*([\d,]+)/i)
    const hearts = favsMatch ? parseInt(favsMatch[1].replace(/,/g, '')) : null

    // ── Fandom fallback from breadcrumb ──────────────────────────────────────
    if (!fandom) {
      const breadcrumb = html.match(/id=['"]pre_story_links['"][^>]*>([\s\S]{0,600}?)(?=<div|<script)/i)
      if (breadcrumb) {
        const links = [...breadcrumb[1].matchAll(/<a[^>]+>([^<]+)<\/a>/g)]
        if (links.length) fandom = links[links.length - 1][1].trim()
      }
    }

    if (!title) return { error: 'Could not read this story — FF.net may be blocking the request. Try again in a moment.' }
    return { title, author, fandom, words, hearts, rating: null, pairing: null, tags: [] }
  } catch(e) { return { error: e.message } }
})

// ── Open Library book fetch ───────────────────────────────────────────────────
// Google's BISAC categories are broad-to-specific, e.g. "Fiction / Fantasy / Epic" — but this
// library's own genre folders put the specific genre first ("Fantasy", "Romance"...). Taking
// category[0] as-is would dump nearly every novel into one giant "Fiction" folder, which is
// worse than the bug we're fixing. Drop generic wrapper segments and a trailing "General".
const GENERIC_TOP_CATEGORIES = new Set(['fiction', 'nonfiction', 'juvenile fiction', 'young adult fiction', 'juvenile nonfiction', 'literary collections'])
function cleanGoogleGenre(raw) {
  if (!raw) return null
  const parts = raw.split('/').map(s => s.trim()).filter(Boolean)
  while (parts.length > 1 && GENERIC_TOP_CATEGORIES.has(parts[0].toLowerCase())) parts.shift()
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === 'general') parts.pop()
  return parts.join(' / ') || null
}

function decodeHtmlEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
}

function normalizeAuthorName(s) {
  return (s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
}
function authorsLikelyMatch(a, b) {
  const wa = normalizeAuthorName(a), wb = normalizeAuthorName(b)
  if (!wa.length || !wb.length) return false
  return wa.some(w => wb.includes(w))
}

// Title/author/ISBN search is inherently fuzzy — the same query can match the wrong edition,
// an omnibus, a translation, etc. A Goodreads book URL names one exact edition, so when the
// "search" field is actually a Goodreads link, scrape that page directly instead of searching.
async function fetchFromGoodreads(url) {
  try {
    const html = await electronFetch(url)

    // Goodreads embeds clean schema.org Book data as JSON-LD — far more reliable than scraping
    // the page's (frequently-changing, hashed) CSS classes.
    let ld = null
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { const parsed = JSON.parse(m[1]); if (parsed['@type'] === 'Book') { ld = parsed; break } } catch {}
    }
    if (!ld) return { error: 'Could not read that as a Goodreads book page — paste the URL from the book\'s main page.' }

    const title = decodeHtmlEntities(ld.name) || null
    const authorList = Array.isArray(ld.author) ? ld.author : (ld.author ? [ld.author] : [])
    const author = authorList.map(a => decodeHtmlEntities(a?.name)).filter(Boolean).slice(0, 2).join(', ') || null
    const pages = ld.numberOfPages || null
    const cover = ld.image || null

    // The genre buttons render in relevance order right in the page HTML — the first one lines
    // up well with how this library already names its top-level genre folders.
    let genre = null
    const genreSection = html.match(/aria-label="Top genres for this book"([\s\S]{0,4000})/)
    if (genreSection) {
      const labels = [...genreSection[1].matchAll(/class="Button__labelItem">([^<]+)<\/span>/g)]
        .map(m => decodeHtmlEntities(m[1]))
        .filter(g => !/^(\.\.\.more|book details)/i.test(g))
      genre = labels[0] || null
    }

    return { title, author, pages, genre, cover, source: 'Goodreads' }
  } catch (e) { return { error: e.message } }
}

// Amazon sometimes serves a bot-check/CAPTCHA page to a plain fetch even when the same request
// would sail through in a real browser — so this loads the page in a hidden, genuinely-rendering
// BrowserWindow (same fix as the Goodreads *search* endpoint needed) instead of electronFetch.
async function fetchHtmlViaBrowser(url) {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } })
  try {
    await win.loadURL(url)
    await new Promise(r => setTimeout(r, 1500))
    return await win.webContents.executeJavaScript('document.documentElement.outerHTML')
  } finally {
    win.destroy()
  }
}

// Amazon has no JSON-LD for product pages, so this leans on the same handful of element IDs
// Amazon uses across every locale (productTitle, bylineInfo, landingImage) — plain-text/attribute
// scraping, same tradeoff as Goodreads's genre buttons above.
async function fetchFromAmazon(url) {
  try {
    const html = await fetchHtmlViaBrowser(url)
    if (/Enter the characters you see below|Sorry, we just need to make sure/i.test(html)) {
      return { error: 'Amazon showed a bot-check page — wait a moment and try again.' }
    }

    const titleMatch = html.match(/id="productTitle"[^>]*>([^<]+)</)
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : null
    if (!title) return { error: 'Could not read that as an Amazon book page — paste the URL from the book\'s product page.' }

    const authorMatch = html.match(/<div id="bylineInfo"[\s\S]{0,1200}?<a[^>]*>([^<]+)<\/a>/)
    const author = authorMatch ? decodeHtmlEntities(authorMatch[1].replace(/\s+/g, ' ').trim()) : null

    // "Print length" covers Kindle editions; paperback/hardcover listings use "Paperback"/"Hardcover" instead.
    const pagesMatch = html.match(/(?:Print length|Paperback|Hardcover):\s*(\d+)\s*pages/)
    const pages = pagesMatch ? parseInt(pagesMatch[1]) : null

    // data-a-dynamic-image is a JSON map of {url: [w,h]} — the entries are already ordered
    // smallest-to-largest, so the last key is the highest-resolution cover art available.
    let cover = null
    const imgMatch = html.match(/id="landingImage"[^>]*data-a-dynamic-image="([^"]+)"/)
    if (imgMatch) {
      try {
        const urls = Object.keys(JSON.parse(decodeHtmlEntities(imgMatch[1])))
        cover = urls[urls.length - 1] || null
      } catch {}
    }

    // The "Best Sellers Rank" list's first category link is Amazon's own best-genre guess for
    // the book — mirrors how the Goodreads path takes the first (most relevant) genre button.
    let genre = null
    const rankSection = html.match(/Best Sellers Rank:[\s\S]{0,1500}?<\/ul>/)
    if (rankSection) {
      const catMatch = rankSection[0].match(/<a href=['"][^'"]*\/bestsellers\/books\/[^'"]*['"]>([^<]+)<\/a>/)
      genre = catMatch ? decodeHtmlEntities(catMatch[1]).replace(/\s*eBooks?$/i, '').trim() : null
    }

    return { title, author, pages, genre, cover, source: 'Amazon' }
  } catch (e) { return { error: e.message } }
}

function stripHtml(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

// Short publisher-provided synopsis for the mood picker's "why this book" card — Google Books'
// `description` field is the jacket-copy blurb, not the book's actual text, same as what any
// bookstore or library catalog shows. Falls back to OpenLibrary's work description when Google
// has nothing for that edition.
// Study-guide/commentary publishers that keep outranking the real novel in Goodreads search —
// same list used by the cover-backfill batch job earlier, moved here so the live app shares it.
const KNOWN_STUDY_GUIDE_PUBLISHERS = /supersummary|bookrags|hephaestus books|gloria cooke|larissa duval|ren[ée] henri|litcharts|cliffsnotes|sparknotes/i

// Checks several Goodreads search results (not just the first) and only trusts the description
// off a page once its own JSON-LD author actually matches — otherwise a study-guide edition
// silently wins, exactly like it did for cover art before that got the same fix.
// Kept alive across calls — spinning up a fresh hidden BrowserWindow per lookup was adding
// several hundred ms of pure window-creation overhead on top of an already-slow page-load chain.
let _descWin = null
function getDescWin() {
  if (!_descWin || _descWin.isDestroyed()) {
    // backgroundThrottling:false matters here — macOS App Nap silently stalls a hidden window's
    // JS/timers once it's been in the background a while, which reads exactly like "hangs
    // forever" from the renderer's side even though nothing actually errored.
    _descWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } })
  }
  return _descWin
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms (${label})`)), ms)),
  ])
}

async function fetchGoodreadsDescription(title, author) {
  const win = getDescWin()
  await win.loadURL(`https://www.goodreads.com/search?q=${encodeURIComponent(`${title} ${author || ''}`)}`)
  await new Promise(r => setTimeout(r, 1800))
  const searchHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
  const linkMatches = [...searchHtml.matchAll(/href="(\/book\/show\/[0-9]+[^"]*)"/g)]
  // Capped at 3 (was 5) — this runs live while someone's waiting on a UI, not in a background
  // batch job, so worst-case latency matters more than exhausting every possible candidate.
  const candidateUrls = [...new Set(linkMatches.map(m => `https://www.goodreads.com${m[1].replace(/&amp;/g, '&')}`))].slice(0, 3)

  for (const bookUrl of candidateUrls) {
    await win.loadURL(bookUrl)
    await new Promise(r => setTimeout(r, 1000))
    const bookHtml = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
    let ld = null
    for (const m of bookHtml.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try { const parsed = JSON.parse(m[1]); if (parsed['@type'] === 'Book') { ld = parsed; break } } catch {}
    }
    if (!ld) continue
    const ldAuthorNames = (Array.isArray(ld.author) ? ld.author : (ld.author ? [ld.author] : [])).map(a => a?.name).filter(Boolean).join(', ')
    if (KNOWN_STUDY_GUIDE_PUBLISHERS.test(ldAuthorNames)) continue
    if (author && !authorsLikelyMatch(author, ldAuthorNames)) continue

    // og:description is only ever Goodreads' own truncated ~150-character SEO snippet (note the
    // trailing "…" even mid-sentence) — the full blurb lives in the page's own description
    // block instead, under data-testid="description". Falls back to the truncated og tag only
    // if that block isn't there for some reason.
    let desc = null
    const fullDescMatch = bookHtml.match(/data-testid="description"[\s\S]*?data-testid="contentContainer">([\s\S]*?)<\/div><div class="">/)
    if (fullDescMatch) {
      desc = decodeHtmlEntities(fullDescMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim()
    }
    if (!desc) {
      const ogDesc = bookHtml.match(/<meta property="og:description" content="([^"]*)"/)
      desc = ogDesc ? decodeHtmlEntities(ogDesc[1]) : null
    }
    if (desc && !KNOWN_STUDY_GUIDE_PUBLISHERS.test(desc)) return desc
  }
  return null
}

// Retries a fetch+parse a couple of times on a 429 before giving up — OpenLibrary throttles
// bursts (e.g. clicking "pick another" a few times fast) rather than blocking outright.
async function fetchJsonWithRetry(url, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = await electronFetch(url)
      return JSON.parse(raw)
    } catch (e) {
      if (/HTTP 429/.test(e.message) && i < attempts - 1) {
        await new Promise(r => setTimeout(r, 1500 * (i + 1)))
        continue
      }
      throw e
    }
  }
}

const DESC_LOG_PATH = path.join(app.getPath('userData'), 'description-debug.log')
function descLog(msg) {
  try { fs.appendFileSync(DESC_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

ipcMain.handle('books:description', async (_, { title, author }) => {
  descLog(`--- request: "${title}" by "${author}" ---`)
  // Google Books' anonymous quota has been fully exhausted for a while now (every call 429s),
  // so it's skipped entirely here rather than burning a guaranteed-failing round trip on every
  // single request — that was roughly doubling latency and, worse, eating into the retry budget
  // that OpenLibrary actually needs when a few "pick another" clicks land close together.
  try {
    const sData = await withTimeout(fetchJsonWithRetry(`https://openlibrary.org/search.json?q=${encodeURIComponent(`${title} ${author || ''}`)}&fields=key&limit=1`), 15000, 'OL search')
    const workKey = sData.docs?.[0]?.key
    descLog(`OpenLibrary workKey: ${workKey || 'none'}`)
    if (workKey) {
      const wData = await withTimeout(fetchJsonWithRetry(`https://openlibrary.org${workKey}.json`), 15000, 'OL work')
      const desc = typeof wData.description === 'string' ? wData.description : wData.description?.value
      if (desc) { descLog('OpenLibrary: found description'); return { description: stripHtml(desc), source: 'OpenLibrary' } }
      descLog('OpenLibrary: work has no description field')
    }
  } catch (e) { descLog(`OpenLibrary ERROR: ${e.message}`) }

  // Goodreads has far better coverage of self-pub/indie titles than OpenLibrary or Google
  // Books — worth the extra few seconds of real-browser search since those are exactly the
  // books most likely to come up empty otherwise. Hard-capped at 10s total so a stalled hidden
  // window (or a slow Goodreads response) can't hang the whole request indefinitely.
  try {
    const desc = await withTimeout(fetchGoodreadsDescription(title, author), 25000, 'Goodreads')
    if (desc) { descLog('Goodreads: found description'); return { description: desc, source: 'Goodreads' } }
    descLog('Goodreads: no matching candidate had a usable description')
  } catch (e) {
    descLog(`Goodreads ERROR: ${e.message}`)
    // A timed-out or crashed lookup can leave the shared window in a bad state — drop it so
    // the next request starts clean instead of inheriting whatever it was stuck doing.
    if (_descWin && !_descWin.isDestroyed()) { _descWin.destroy(); _descWin = null }
  }

  try {
    const gUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:${title}${author ? ' inauthor:' + author : ''}`)}&maxResults=1`
    const gData = await withTimeout(fetchJsonWithRetry(gUrl, 1), 10000, 'Google Books')
    const desc = gData.items?.[0]?.volumeInfo?.description
    if (desc) { descLog('Google Books: found description'); return { description: stripHtml(desc), source: 'Google Books' } }
  } catch (e) { descLog(`Google Books ERROR: ${e.message}`) }

  descLog('No description found from any source.')
  return { description: null }
})

// Google Books first (cleaner categories, real cover art, usually better match quality),
// falling back to OpenLibrary (broader catalog, especially for older/foreign editions) if
// Google has nothing, is unreachable, or rate-limits us — anonymous Google Books quota is
// shared per-IP and can run dry on busy networks, so this must never be the only path.
// A pasted Goodreads or Amazon book URL skips search entirely and scrapes that exact edition.
ipcMain.handle('books:fetch', async (_, query) => {
  if (/goodreads\.com\/book\/show/i.test(query)) return await fetchFromGoodreads(query.trim())
  if (/amazon\.[a-z.]+\/.*\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(query)) return await fetchFromAmazon(query.trim())
  try {
    const gUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=1`
    const gRaw = await electronFetch(gUrl)
    const gData = JSON.parse(gRaw)
    const vol = (gData.items || [])[0]?.volumeInfo
    if (vol && vol.title) {
      const genre = cleanGoogleGenre((vol.categories || [])[0])
      const cover = (vol.imageLinks?.thumbnail || vol.imageLinks?.smallThumbnail || '').replace(/^http:/, 'https:') || null
      return {
        title: vol.title || null,
        author: (vol.authors || []).slice(0, 2).join(', ') || null,
        pages: vol.pageCount || null,
        genre,
        cover,
        source: 'Google Books',
      }
    }
  } catch (e) { /* fall through to OpenLibrary */ }

  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=3&fields=title,author_name,number_of_pages_median,subject,cover_i`
    const raw = await electronFetch(url)
    const data = JSON.parse(raw)
    const doc = (data.docs || [])[0]
    if (!doc) return { error: 'Book not found' }
    // OpenLibrary's subject list is unordered and mixes languages, catalog noise (NYT list
    // tags, call numbers) and genuine genres — picking index [0] blindly gave things like
    // "Fantasía" instead of "Fantasy", which then never matched the user's existing folder.
    // Filter out obvious noise, then prefer a clean ASCII (English) entry if one exists.
    const rawSubjects = doc.subject || []
    const looksLikeGenre = s => s.length < 35 && !/[:\d]/.test(s) && !/new york times|bestseller|large (type|print)/i.test(s)
    const candidates = rawSubjects.filter(looksLikeGenre)
    const isAsciiClean = s => /^[\x20-\x7E]*$/.test(s)
    const genre = candidates.find(isAsciiClean) || candidates[0] || rawSubjects[0] || null
    const cover = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : null
    return {
      title: doc.title || null,
      author: (doc.author_name || []).slice(0, 2).join(', ') || null,
      pages: doc.number_of_pages_median || null,
      genre: genre || null,
      cover,
      source: 'OpenLibrary',
    }
  } catch(e) { return { error: e.message } }
})

// ── Git backup ────────────────────────────────────────────────────────────────
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout.trim())
    })
  })
}

// Find git — could be in /usr/bin or /usr/local/bin or via Xcode tools
async function findGit() {
  for (const p of ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']) {
    if (fs.existsSync(p)) return p
  }
  throw new Error('Git not found. Make sure you completed Step 2 of the GitHub setup.')
}

ipcMain.handle('git:status', async () => {
  try {
    const git = await findGit()
    const appDir = path.dirname(app.getPath('exe'))
    // Find the actual project root (where .git lives)
    const candidates = [
      path.join(app.getPath('userData'), '..', '..', '..', 'Downloads', 'library-app'),
      process.cwd(),
      path.join(__dirname),
    ]
    let repoDir = null
    for (const c of candidates) {
      try {
        const resolved = path.resolve(c)
        if (fs.existsSync(path.join(resolved, '.git'))) { repoDir = resolved; break }
      } catch {}
    }
    if (!repoDir) return { ok: false, error: 'Git repo not found. Run the GitHub setup steps first.' }

    // Check remote
    let remote = ''
    try { remote = await run(git, ['remote', 'get-url', 'origin'], repoDir) } catch {}

    // Get last commit date
    let lastBackup = ''
    try {
      lastBackup = await run(git, ['log', '-1', '--format=%ar'], repoDir)
    } catch {}

    return { ok: true, repoDir, remote, lastBackup }
  } catch(e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('git:backup', async () => {
  try {
    const git = await findGit()

    // Find repo dir
    const candidates = [
      path.join(app.getPath('home'), 'Downloads', 'library-app'),
      path.join(__dirname),
      process.cwd(),
    ]
    let repoDir = null
    for (const c of candidates) {
      try {
        const resolved = path.resolve(c)
        if (fs.existsSync(path.join(resolved, '.git'))) { repoDir = resolved; break }
      } catch {}
    }
    if (!repoDir) return { ok: false, error: 'Git repo not found. Complete the GitHub setup steps first.' }

    // Copy current data file into repo so it gets committed
    const repoDataPath = path.join(repoDir, 'library-data.json')
    if (fs.existsSync(DATA_PATH)) {
      fs.copyFileSync(DATA_PATH, repoDataPath)
    }

    // git add + commit + push
    await run(git, ['add', '.'], repoDir)

    // Check if there's anything to commit
    let status = ''
    try { status = await run(git, ['status', '--porcelain'], repoDir) } catch {}
    if (!status) return { ok: true, message: 'Already up to date — nothing new to back up.' }

    const now = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    await run(git, ['commit', '-m', `Library backup — ${now}`], repoDir)
    let pushed = false
    // Try main, then master
    for (const branch of ['main', 'master']) {
      try { await run(git, ['push', 'origin', branch], repoDir); pushed = true; break }
      catch {
        // Remote is ahead (e.g. the phone saved). The data file was already merged at the
        // record level before this backup, so keep our version on any conflict, then retry.
        try {
          await run(git, ['pull', '--no-rebase', '--no-edit', '-X', 'ours', 'origin', branch], repoDir)
          await run(git, ['push', 'origin', branch], repoDir); pushed = true; break
        } catch {}
      }
    }
    if (!pushed) {
      return { ok: true, message: `Saved locally at ${now} ✓ (GitHub push failed — add a token to the remote URL to fix)` }
    }

    return { ok: true, message: `Backed up to GitHub at ${now} ✓` }
  } catch(e) {
    const isCredErr = e.message.includes('Username') || e.message.includes('could not read') || e.message.includes('Authentication')
    if (isCredErr) {
      return { ok: false, error: 'GitHub auth failed. In Terminal run:\ngit remote set-url origin https://elenaliberti:YOUR_TOKEN@github.com/elenaliberti/my-library.git\n(get a token at github.com → Settings → Developer settings → PAT)' }
    }
    return { ok: false, error: e.message }
  }
})

// Read the latest data file from GitHub WITHOUT touching the working tree (safe, no merge conflicts).
ipcMain.handle('git:pull-data', async () => {
  try {
    const git = await findGit()
    const candidates = [
      path.join(app.getPath('home'), 'Downloads', 'library-app'),
      path.join(__dirname),
      process.cwd(),
    ]
    let repoDir = null
    for (const c of candidates) {
      try {
        const resolved = path.resolve(c)
        if (fs.existsSync(path.join(resolved, '.git'))) { repoDir = resolved; break }
      } catch {}
    }
    if (!repoDir) return { ok: false, error: 'Git repo not found.' }

    await run(git, ['fetch', 'origin'], repoDir)
    let raw = null
    for (const branch of ['main', 'master']) {
      try { raw = await run(git, ['show', `origin/${branch}:library-data.json`], repoDir); break } catch {}
    }
    if (raw == null) return { ok: true, data: null }
    const parsed = JSON.parse(raw)
    const data = Array.isArray(parsed)
      ? { items: parsed, folderConfig: {}, deletedIds: {} }
      : { items: parsed.items || [], folderConfig: parsed.folderConfig || {}, deletedIds: parsed.deletedIds || {} }
    return { ok: true, data }
  } catch(e) { return { ok: false, error: e.message } }
})
