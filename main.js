const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { execFile } = require('child_process')

const DATA_PATH = path.join(app.getPath('userData'), 'library-data.json')

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fafaf9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('src/index.html')
}

app.whenReady().then(() => {
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
ipcMain.handle('ao3:fetch', async (_, url) => {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; personal reading tracker)' } })
    const html = await resp.text()
    const get = (pat) => { const m = html.match(pat); return m ? m[1].trim() : null }

    const title = get(/<h2[^>]*class="[^"]*title[^"]*"[^>]*>\s*(?:<[^>]+>)*\s*([^<\n]+)/i)
      || get(/<title>([^|<]+)/i)?.replace(' - Archive of Our Own','').trim()
    const author = get(/rel="author"[^>]*>([^<]+)</i)
    const fandoms = []; const fr = /class="[^"]*fandom[^"]*tag[^"]*"[^>]*>([^<]+)</gi
    let fm; while ((fm = fr.exec(html)) !== null) fandoms.push(fm[1].trim())
    const words = get(/class="[^"]*words[^"]*"[^>]*>\s*([\d,]+)/i)?.replace(/,/g,'')
      || get(/<dd[^>]*class="words"[^>]*>([\d,]+)/i)?.replace(/,/g,'')
    const kudos = get(/class="[^"]*kudos[^"]*"[^>]*>\s*([\d,]+)/i)?.replace(/,/g,'')
      || get(/<dd[^>]*class="kudos"[^>]*>([\d,]+)</i)?.replace(/,/g,'')
    const rating = get(/class="[^"]*rating[^"]*"[^>]*title="([^"]+)"/i)
    const tags = []; const tr2 = /class="[^"]*freeform[^"]*tag[^"]*"[^>]*>([^<]+)</gi
    let tg; let c = 0; while ((tg = tr2.exec(html)) !== null && c < 6) { tags.push(tg[1].trim()); c++ }
    const pairing = get(/class="[^"]*relationship[^"]*tag[^"]*"[^>]*>([^<]+)</i)

    return { title, author, fandom: fandoms[0]||null, words: words?parseInt(words):null, hearts: kudos?parseInt(kudos):null, rating, pairing, tags }
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
