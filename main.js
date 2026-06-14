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
  win.loadFile('src/index.html')
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
      if (Array.isArray(parsed)) return { items: parsed, folderConfig: {} }
      if (parsed && parsed.items) return { items: parsed.items, folderConfig: parsed.folderConfig || {} }
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
    const workUrl = url.replace(/\/chapters\/[^?#]+/, '').replace(/#.*$/, '')
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
ipcMain.handle('books:fetch', async (_, query) => {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=3&fields=title,author_name,number_of_pages_median,subject`
    const raw = await electronFetch(url)
    const data = JSON.parse(raw)
    const doc = (data.docs || [])[0]
    if (!doc) return { error: 'Book not found' }
    const subjects = (doc.subject || []).filter(s => s.length < 35)
    const genre = subjects[0] || null
    return {
      title: doc.title || null,
      author: (doc.author_name || []).slice(0, 2).join(', ') || null,
      pages: doc.number_of_pages_median || null,
      genre: genre || null,
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
      try { await run(git, ['push', 'origin', branch], repoDir); pushed = true; break } catch {}
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
