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

    return { title, author, fandom: fandoms[0] || null, words, hearts: kudos, rating, pairing, tags }
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

// Google Books first (cleaner categories, real cover art, usually better match quality),
// falling back to OpenLibrary (broader catalog, especially for older/foreign editions) if
// Google has nothing, is unreachable, or rate-limits us — anonymous Google Books quota is
// shared per-IP and can run dry on busy networks, so this must never be the only path.
ipcMain.handle('books:fetch', async (_, query) => {
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
