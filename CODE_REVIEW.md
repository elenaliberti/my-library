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

## 5. Edge cases — resolved in 1.2.0

| Was | Now |
|-----|-----|
| Tombstones expired after 365 days, so a long-offline device could resurrect a deleted entry. | Tombstones are permanent on both apps (≈70 bytes each; malformed stamps are dropped). |
| Series folders were scoped per genre — "Billionaire Romance" appeared twice with split counts. | A series folder lists every book in the series wherever it's filed; counts agree; name/icon config is shared across genres; a mis-filed book shows a *Move to genre* pill (⌘Z undoes). |
| 3 linked ebooks no longer existed; the 📖 button only failed on click. | Every link is checked at launch. Missing files show a ⚠️ on the card and in the edit form; clicking searches Downloads/Documents/Desktop/Books/iCloud by file name and relinks, or opens a picker pointed at the best guess. |
| TBR/Reading/Dropped items with read history counted in stats silently. | They show *↻ read before* / *↻ re-reading* so the history is visible and intentional. |

## 6. UI — all ten recommendations implemented in 1.2.0

1. **Typography & spacing** — one serif weight token, tabular numerals everywhere, 4-pt spacing scale (`--s1…--s6`).
2. **Click-to-open menus** — `initDropdowns()`: click toggles, ↓/↑ move, Enter/Space choose, Esc closes and returns focus, click-outside closes; `aria-expanded`/`role=menu`.
3. **Skeleton first paint** in `index.html`; Back up shows a spinner ring with the label swapped to "Backing up…".
4. **Vibrancy titlebar** — `vibrancy: 'under-window'` in main; `html/body/#app` transparent, every content region paints `--bg`, titlebar is translucent with backdrop blur.
5. **Dark mode** — every colour is a semantic token; `prefers-color-scheme: dark` swaps them; `darkModeSupport: true`. Custom banner colours derive a contrast-safe ink per theme.
6. **Cover-derived colour** — `runCoverColorQueue()` fetches each cover via main (no canvas taint), samples a saturation-weighted mean, caches in `localStorage`; cards get a hairline accent and tinted cover tile, the shelf a matching glow.
7. **Empty states with actions** — clear search, add fic/book (pre-filled from the search), clear folder filter, back home; unknown folder paths get their own state.
8. **Inline validation** — title marks invalid on blur with a hint, clears on input; duplicate warning is accent-insensitive.
9. **Serif fallback** — `'Playfair Display', ui-serif, 'New York'…` so offline never shows Georgia. Bundling Playfair locally is a 4-file download (~120 KB) — say the word and it goes in `assets/fonts/`.
10. **Density toggle** (Settings → Density) and the last view/sort/tab/folder are remembered across launches.

## 7. Final audit before publishing (1.2.0)

### Calculations — verified against an independent recomputation in Node
| Figure | Rule now | Check |
|--------|----------|-------|
| Words read (titlebar, stats, phone) | Σ over items of `readWords × timesRead`; `readWords` = real count, else pages × 250, **0 for Dropped**; TBR/Reading add nothing | 72,298,081 in app == 72,298,081 recomputed (was 80.7 M with dropped fics counted) |
| Estimated share | items flagged `_wordsEstimated` or page-derived | 18,955,750 == recomputed; shown as ≈ and as a footnote |
| Breakdown % | largest-remainder | 39 + 61 + 0 = 100 |
| Trend | current bucket vs previous, or last two complete buckets when < 50 % elapsed; label states which | "▼ 82% vs previous month (so far)" on 18 Sep |
| Reading pace | median of words ÷ days, dropped excluded, same-day = 1 day and flagged | 8,680 words/day (mean was 113 K because of a same-day entry) |
| Last read / re-read stepper | max date; list kept chronological | "Harry Potter e la pietra filosofale" → 2016-12-14 (was 2012) |
| Legacy re-reads | one dated copy, the rest undated (counted, not charted) | 6 items collapsed; footnote reports undated reads and their words |
| Calendar vs chart | identical event set (all dated reads, any status) | 2026: 49 icons, 4 marked dropped |
| Re-read via board / status buttons | new read logged when `readingStartedAt` is after the last read | TBR → Reading → Finished on a finished book → 2 reads |

### Demo run (harness, 958 live records, 40 flows) — all passed, zero console errors
Add/edit/delete/undo, tags, stars, favourites, status, re-read stepper, MySpace drag TBR → Reading → Finished, series create/drag/⌘Z, folder rename/pin, stats toggles, calendar year nav and drag-to-move, mood picker, banner colour → ink contrast, export, sync, Escape layering, ⌘F, narrow viewport (no horizontal overflow at 565 px), dark mode, compact density.

### Performance fix found by the demo
Every re-render in list view committed ~19,000 DOM nodes and forced layout: **1.2 s per click**. Cards now stream in 48-card chunks (first chunk synchronous, rest one per frame behind a height spacer), single-item changes patch only that card, and card actions use one delegated listener. Measured: full list render 64 ms JS / 142 ms to paint; star/favourite/status/expand 2 ms.

### Left as is, deliberately
- "Recent" sort keeps unread items above read ones, so a fic added *and* finished today lands after the TBR pile. It is the documented intent of that sort.
- Two books have a finish date earlier than their board start date (edited by hand); they are excluded from pace and flagged in the footnote logic, not silently "fixed".
- 218 read items have neither words nor pages and add 0 to totals. The stats footnote says so; filling them in is a data task, not a code one.

## 8. 1.3.0 — reading progress, board tools, undo

- **Start-date gap fixed**: `ensureReadingStart()` runs on every path into Reading (status buttons, edit form, mood picker, board, phone). The screenshot case (a shelf book with no "started" chip) can no longer happen. Going back to TBR clears the start.
- **Progress model** `{unit: page|chapter|percent, value, total, at}` on items. Drives the shelf progress bar, the finish estimate (this book's pace once real progress exists, else the library median), the card's "Currently at / Stopped at" row, and the edit form's Progress fields. AO3 fetch now records `chaptersPosted/chaptersTotal` so fics default to chapters.
- **Where did you stop?** A new Dropped zone on the board and the card's Dropped status both ask for the position (skippable). `wordsPerRead()` credits a dropped item the fraction reached; `creditedWords()` adds the in-progress fraction for Reading items. Verified in the harness: dropped at ch. 98/120 credits exactly 98/120 of the length; unknown stop credits 0; the stats footnotes report both.
- **Board undo**: every move pushes an `{type:'item'}` snapshot onto the ⌘Z stack and offers Undo in its toast; "Finished ✓" offers **Change date**, which moves both the finish date and the read event.
- **TBR tools**: debounced filter, six sort orders, genre/fandom chips with counts, "n of N" indicator; state survives re-renders, resets when switching tabs.
- **Stale reads** (60 days on the shelf, 30 without a touch) get Finished · Dropped · Update progress inline.
- Verified: 11 harness flows including drag-to-Dropped with dialog, undo in toast and via ⌘Z, change-date dialog, progress dialog from shelf/card/form, and phone-side credit rules in Node.

> **1.4.0 (18 Sep 2026):** the visual language itself was redesigned after the 1.2/1.3 polish still read as a hobby project — warm paper palette, stroke-SVG icon set replacing all emoji chrome, typographic status strip instead of the green band, hover-revealed card actions, dot status badges, muted duotone folder tiles, segmented stats controls, 1120 px reading width, and a visible Board button. See CHANGELOG 1.4.0.
