# My Library — code review (18 Sep 2026)

Scope: `main.js`, `preload.js`, `src/app.js`, `src/style.css`, `src/index.html`, `docs/index.html` (phone PWA), packaging, and the live data file (958 entries, audited read-only before any change).

Legend: **Fixed** = implemented in this pass · **Open** = recommendation only.

## 1. Data safety (highest priority)

| # | Finding | Where | Status |
|---|---------|-------|--------|
| 1.1 | Saves used `fs.writeFileSync` straight over the 800 KB data file. A crash or power cut mid-write truncates it; on next launch `data:load` fails to parse, returns `null`, and the renderer **falls back to the 611-entry seed list** — the first edit then saves the seed over the real library. Total-loss scenario. | `main.js` data:save/data:load, `app.js` loadData | **Fixed** — atomic write (temp file → fsync → rename), previous file kept as `.bak`, one dated snapshot per day in `backups/` (last 14). Load falls back through `.bak` → newest snapshot. If a file exists but nothing parses, the app opens in a **read-only recovery screen** and never writes; the seed list is used only when no library file exists at all. |
| 1.2 | `Back up` pushed without pulling. On a rejected push it ran `git pull -X ours`, which **discards the phone's entries wholesale** at the git level whenever the phone had saved since the last Sync. | `main.js` git:backup, `app.js` handleBackup | **Fixed** — Back up now merges the GitHub copy at record level first (tombstone-aware), so `-X ours` is a correct resolution of an already-merged file. |
| 1.3 | The phone app saved `{items, folderConfig}` only, **wiping every deletion tombstone** on each mobile save, and its merge had no tombstone logic, so items deleted on the Mac could resurrect after a phone conflict-merge. Deleting on the phone recorded no tombstone at all. | `docs/index.html` ghSave / mergeLibrary | **Fixed** — `deletedIds` carried through load/save, tombstones applied in the phone's merge with the same rule as the desktop, phone deletes now write a tombstone. |
| 1.4 | Multiple rapid edits fired one full-file write each (star clicks, drags). | `app.js` saveData | **Fixed** — saves are coalesced (latest state always wins); main waits for in-flight writes before quitting and before a git backup. Save failures now surface as a toast instead of being swallowed. |
| 1.5 | `data:load` accepted any object with an `items` key, even if `items` wasn't an array → renderer crash on `.filter`. | `main.js` | **Fixed** — strict shape validation (`shapeLibrary`). |
| 1.6 | `git add .` in Back up committed *anything* in the working tree (half-finished code edits) under a "Library backup" message. | `main.js` | **Fixed** — only `library-data.json` is staged. **Note:** code changes are no longer auto-committed by the app; commit them yourself. |
| 1.7 | Delete had no undo — a mis-click plus the OS confirm sheet lost the entry (only the tombstone remained). | `app.js` | **Fixed** — in-app confirm dialog + 7 s Undo toast that also removes the tombstone. |
| 1.8 | Repo location hard-coded three different ways across the git handlers. | `main.js` | **Fixed** — one `findRepoDir()` (uses `__dirname` first, so `npm start` from any folder works). |

## 2. Correctness bugs

| # | Finding | Where | Status |
|---|---------|-------|--------|
| 2.1 | **Export to Excel never worked**: `require('exceljs')` in a `contextIsolation` renderer throws `require is not defined`. | `app.js` exportToExcel | **Fixed** — workbook built in the main process (`data:export`), with more columns (tags, series, times read, last read, favourite, URL), frozen header row and auto-filter. Verified against all 958 entries. |
| 2.2 | "Open link ↗" in an expanded card was a plain `<a href>` → **navigated the whole app window to AO3**. | `app.js` cardHtml | **Fixed** — button that opens externally; plus `will-navigate` / window-open guards in main so this class of bug can't recur. |
| 2.3 | `files:open-local` didn't `await shell.openPath`, so it always returned a Promise as the "error" (which can't even cross IPC). | `main.js` | **Fixed** |
| 2.4 | Marking Finished from the card's status buttons set `readCount = 1` but left `readDates` as `[]`; `timesRead()` trusts `readDates.length`, so the card said "Read 0 times" and stats excluded it. | `app.js` data-set-status | **Fixed** |
| 2.5 | New fanfiction entries defaulted **Date finished to today even when status was TBR**, so a fic later marked Finished kept its add date as finish date. | `app.js` modalHtml | **Fixed** — defaults to today only when status is Finished. |
| 2.6 | Adding a tag / toggling type in the edit form re-rendered and **lost the star rating, finish date and synopsis** typed so far; clearing a number field kept the old value. | `app.js` snapshotModalForm | **Fixed** |
| 2.7 | AO3 scraper stored HTML entities (`Harry Potter&#39;s Parent`, `Draco &amp; Harry`) — 20 records and 3 group folders in the live data; the phone displayed them literally. | `main.js` ao3:fetch | **Fixed** at the source, and a load-time normaliser repairs existing records (items, folder keys, `groupTags`, `filterTag`) without bumping `_modAt`, so it never out-votes a real phone edit. |
| 2.8 | One record had status `"finished"` (lowercase): uncounted in Finished, no badge colour, no active status button. | live data | **Fixed** by the same normaliser (also maps the phone-only `DNF`/`Paused` to `Dropped`/`Reading`). |
| 2.9 | Phone and desktop disagreed on statuses (`Paused`, `DNF` vs `Dropped`) and on word totals (phone counted unread TBR items). | `docs/index.html` | **Fixed** — aligned to the desktop's four statuses and `timesRead()` rule. |
| 2.10 | `_addedAt` was `items.length` → reused after deletions (30 duplicates today), making "recently added" order ambiguous. | both apps | **Fixed** — monotonic max+1. |
| 2.11 | Title / author / notes / tags / search term were interpolated into HTML unescaped; `esc()` didn't escape `"` (breaks attribute values such as tooltips). Self-XSS via a pasted title or search. | `app.js` | **Fixed** — everything user-controlled goes through `esc()`, plus a Content-Security-Policy on the page. |
| 2.12 | Escape only closed some overlays (not settings, mood picker, move-date). | `app.js` | **Fixed** — one layer per Escape. |
| 2.13 | `pruneEmptyFolderPath` never stepped out of an emptied series folder. | `app.js` | **Fixed** |
| 2.14 | `autoGroupSimilarTags` rewrote folder config on every launch with a deliberately low 0.2 Jaccard threshold and no way back. | `app.js` | **Fixed** — pushes an undo snapshot first; toast has an Undo button; ⌘Z also reverts. |
| 2.15 | Date inputs used `iso.slice(0,10)` (UTC date) while the calendar used local dates → off-by-one east of Greenwich in the evening. | `app.js` | **Fixed** — local-date helper. |
| 2.16 | Undefined CSS variables (`--gray-300/500/800`) made several labels inherit the wrong colour. | `style.css` | **Fixed** |
| 2.17 | `shell.openExternal` accepted any string from a record's `url`. | `main.js` | **Fixed** — http(s) only. |

## 3. Performance

| # | Finding | Status |
|---|---------|--------|
| 3.1 | Every keystroke in search rebuilt ~1 MB of HTML for 958 cards and re-bound every listener. | **Fixed** — 140 ms debounce with caret restore (typing is now instant; 10 chars = one render). |
| 3.2 | 628 cover images requested eagerly on the list view. | **Fixed** — `loading="lazy"`, fade-in on load, emoji fallback on error (no broken-image glyphs). |
| 3.3 | "Recent" sort re-derived `lastReadAt` (array copy) inside the comparator, n·log n times. | **Fixed** — cached per sort. |
| 3.4 | `render()` replaces the whole DOM with `innerHTML` and re-attaches ~60 querySelectorAll batches. | **Open** — fine at 1k items; if the library grows past ~3k, move to event delegation on `#app` and keyed card updates. |
| 3.5 | `syncFromCloud` runs `git fetch` on every launch; offline this can stall for the network timeout (UI stays usable). | **Open** — add a 5 s timeout around `run()` in main. |
| 3.6 | `seed.js` (250 KB) was shipped but never loaded; `library-data.json`, `docs/`, README were packaged into the .app. | **Fixed** — seed.js removed, build excludes added. |

## 4. Security / hygiene (not changed — needs your decision)

- **A GitHub token is embedded in the git remote URL** (`git remote -v` prints it, and so would any error message that echoes the remote). Your global git already has `credential.helper = osxkeychain`; run `git remote set-url origin https://github.com/elenaliberti/my-library.git` and let Keychain hold the token (or `gh auth login`). The in-app error text that recommended putting the token in the URL has been reworded.
- **A second, different token sits in `.claude/settings.local.json`** (line 55, inside a recorded `curl` permission). It isn't committed, but it's plaintext on disk — revoke it at github.com → Settings → Developer settings and delete that line.
- Electron 28 is ~3 years old. Upgrading to a current Electron is a separate task (test the AO3 fetch session, `sandbox`, and `session.fetch` afterwards).

## 5. Edge cases worth knowing about (behaviour, not bugs)

- Tombstones expire after 365 days on both apps; an item deleted over a year ago that still exists on a stale device would come back.
- Series folders are scoped per genre: "Billionaire Romance" spans Romance and "To Sort", so it appears as two folders with split counts.
- 3 linked ebook files no longer exist on disk (the 📖 button shows a toast). A visual "broken link" hint on the card would be a nice follow-up.
- 2 TBR books carry read dates (re-reads in progress) — correct, just noting stats count them.

## 6. Making the UI feel more expensive

Done in this pass (CSS-only, palette unchanged):
- Elevation scale (`--shadow-1…4`) with warm-tinted shadows; cards, pills, folders and modals share it.
- Motion: cards settle in with a short stagger, expanded card lifts, modals fade-and-settle with a blurred backdrop, toast springs in and eases out, buttons have consistent hover-lift / press physics. `prefers-reduced-motion` respected.
- Real keyboard focus rings (visible on Tab, silent on click); tabular numerals in stats and counts.
- Native `alert()`/`confirm()` replaced by an in-app dialog with Enter/Esc; toasts wrap, carry actions (Undo), and live in CSS.
- Covers lazy-load and fade in; failures fall back to the emoji tile instead of a broken image.
- Window opens only once painted (no white flash) and remembers its size/position.

Recommended next (in rough order of impact):
1. **Typography rhythm** — pick one serif weight for titles (600), tighten letter-spacing on numerals, and use a 4-pt spacing scale everywhere (the folder grid and card metadata currently mix 3/5/7/9 px gaps).
2. **Click-to-open dropdowns** (Fanfiction / Books / Settings) instead of hover-only menus, with arrow-key navigation. Hover menus feel web-ish and vanish when the cursor drifts.
3. **Skeleton shimmer** on first paint instead of "Loading your library…" text, and a subtle progress state on the Back up button (spinner glyph, not a text swap).
4. **Native vibrancy titlebar** (`vibrancy: 'sidebar'` + translucent `#titlebar`) — the single biggest "Mac-native" cue.
5. **Dark mode** — tokens are already in `:root`; add a `prefers-color-scheme: dark` block and flip `darkModeSupport` in `package.json`.
6. **Cover-driven colour** — extract the dominant colour from a book's cover for its card accent (canvas sampling of the lazy-loaded image) instead of the id-hash gradient.
7. **Empty states with a call to action** ("Paste an AO3 link to add your first fic") and an illustrated 404 for folders.
8. **Inline validation** on the form (title required marker turns red as you leave the field) rather than only on Save.
9. Bundle Playfair Display locally so the serif never flashes to Georgia when offline.
10. Card density toggle (comfortable / compact) and remember the user's last view in `localStorage`.
