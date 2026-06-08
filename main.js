const { app, BrowserWindow, ipcMain, dialog, shell, session, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const https = require('https')
const { execFile } = require('child_process')

function nodeGet(urlStr, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, port: 443,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.5',
        ...extraHeaders,
      },
    }
    const req = https.get(opts, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://${u.hostname}${res.headers.location}`
        return nodeGet(loc, extraHeaders).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')) })
    req.on('error', reject)
  })
}

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
      if (parsed && parsed.length > 0) return parsed
    }
    return null
  } catch { return null }
})

ipcMain.handle('data:save', (_, items) => {
  try { fs.writeFileSync(DATA_PATH, JSON.stringify(items, null, 2), 'utf-8'); return true }
  catch { return false }
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

// ── AO3 fetch ─────────────────────────────────────────────────────────────────
function curlGet(url) {
  // Normalise to work root URL (strip chapter fragments) and add view_adult=true
  const workUrl = url.replace(/\/chapters\/[^?#]+/, '').replace(/#.*$/, '')
  const fetchUrl = workUrl.includes('?') ? workUrl + '&view_adult=true' : workUrl + '?view_adult=true'

  return new Promise((resolve, reject) => {
    execFile('curl', [
      '-s', '-L', '--max-time', '20',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      '-H', 'Accept-Encoding: identity',
      '-H', 'Cache-Control: no-cache',
      '-H', 'Sec-Fetch-Dest: document',
      '-H', 'Sec-Fetch-Mode: navigate',
      '-H', 'Sec-Fetch-Site: none',
      '-H', 'Sec-Fetch-User: ?1',
      fetchUrl,
    ], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(new Error(err.message))
      else resolve(stdout)
    })
  })
}

ipcMain.handle('ao3:fetch', async (_, url) => {
  try {
    const html = await curlGet(url)

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

// ── Open Library book fetch ───────────────────────────────────────────────────
ipcMain.handle('books:fetch', async (_, query) => {
  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=3&fields=title,author_name,number_of_pages_median,subject`
    const raw = await nodeGet(url, { 'Accept': 'application/json' })
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
    await run(git, ['push', 'origin', 'main'], repoDir)

    return { ok: true, message: `Backed up to GitHub at ${now} ✓` }
  } catch(e) {
    // push might fail if branch is 'master' not 'main'
    if (e.message.includes('main')) {
      try {
        const git = await findGit()
        const repoDir = path.join(app.getPath('home'), 'Downloads', 'library-app')
        await run(git, ['push', 'origin', 'master'], repoDir)
        return { ok: true, message: 'Backed up to GitHub ✓' }
      } catch(e2) {
        return { ok: false, error: e2.message }
      }
    }
    return { ok: false, error: e.message }
  }
})
