# NONOSLAM

A mobile nonogram game built as a web app / PWA. Every puzzle is generated on the fly and verified to be solvable by logic alone (exactly one solution, no guessing). Two modes:

- **Classic** — solve at your own pace with a timer; best times are kept per size and difficulty.
- **Slam** — beat the clock. Each solve adds time (less as the run goes on), wrong fills cost time and reset your streak, clean streaks multiply your score, and fast solves earn a speed bonus.

Sizes 5×5, 10×10, 15×15, 20×20, 25×25 · Easy / Normal / Hard · light and dark themes · works offline once installed.

## Play it right now

- **Any phone or desktop browser:** open `index.html` from a web server (see below), or just double-click `dist/nonoslam.html` — that single file is the whole game.
- **Install on a phone:** once it's hosted over https, open it in Safari (iPhone: Share → *Add to Home Screen*) or Chrome (Android: menu → *Install app*). It then launches full-screen like a native app and works offline.

## Project layout

```
index.html              app shell (screens + markup)
src/nonogram.js         puzzle engine: line solver, unique-solution generator, hints, clue status
src/board.js            canvas board: rendering, frozen clue bands, pinch-zoom/pan, drag painting, long-press
src/app.js              game rules, Classic + Slam modes, undo/redo, stats, settings, persistence
src/audio.js            synthesized sound effects + haptics
src/style.css           mobile-first styles, light/dark tokens
manifest.webmanifest    PWA manifest
sw.js                   service worker (offline cache) — bump CACHE when you release
icons/                  app icons (generated)
tests/engine.test.js    engine tests (run: node tests/engine.test.js)
tests/bench.js          generation timing + difficulty spread (run: node tests/bench.js)
tools/build.js          builds dist/nonoslam.html (single-file) and dist/artifact.html
```

No build step or framework is required to run the game — the files are plain HTML/CSS/JS. Node is only used for the tests and the single-file bundle.

## Run locally

```
npx serve .            # or: python -m http.server 8080
```

then open the printed URL on your phone (same Wi-Fi) or desktop. The service worker only registers over http(s), so `file://` works for playing but not for offline install.

## Deploy (free options)

- **GitHub Pages:** push the folder to a repo, Settings → Pages → deploy from `main` / root. Done — the URL is installable as a PWA.
- **Netlify / Cloudflare Pages / Vercel:** drag-and-drop the folder. No build command, publish directory `.`.

After any change, bump `CACHE` in `sw.js` (e.g. `nonoslam-v1.0.1`) so installed copies refresh.

## Ship to the App Store / Play Store (Capacitor)

The web app can be wrapped as a native app with [Capacitor](https://capacitorjs.com):

```
npm init @capacitor/app        # name: NONOSLAM, package id e.g. com.ddramrod.nonoslam
# copy index.html, src/, icons/, manifest.webmanifest into the created www/ folder
npm i @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
npx cap add ios && npx cap add android
npx cap sync
npx cap open android           # Android Studio → build / run
npx cap open ios               # Xcode (needs a Mac) → build / run
```

Optional plugins worth adding at that point: `@capacitor/haptics` (iPhone vibration — web vibration is Android-only), `@capacitor/status-bar`, and `@capacitor/splash-screen`.

## How puzzles are made

`Nonogram.generate(size, {difficulty, seed})` fills a grid at random, then runs a full line solver (a dynamic-programming pass that finds every cell forced by a line's clues, propagated across rows and columns). If the solver gets stuck, the generator flips a few cells inside the ambiguous region and tries again — this converges in a handful of steps, so even 25×25 puzzles generate in well under 50 ms. A puzzle the line solver can finish has exactly one solution by construction; `tests/engine.test.js` double-checks this with an independent backtracking counter.

Difficulty is the depth of the deduction chain (how many rounds of row/column reasoning the solver needs). Easy picks a shallow candidate, Hard the deepest.

Every puzzle has a code like `10x10-N-482130` (size, difficulty, seed). The same code always produces the same puzzle, so two people can race on identical boards.

## Tuning

- Slam clocks, bonuses, penalties and points: the `SLAM` table at the top of `src/app.js`.
- Colours: the CSS variables at the top of `src/style.css` (light in `:root`, dark in `[data-theme="dark"]`).
- Generation density / candidates per difficulty: `genParams()` in `src/nonogram.js`.
- Cell size limits and clue-band cap: constants at the top of `src/board.js`.

## Tests

```
node tests/engine.test.js      # solver vs brute force, uniqueness, hints, codes
node tests/bench.js            # timing + difficulty spread per size
node tools/build.js            # regenerate dist/
```
