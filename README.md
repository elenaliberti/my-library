# My Library 📚

Personal reading tracker for fanfiction and books. Runs as a native Mac app.

## First launch

1. Make sure you have **Node.js** installed — download from https://nodejs.org (pick the LTS version)
2. Open **Terminal** and navigate to this folder:
   ```
   cd ~/Downloads/my-library
   ```
3. Run the setup script:
   ```
   bash setup.sh
   ```
   This installs dependencies (~1 min) and launches the app.

## After that

To open the app any time:
```
cd ~/Downloads/my-library
npm start
```

Or **add it to your Dock**: after running once, go to  
`dist/mac/My Library.app` → right-click → **Open** → drag to Dock.

To build a standalone `.app`:
```
npm run dist
```
Then drag `dist/mac-unpacked/My Library.app` into your Applications folder.

## Your data

All your entries are saved to:
`~/Library/Application Support/my-library/library-data.json`

Use **⚙️ Settings → 📁 Open data folder** in the app to open that folder directly.

Safety nets, all in that same folder:

- Every save is atomic (written to a temp file, then swapped in), so a crash mid-save can't truncate the library.
- `library-data.json.bak` is always the previous good save.
- `backups/` holds one dated snapshot per day for the last 14 days.
- If the main file ever fails to parse, the app restores from the newest readable copy and tells you — it never falls back to the bundled seed list over a real library.

## Sync between Mac and phone

`☁️ Back up` merges in whatever the phone saved to GitHub (deletions are tracked with tombstones so they don't come back), then commits and pushes `library-data.json`. `🔄 Sync` pulls and merges without pushing. The phone version lives in `docs/` and is served from GitHub Pages.

## Features

- Paste an AO3 / FF.net URL → auto-fills title, author, fandom, word count, kudos, rating, tags and summary
- Book auto-fill from Google Books / Open Library, or paste a Goodreads / Amazon link for an exact edition
- Folder browsing by fandom → pairing / trope, and by genre → series (drag books onto a series to file them)
- MySpace reading board (TBR → Reading → Finished) that logs start dates and reading pace
- Stats: words read, reading trend, pace, and a per-year reading calendar
- Mood picker for "what should I read next?"
- Star ratings, re-read counts, favourites and personal notes per entry
- Export to Excel from ⚙️ Settings
- ⌘F focuses the search bar · ⌘Z undoes folder changes and series moves · Esc closes any dialog
