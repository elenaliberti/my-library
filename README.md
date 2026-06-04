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

Click the 📁 button in the app to open that folder directly.

## Features

- **611 entries** pre-loaded from your Excel lists (255 fics + 356 books)
- Paste an AO3 URL → auto-fills title, author, fandom, word count, kudos, rating
- Filter by status, fandom, book section, type
- Search across title / author / fandom / tags
- Star ratings + personal notes per entry
- Export to Excel any time with the 📊 button
- ⌘F to focus search bar
