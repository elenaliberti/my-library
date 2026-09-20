# Changelog

## 1.7.2 — 20 Sep 2026

### Fixes
- **Buttons that opened a dialog did nothing.** Page banners, a card's Edit, Change cover and a folder's Edit all built their dialog but a stray naming clash (`icon`) threw before it could show, so the click looked dead. All four open correctly now, and a render that throws surfaces a message instead of silently leaving the page half-drawn with dead buttons.
- **Adding an entry no longer glitches.** The Add form used to rebuild the whole page — all ~960 cards behind it — on every change (type toggle, tag, auto-fill, picking a file), which flickered and jumped. It now re-renders only itself and keeps its scroll and focus; on Save the list is updated in place. It also stayed labelled "Add new entry" but the moment you changed anything it silently flipped into "Edit entry" and hid the Fanfiction/Book toggle; it now stays in Add mode until saved.

## 1.7.1 — 18 Sep 2026
- **Pastels move to green / blue / orange.** Same gradient intensity, new hues: the titlebar wash and the Add entry button run mint → sky → peach, Board is mint and Stats is peach. The accent is a clear blue instead of periwinkle, peaks and the stat-card rule end in orange, and the folder-tile duotones follow (teal, orange, sky, lime, sunset, green-blue, aqua, coral). Status colours unchanged.

## 1.7.0 — 18 Sep 2026
- **Going back lands where you were.** Leaving a folder, Stats or the board and coming back restores the scroll position of the view you return to; a same-view change (status, favourite, delete) never moves the page; going forward into a new view still starts at the top.
- **One swipe, one step.** A trackpad flick used to fire "back" two or three times through its momentum and drop you on the home screen. A gesture now navigates once and re-arms only after the trackpad goes quiet.
- **Stats and Board buttons** are tinted sky and lilac, in the same pastel family as Add entry.
- The Harry Potter cat mascot has been removed.

## 1.6.0 — 18 Sep 2026

### Palette
- **No more greige.** Pure white surfaces, indigo text, electric violet as the one accent, hot pink for peaks and gradients, a lime highlight on "Pick for me". Chips, tabs, segmented controls and the primary button fill violet (with a soft glow) instead of black; folder tiles and cover fallbacks use saturated duotones (violet, pink, sky, lime-teal, sunset, aqua, coral-yellow). Dark mode is deep indigo with lilac text and brighter accents.
- The four status colours (TBR, Reading, Finished, Dropped) are untouched — they are the reader's own code.
- **Softer where it matters.** The primary button is a lilac-to-pink pastel gradient with indigo text, the titlebar carries an airy lilac / blush / sky wash, and the accent is a calmer periwinkle rather than electric violet.
- **Page banners only colour their band now.** A custom banner no longer replaces the app's accent colour everywhere; section labels still take a contrast-safe ink from it. Banner presets follow the new palette.

## 1.5.0 — 18 Sep 2026

### Self-healing ebook links
- **Moved or renamed files are found again automatically.** At launch (and from Settings → *Relink moved files…*) every linked PDF/EPUB that is no longer at its path is looked for under the nearest folder that still exists — so a library reorganised into sub-folders inside the same "PDF and FF" folder relinks itself. Matching is by exact file name first, then by normalised title (download-site suffixes such as "(z-lib.org)" or "-- <hash> -- Anna's Archive" are ignored and an "Author - Title" rename is recognised). Only unique matches are applied; look-alikes stay flagged on the book button for the manual picker. Never searches outside that folder.

### Design
- **Colour-coordinated status counters are back.** TBR, Reading, Finished and Dropped are tinted chips in their status colours; the active filter fills solid. The status switcher on an expanded card carries the same colour dots.
- **Comfortable density is roomier** (larger covers, more padding) and is the default again for everyone — the remembered setting was reset once.
- **The Harry Potter cat has a real flight.** A soft ground shadow and an occasional hop while idle; on touch it takes off nose-up in a rising arc, barrel-rolls over the middle, trails stars from the broom and lands with a squash-and-stretch bounce, facing the way it flew.

## 1.4.0 — 18 Sep 2026

### Visual redesign
- **A new visual language.** Warm paper surfaces and ink text replace the blue-grey palette; one restrained sage accent is used for emphasis only. Every colour is still a token, and the dark theme is a token swap.
- **Stroke icons replace emoji chrome.** Titlebar, filters, cards, folders, board, stats and dialogs use a consistent SVG icon set. Emoji remain only where you chose them (folder icons, covers).
- **The green band and the floating calculator are gone.** The four status counts are now a typographic strip (serif figures, small-caps labels, underline for the active filter). Stats live behind a quiet titlebar button.
- **Cards** show a cover, a serif title and one metadata line; actions appear on hover; status is a dot and a word instead of a coloured pill; long tag lists collapse to four plus a count. Cover-derived accents are a soft edge, not a stripe.
- **Filters** are pill chips (the active one is ink-filled), the sort menu is a custom control, and Favourites sits on the right.
- **Folder tiles** use a muted duotone palette with the type glyph in a translucent disc; section headers (Pairings, Tropes & AUs, Series) are small caps with a hairline.
- **Board** columns have paper headers with counts, dashed Finished/Dropped zones that tint green/red on hover, and a warm shelf wash.
- **Stats** use segmented controls (ink-filled active state), serif figures, a sage bar chart with the peak in ink, and an insight line with a left rule.
- Content is capped at a reading width (1120 px) with gutters that grow on wide windows.
- **Board button** in the titlebar — the reading board was reachable only by swipe; it now has a visible entry that also shows when you are on it.
- Custom page banners keep working as an opt-in: with a banner set, the status strip becomes paper chips on the banner colour and the board headers take the banner.

## 1.3.0 — 18 Sep 2026

### Reading progress
- **Track where you are** in anything you're reading — page, chapter or percent — from the shelf, a card, the stale-read nudge or the edit form. Fics get their chapter count from AO3 automatically.
- The shelf shows a **progress bar and a finish estimate** ("≈ 12 days left · done by 30 Sep"), from your pace on that book once there's real progress, otherwise from your typical pace.
- **"Where did you stop?"** when you drop something (new Dropped zone on the board, or the card's status button). Only the part you reached is credited to your words read; a drop with no position credits nothing. Books in progress credit the part read so far, so the total moves as you read.
- **Stale reads** (60+ days on the shelf, nothing logged for 30) get a gentle nudge: Finished it · Dropped it · Update progress.

### Board
- **Filter, sort and chips** in the To Be Read column: type to filter, sort by recently added / longest waiting / shortest / longest / author / series, one-tap genre (books) or fandom (fics) chips.
- **Undo for every board move** — in the toast and with ⌘Z. The "Finished ✓" toast has **Change date** for books you actually finished earlier.
- The Reading shelf has a header like the other columns; "Pick for me" is labelled.

### Fixes
- **Start date was only recorded when dragging onto the shelf.** Every path into Reading (edit form, status buttons, mood picker, phone) now stamps it, so pace and the "started · Nd" chip work for every book. Going back to TBR clears it.

## 1.2.0 — 18 Sep 2026

### Calculations (audited against an independent recomputation of the live data)
- **Dropped items no longer add their word count** to "words read", reading time or the charts. Their read events still appear in the calendar (greyed, 🚫) and in item counts. This removed 8.4 M phantom words, most of it one 4.7 M-word fic that was abandoned.
- **"Last read" is the latest date, not the last list entry.** Three items had read dates out of order; the list is now kept chronological, so the － stepper really removes the most recent read.
- **Legacy re-reads no longer stack on one day.** "Read 3 times" used to become three events on the single known finish date, tripling that month in the chart. One copy keeps the date; the others count in totals as undated reads, and the footnote says how many.
- **Trend never compares a half-elapsed month with a full one.** When the current bucket is under half done, the two most recent complete buckets are compared, and the label says which.
- **Reading pace uses the median**, not the mean — one fic marked Reading and Finished on the same day (324 K words/day) had made the "average" meaningless. Pace also uses the same word figure as everything else (pages × 250 when there's no count) and excludes dropped items.
- Percentages in the breakdown always sum to 100; `999,600` formats as `1.0M`, not `1000K`; the calendar and the trend chart now include exactly the same read events.
- **Estimates are marked.** Cards, the titlebar and the stats show ≈ when a figure rests on imported or page-based estimates (26% of the current total), and the stats footnotes spell out what is excluded or undated.
- Finishing a re-read on the MySpace board, or via the card's status buttons after starting it on the board, now logs a new read instead of silently keeping the count at one.

### Performance
- **List view renders in ~65 ms instead of ~1.2 s.** Cards stream in chunks behind a height spacer, single-item changes (star, favourite, status, re-read, expand) patch just that card, and card actions are handled by one delegated listener instead of ~8,000 per-element bindings.

### Behaviour
- **Tombstones are permanent** on both apps. The 365-day expiry bought nothing (a tombstone is ~70 bytes) and was the one way a long-offline device could bring a deleted entry back.
- **Series span genres.** A series folder now lists every book in the series wherever it's filed, counts agree everywhere, and a name/icon set on the series applies under every genre. Inside a series, a book filed under a different genre shows an amber *Move to …* pill; ⌘Z undoes.
- **Broken ebook links are visible and fixable.** Every linked file is checked at launch; a missing one shows a ⚠️ on the 📖 button and in the edit form. Clicking it searches Downloads, Documents, Desktop, Books and iCloud Drive for the file by name and relinks it, or opens a picker pointed at the best guess.
- **Read history is never silent.** A TBR/Reading/Dropped entry that has been read before shows *↻ read before* / *↻ re-reading*.

### Design
- Semantic colour tokens throughout, with a full **dark theme** that follows the system.
- **Native vibrancy titlebar** (frosted, translucent) and a skeleton first paint instead of loading text.
- Click-to-open menus with arrow-key navigation, Enter, Esc and click-outside.
- **Cover-derived accents**: each cover is sampled once for a representative colour, which tints the card's edge, the cover tile and the shelf glow. Cached; runs in the background.
- Empty states with real actions (clear search, add a fic/book, back home); inline title validation; a spinner state on Back up; a comfortable/compact **density** toggle in Settings; the app reopens in the view you left.
- One serif weight, 4-pt spacing scale, tabular numerals. Serif falls back to the system's New York face when Playfair Display isn't available.

## 1.1.0 — 18 Sep 2026
- Atomic saves, `.bak` + daily snapshots, read-only recovery mode, tombstone-aware Back up, phone sync carries deletions, coalesced saves.
- Excel export moved to the main process (it had never worked in the sandboxed renderer). "Open link" no longer navigates the app away.
- Load-time normaliser repairs HTML entities in tags, lowercase statuses and read-count drift.
- Debounced search, lazy covers, in-app confirm dialogs, delete with undo, toasts with actions, elevation/motion pass.
