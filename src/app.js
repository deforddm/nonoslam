/* NONOSLAM — game logic, screens, modes, persistence. */
(function () {
  'use strict';
  var U = Nonogram.UNKNOWN, F = Nonogram.FILLED, E = Nonogram.EMPTY;
  var VERSION = '1.0.0';
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var SIZES = [5, 10, 15, 20, 25];
  var DIFF_LABEL = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };

  /* ------------------------------------------------------------ storage */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('nonoslam.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('nonoslam.' + k, JSON.stringify(v)); } catch (e) { /* private mode etc. */ } },
    del: function (k) { try { localStorage.removeItem('nonoslam.' + k); } catch (e) { /* ignore */ } }
  };

  var DEFAULTS = { theme: 'auto', sound: true, haptics: true, autoX: true, showMistakes: false, longPress: true, highlightLine: true, thickLines: true, counter: true, leftHanded: false, timer: true };
  var settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  var prefs = Object.assign({ mode: 'classic', size: 10, difficulty: 'normal' }, store.get('prefs', {}));
  var stats = Object.assign({ classic: {}, slam: {}, totals: { solved: 0, playMs: 0, slamRuns: 0 } }, store.get('stats', {}));

  /* ------------------------------------------------------- slam tuning */
  // start: opening clock (s) · bonus: time added per solve (s) · penalty: per wrong fill (s) · base: points per solve
  var SLAM = {
    5:  { start: 60,   bonus: 25,  penalty: 5,  base: 100 },
    10: { start: 180,  bonus: 100, penalty: 10, base: 400 },
    15: { start: 480,  bonus: 240, penalty: 15, base: 900 },
    20: { start: 900,  bonus: 420, penalty: 20, base: 1600 },
    25: { start: 1500, bonus: 660, penalty: 30, base: 2500 }
  };
  function slamMultiplier(streak) { return Math.min(4, 1 + 0.25 * Math.max(0, streak - 1)); }
  // Time added per solve shrinks as the run goes on, so every run eventually ends and the score means something.
  function slamBonusSeconds(size, solvedSoFar) { return Math.round(SLAM[size].bonus * Math.max(0.4, 1 - 0.05 * solvedSoFar)); }

  /* -------------------------------------------------------- game state */
  var game = null, slam = null, stroke = null, board, timerId = 0, currentScreen = 'home';
  var nextCache = {};

  function cacheKey(size, diff) { return size + ':' + diff; }
  function takePuzzle(size, diff, seed) {
    if (seed !== undefined && seed !== null) return Nonogram.generate(size, { difficulty: diff, seed: seed });
    var k = cacheKey(size, diff), p = nextCache[k];
    if (p) { delete nextCache[k]; return p; }
    return Nonogram.generate(size, { difficulty: diff });
  }
  function pregenerate(size, diff) {
    var k = cacheKey(size, diff);
    if (nextCache[k]) return;
    setTimeout(function () { if (!nextCache[k]) nextCache[k] = Nonogram.generate(size, { difficulty: diff }); }, 300);
  }

  function newGame(mode, puzzle) {
    var n = puzzle.rows * puzzle.cols;
    return {
      mode: mode, puzzle: puzzle, marks: new Uint8Array(n), history: [], future: [],
      elapsed: 0, runningSince: null, hints: 0, assisted: false, solved: false, paused: false,
      rowDone: new Uint8Array(puzzle.rows), colDone: new Uint8Array(puzzle.cols), startedAt: Date.now()
    };
  }

  /* ---------------------------------------------------------- screens */
  function show(id) {
    $$('.screen').forEach(function (s) { s.classList.toggle('active', s.id === 'screen-' + id); });
    currentScreen = id;
    if (id === 'game') board.resize();
    if (id === 'home') renderHome();
    if (id === 'stats') renderStats();
    if (id === 'settings') renderSettings();
  }

  function applyTheme() {
    var t = settings.theme;
    if (t === 'auto') t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]:not([media])');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0b0e17' : '#f2f4f9');
    board.refreshTheme();
  }
  function applySettings() {
    applyTheme();
    NonoAudio.setEnabled(settings.sound); NonoAudio.setHaptics(settings.haptics);
    board.setOptions({ thickLines: settings.thickLines, highlightLine: settings.highlightLine, longPress: settings.longPress, counter: settings.counter });
    $('#toolbar').classList.toggle('left-handed', settings.leftHanded);
    $('#hud-timer').style.visibility = settings.timer || (game && game.mode === 'slam') ? 'visible' : 'hidden';
    store.set('settings', settings);
  }

  /* ------------------------------------------------------------- home */
  function renderHome() {
    $$('#mode-seg button').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === prefs.mode); });
    $$('#size-seg button').forEach(function (b) { b.classList.toggle('active', +b.dataset.size === prefs.size); });
    $$('#diff-seg button').forEach(function (b) { b.classList.toggle('active', b.dataset.diff === prefs.difficulty); });
    var play = $('#btn-play');
    play.className = 'btn ' + (prefs.mode === 'slam' ? 'slam' : 'primary');
    play.textContent = prefs.mode === 'slam' ? 'Start Slam' : 'Play';
    $('#mode-desc').textContent = prefs.mode === 'slam'
      ? 'Beat the clock: each solve adds time, mistakes cost it. Streaks multiply your score.'
      : 'Solve at your own pace. Best times are kept per size.';
    var saved = store.get('current', null), cont = $('#btn-continue');
    if (prefs.mode === 'classic' && saved && saved.puzzle) {
      cont.hidden = false;
      cont.textContent = 'Continue ' + saved.puzzle.size + '×' + saved.puzzle.size + ' ' + DIFF_LABEL[saved.puzzle.difficulty] + ' · ' + fmtTime(saved.elapsed);
    } else cont.hidden = true;
    var key = cacheKey(prefs.size, prefs.difficulty), line = '';
    if (prefs.mode === 'classic') {
      var s = stats.classic[key];
      line = s && s.best ? 'Best time: ' + fmtTime(s.best) + ' · ' + s.solved + ' solved' : (s && s.solved ? s.solved + ' solved · no clean best time yet' : 'No solves yet at this size');
    } else {
      var t = stats.slam[key];
      line = t && t.high ? 'High score: ' + t.high.toLocaleString() + ' · best streak ' + t.bestStreak : 'No runs yet · ' + fmtTime(SLAM[prefs.size].start * 1000) + ' on the clock, +' + SLAM[prefs.size].bonus + 's per solve';
    }
    $('#home-best').textContent = line;
  }

  /* -------------------------------------------------------- start game */
  function startClassic(seed) {
    stopTimer();
    var puzzle = takePuzzle(prefs.size, prefs.difficulty, seed);
    game = newGame('classic', puzzle); slam = null;
    enterGame();
    pregenerate(prefs.size, prefs.difficulty);
  }

  function resumeSaved() {
    var s = store.get('current', null);
    if (!s || !s.puzzle) return false;
    var p = s.puzzle, n = p.rows * p.cols, sol = new Uint8Array(n), marks = new Uint8Array(n), i;
    for (i = 0; i < n; i++) { sol[i] = +p.solution.charAt(i); marks[i] = +s.marks.charAt(i); }
    var puzzle = { rows: p.rows, cols: p.cols, size: p.size, difficulty: p.difficulty, seed: p.seed, code: Nonogram.puzzleCode(p.size, p.difficulty, p.seed), solution: sol, rowClues: p.rowClues, colClues: p.colClues };
    game = newGame('classic', puzzle); slam = null;
    game.marks = marks; game.elapsed = s.elapsed || 0; game.hints = s.hints || 0; game.assisted = !!s.assisted;
    refreshLineDone(false);
    enterGame();
    return true;
  }

  function startSlam() {
    stopTimer();
    var P = SLAM[prefs.size];
    slam = { size: prefs.size, difficulty: prefs.difficulty, score: 0, streak: 0, bestStreak: 0, solved: 0, remaining: P.start * 1000, running: false, over: false, puzzleStart: 0, clean: true, mistakes: 0 };
    game = newGame('slam', takePuzzle(prefs.size, prefs.difficulty));
    enterGame();
    pregenerate(prefs.size, prefs.difficulty);
    slamReady();
  }

  function enterGame() {
    stroke = null;
    board.setPuzzle(game.puzzle, game.marks);
    board.setLocked(false);
    setTool('fill');
    $('#hud-sub').textContent = game.puzzle.size + '×' + game.puzzle.size + ' · ' + DIFF_LABEL[game.puzzle.difficulty] + (game.mode === 'slam' ? ' · SLAM' : '');
    $('#hud-slam').hidden = game.mode !== 'slam';
    $('#btn-hint').hidden = game.mode === 'slam';
    $('#hud-timer').classList.remove('danger');
    $('#hud-timer').style.visibility = settings.timer || game.mode === 'slam' ? 'visible' : 'hidden';
    updateHintBadge(); updateUndoButtons(); updateHud();
    show('game');
    if (game.mode === 'classic') startTimer();
  }

  /* ------------------------------------------------------------ timer */
  function startTimer() {
    if (game.mode === 'classic') game.runningSince = Date.now();
    if (slam) { slam.lastTick = Date.now(); slam.running = true; }
    if (!timerId) timerId = setInterval(tick, 100);
    updateHud();
  }
  function stopTimer() {
    if (game && game.mode === 'classic' && game.runningSince) { game.elapsed += Date.now() - game.runningSince; game.runningSince = null; }
    if (slam) slam.running = false;
    if (timerId) { clearInterval(timerId); timerId = 0; }
  }
  function tick() {
    if (!game) return;
    if (slam && slam.running && !slam.over) {
      var t = Date.now(); slam.remaining -= t - slam.lastTick; slam.lastTick = t;
      if (slam.remaining <= 0) { slam.remaining = 0; updateHud(); slamOver(); return; }
    }
    updateHud();
  }
  function classicElapsed() { return game.elapsed + (game.runningSince ? Date.now() - game.runningSince : 0); }
  function fmtTime(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
    s %= 60; m %= 60;
    var mm = (h ? (m < 10 ? '0' : '') : '') + m, ss = (s < 10 ? '0' : '') + s;
    return (h ? h + ':' : '') + mm + ':' + ss;
  }
  function updateHud() {
    if (!game) return;
    var el = $('#hud-timer');
    if (game.mode === 'slam') {
      el.textContent = fmtTime(Math.ceil(slam.remaining / 1000) * 1000);
      el.classList.toggle('danger', slam.remaining < 10000 && !slam.over);
      $('#hud-score').textContent = slam.score.toLocaleString();
      $('#hud-streak').textContent = '×' + slamMultiplier(slam.streak).toFixed(2).replace(/0$/, '') + (slam.streak > 1 ? ' · ' + slam.streak + ' streak' : '');
    } else el.textContent = fmtTime(classicElapsed());
  }

  /* ------------------------------------------------------ strokes/rules */
  function setTool(t) {
    board.setTool(t);
    $$('.tool-group .tool').forEach(function (b) { b.classList.toggle('active', b.dataset.tool === t); });
  }
  function currentTool() { return board.tool; }

  var boardCallbacks = {
    strokeStart: function (index, tool) {
      if (!game || game.solved || game.paused || (slam && !slam.running)) return false;
      NonoAudio.unlock();
      var target = tool === 'x' ? E : F, startState = game.marks[index];
      stroke = { target: target, startState: startState, action: startState === target ? U : target, idx: [], before: [], after: [], stopped: false };
      return applyStrokeCell(index);
    },
    strokeCell: function (index) { if (!stroke || stroke.stopped) return false; return applyStrokeCell(index); },
    strokeEnd: function () { commitStroke(); },
    strokeCancel: function () {
      if (!stroke) return;
      for (var i = stroke.idx.length - 1; i >= 0; i--) game.marks[stroke.idx[i]] = stroke.before[i];
      stroke = null; refreshLineDone(false); board.render();
    },
    cellFlag: function (index) {
      if (!game || game.mode !== 'classic' || !settings.showMistakes) return 0;
      return (game.marks[index] === F && game.puzzle.solution[index] !== F) ? 1 : 0;
    },
    lineTap: function () { NonoAudio.play('tick'); },
    longPressed: function (tool) { NonoAudio.buzz(25); }
  };

  // Apply the stroke's action to one cell. Returns false if the stroke must stop (Slam mistake).
  function applyStrokeCell(index) {
    var m = game.marks;
    if (m[index] !== stroke.startState) return true; // only cells matching the first cell's state
    var to = stroke.action;
    if (to === F && game.mode === 'slam' && game.puzzle.solution[index] !== F) {
      setCell(index, E);
      board.flashMistake(index);
      slamMistake();
      stroke.stopped = true;
      return false;
    }
    setCell(index, to);
    if (to === F) { NonoAudio.play('fill'); NonoAudio.buzz(8); }
    else if (to === E) { NonoAudio.play('x'); NonoAudio.buzz(8); }
    else NonoAudio.play('clear');
    if (game.mode === 'classic' && settings.showMistakes) game.assisted = true;
    return true;
  }

  function setCell(index, v) {
    var m = game.marks;
    if (m[index] === v) return;
    stroke.idx.push(index); stroke.before.push(m[index]); stroke.after.push(v);
    m[index] = v;
    var p = game.puzzle, r = Math.floor(index / p.cols), c = index % p.cols;
    checkLine('row', r, true); checkLine('col', c, true);
    board.render();
  }

  // Line completion: grey clues (drawn by the board) + optional auto-X of leftovers + flash on transition.
  function checkLine(kind, i, allowAutoX) {
    var p = game.puzzle, m = game.marks, done;
    if (kind === 'row') done = Nonogram.lineComplete(m, i * p.cols, 1, p.cols, p.rowClues[i]);
    else done = Nonogram.lineComplete(m, i, p.cols, p.rows, p.colClues[i]);
    var arr = kind === 'row' ? game.rowDone : game.colDone;
    var was = arr[i]; arr[i] = done ? 1 : 0;
    if (done && !was) {
      if (allowAutoX && settings.autoX && stroke) {
        var n = kind === 'row' ? p.cols : p.rows;
        for (var k = 0; k < n; k++) {
          var idx = kind === 'row' ? i * p.cols + k : k * p.cols + i;
          if (m[idx] === U) {
            stroke.idx.push(idx); stroke.before.push(U); stroke.after.push(E); m[idx] = E;
            // the crossed cell may complete a perpendicular line as well
            if (kind === 'row') checkLine('col', k, false); else checkLine('row', k, false);
          }
        }
      }
      board.flashLine(kind, i);
      if (stroke) NonoAudio.play('line');
    }
  }
  function refreshLineDone(flash) {
    var p = game.puzzle, i;
    for (i = 0; i < p.rows; i++) game.rowDone[i] = Nonogram.lineComplete(game.marks, i * p.cols, 1, p.cols, p.rowClues[i]) ? 1 : 0;
    for (i = 0; i < p.cols; i++) game.colDone[i] = Nonogram.lineComplete(game.marks, i, p.cols, p.rows, p.colClues[i]) ? 1 : 0;
  }

  function commitStroke() {
    if (!stroke) return;
    if (stroke.idx.length) {
      game.history.push({ idx: stroke.idx, before: stroke.before, after: stroke.after });
      if (game.history.length > 500) game.history.shift();
      game.future = [];
    }
    stroke = null;
    updateUndoButtons();
    afterChange();
  }

  function afterChange() {
    board.render();
    if (isSolved()) { onSolved(); return; }
    saveCurrent();
  }

  function isSolved() {
    var m = game.marks, sol = game.puzzle.solution;
    for (var i = 0; i < m.length; i++) if ((m[i] === F) !== (sol[i] === F)) return false;
    return true;
  }

  function applyMove(mv, forward) {
    var src = forward ? mv.after : mv.before;
    for (var i = 0; i < mv.idx.length; i++) game.marks[mv.idx[i]] = src[i];
    refreshLineDone(false);
  }
  function undo() {
    if (!game || game.solved || !game.history.length || stroke) return;
    var mv = game.history.pop(); applyMove(mv, false); game.future.push(mv);
    NonoAudio.play('undo'); updateUndoButtons(); afterChange();
  }
  function redo() {
    if (!game || game.solved || !game.future.length || stroke) return;
    var mv = game.future.pop(); applyMove(mv, true); game.history.push(mv);
    NonoAudio.play('undo'); updateUndoButtons(); afterChange();
  }
  function updateUndoButtons() {
    $('#btn-undo').disabled = !game || !game.history.length || game.solved;
    $('#btn-redo').disabled = !game || !game.future.length || game.solved;
  }
  function updateHintBadge() {
    var b = $('#hint-badge');
    if (game && game.hints) { b.hidden = false; b.textContent = game.hints; } else b.hidden = true;
  }

  /* ------------------------------------------------------------- hints */
  function giveHint() {
    if (!game || game.mode !== 'classic' || game.solved || game.paused || stroke) return;
    var p = game.puzzle;
    var h = Nonogram.hint(game.marks, p.solution, p.rows, p.cols, p.rowClues, p.colClues);
    if (!h) return;
    game.hints++; game.assisted = true; updateHintBadge();
    NonoAudio.play('hint');
    var r = Math.floor(h.index / p.cols), c = h.index % p.cols;
    board.revealCell(r, c);
    if (h.type === 'wrongFill') { board.showHint(h.index, null); board.flashMistake(h.index); toast('That filled cell should be empty'); return; }
    if (h.type === 'wrongX') { board.showHint(h.index, null); toast('That X should be a filled cell'); return; }
    // deduction: apply as an undoable move
    var mv = { idx: [h.index], before: [game.marks[h.index]], after: [h.value] };
    game.marks[h.index] = h.value;
    game.history.push(mv); game.future = [];
    refreshLineDone(false);
    board.showHint(h.index, h.line);
    if (h.line) toast((h.line.kind === 'row' ? 'Row ' : 'Column ') + (h.line.index + 1) + ' proves this cell is ' + (h.value === F ? 'filled' : 'empty'));
    updateUndoButtons(); afterChange();
  }

  /* ------------------------------------------------------------ solved */
  function onSolved() {
    game.solved = true;
    if (game.mode !== 'slam') stopTimer(); // the Slam clock keeps running between puzzles
    board.setLocked(true);
    board.celebrate();
    NonoAudio.play('solve'); NonoAudio.buzz([30, 40, 30, 40, 60]);
    store.del('current');
    if (game.mode === 'slam') { slamSolved(); return; }
    var key = cacheKey(game.puzzle.size, game.puzzle.difficulty), s = stats.classic[key] || { best: null, solved: 0, totalMs: 0 };
    var time = game.elapsed, newBest = false;
    s.solved++; s.totalMs += time;
    if (!game.assisted && (!s.best || time < s.best)) { s.best = time; newBest = true; }
    stats.classic[key] = s; stats.totals.solved++; stats.totals.playMs += time; store.set('stats', stats);
    setTimeout(function () {
      var html = '<h2>Solved!</h2>' + (newBest ? '<div><span class="tag">New best time</span></div>' : '') +
        '<div class="big">' + fmtTime(time) + '</div>' +
        '<div class="kv"><div><div class="k">Best</div><div class="v">' + (s.best ? fmtTime(s.best) : '—') + '</div></div>' +
        '<div><div class="k">Hints</div><div class="v">' + game.hints + '</div></div></div>' +
        '<div class="sub">' + game.puzzle.size + '×' + game.puzzle.size + ' ' + DIFF_LABEL[game.puzzle.difficulty] + ' · code ' + game.puzzle.code + (game.assisted ? '<br>Assisted solve — not counted for best time' : '') + '</div>' +
        '<button class="btn primary" data-act="next">Next puzzle</button>' +
        '<button class="btn ghost" data-act="home">Home</button>';
      modal(html, { next: function () { closeModal(); startClassic(); }, home: function () { closeModal(); goHome(); } });
    }, 900);
  }

  /* -------------------------------------------------------------- slam */
  function slamReady() {
    var P = SLAM[slam.size];
    board.setLocked(true);
    modal('<h2 style="color:var(--slam)">Slam ' + slam.size + '×' + slam.size + '</h2>' +
      '<div class="kv"><div><div class="k">On the clock</div><div class="v">' + fmtTime(P.start * 1000) + '</div></div>' +
      '<div><div class="k">Per solve</div><div class="v">+' + P.bonus + 's</div></div>' +
      '<div><div class="k">Wrong fill</div><div class="v">−' + P.penalty + 's</div></div>' +
      '<div><div class="k">Points</div><div class="v">' + P.base + ' × streak</div></div></div>' +
      '<div class="sub">Wrong fills turn into X automatically and reset your streak. Solve fast for a speed bonus. The time you earn per solve shrinks as the run goes on.</div>' +
      '<button class="btn slam" data-act="go">Go</button><button class="btn ghost" data-act="home">Back</button>',
      { go: function () { NonoAudio.unlock(); countdown(3); }, home: function () { closeModal(); slam = null; game = null; goHome(); } });
  }
  function countdown(n) {
    if (n === 0) {
      closeModal(); board.setLocked(false);
      slam.puzzleStart = Date.now();
      NonoAudio.play('slamGo');
      startTimer();
      return;
    }
    $('#modal').innerHTML = '<div class="countdown">' + n + '</div>';
    NonoAudio.play('tick');
    setTimeout(function () { countdown(n - 1); }, 700);
  }
  function slamMistake() {
    var P = SLAM[slam.size];
    slam.remaining -= P.penalty * 1000; slam.streak = 0; slam.clean = false; slam.mistakes++;
    NonoAudio.play('error'); NonoAudio.buzz(60);
    floatMsg('−' + P.penalty + 's', 'bad');
    updateHud();
    if (slam.remaining <= 0) { slam.remaining = 0; slamOver(); }
  }
  function slamSolved() {
    var P = SLAM[slam.size], solveMs = Date.now() - slam.puzzleStart;
    if (slam.clean) slam.streak++; else slam.streak = 0;
    slam.bestStreak = Math.max(slam.bestStreak, slam.streak);
    var mult = slamMultiplier(slam.streak);
    var speed = Math.round(P.base * 0.5 * Math.max(0, 1 - solveMs / (P.bonus * 1000)));
    var points = Math.round(P.base * mult) + speed;
    var added = slamBonusSeconds(slam.size, slam.solved);
    slam.score += points; slam.solved++; slam.remaining += added * 1000;
    NonoAudio.play('bonus');
    floatMsg('+' + points.toLocaleString() + (mult > 1 ? ' (×' + mult.toFixed(2).replace(/0$/, '') + ')' : '') + (speed ? ' · speed +' + speed : ''), 'slam');
    updateHud();
    setTimeout(function () {
      if (!slam || slam.over) return;
      game = newGame('slam', takePuzzle(slam.size, slam.difficulty));
      slam.clean = true; slam.puzzleStart = Date.now();
      board.setPuzzle(game.puzzle, game.marks); board.setLocked(false);
      updateUndoButtons(); updateHud();
      pregenerate(slam.size, slam.difficulty);
      floatMsg('+' + added + 's', 'good');
    }, 800);
  }
  function slamOver() {
    if (slam.over) return;
    slam.over = true; stopTimer(); board.setLocked(true);
    NonoAudio.play('over'); NonoAudio.buzz([80, 60, 80]);
    var key = cacheKey(slam.size, slam.difficulty), s = stats.slam[key] || { high: 0, bestStreak: 0, mostSolved: 0, runs: 0 };
    var newHigh = slam.score > s.high;
    s.high = Math.max(s.high, slam.score); s.bestStreak = Math.max(s.bestStreak, slam.bestStreak); s.mostSolved = Math.max(s.mostSolved, slam.solved); s.runs++;
    stats.slam[key] = s; stats.totals.slamRuns++; stats.totals.solved += slam.solved; store.set('stats', stats);
    var html = '<h2 style="color:var(--slam)">Time\'s up!</h2>' + (newHigh && slam.score > 0 ? '<div><span class="tag">New high score</span></div>' : '') +
      '<div class="big">' + slam.score.toLocaleString() + '</div>' +
      '<div class="kv"><div><div class="k">Solved</div><div class="v">' + slam.solved + '</div></div>' +
      '<div><div class="k">Best streak</div><div class="v">' + slam.bestStreak + '</div></div>' +
      '<div><div class="k">High score</div><div class="v hi">' + s.high.toLocaleString() + '</div></div>' +
      '<div><div class="k">Mistakes</div><div class="v">' + slam.mistakes + '</div></div></div>' +
      '<button class="btn slam" data-act="again">Play again</button><button class="btn ghost" data-act="home">Home</button>';
    modal(html, { again: function () { closeModal(); startSlam(); }, home: function () { closeModal(); slam = null; game = null; goHome(); } });
  }

  /* -------------------------------------------------------- pause/quit */
  function pauseGame() {
    if (!game || game.solved || game.paused) return;
    if (slam && !slam.running) return;
    game.paused = true; stopTimer(); board.setLocked(true);
    var html = '<h2>Paused</h2><div class="sub">' + game.puzzle.size + '×' + game.puzzle.size + ' ' + DIFF_LABEL[game.puzzle.difficulty] + (game.mode === 'slam' ? ' · Slam' : '') + '</div>' +
      '<button class="btn primary" data-act="resume">Resume</button>' +
      (game.mode === 'classic' ? '<button class="btn" data-act="restart">Restart puzzle</button><button class="btn" data-act="new">New puzzle</button>' : '') +
      '<button class="btn" data-act="settings">Settings</button>' +
      '<button class="btn ghost" data-act="quit">' + (game.mode === 'slam' ? 'End run' : 'Quit to home') + '</button>';
    modal(html, {
      resume: resumeGame,
      restart: function () { closeModal(); restartPuzzle(); },
      new: function () { closeModal(); store.del('current'); startClassic(); },
      settings: function () { closeModal(); show('settings'); },
      quit: function () { closeModal(); quitGame(); }
    });
  }
  function resumeGame() {
    closeModal();
    if (!game) return;
    game.paused = false; board.setLocked(false);
    startTimer();
  }
  function restartPuzzle() {
    var p = game.puzzle;
    game = newGame('classic', p); enterGame();
  }
  function quitGame() {
    if (slam) { if (!slam.over) { slam.running = false; slamOver(); return; } slam = null; }
    if (game && game.mode === 'classic' && !game.solved) { stopTimer(); saveCurrent(); }
    game = null; goHome();
  }
  function goHome() { stopTimer(); slam = null; game = null; show('home'); }

  function onBack() {
    if (!game) { goHome(); return; }
    if (game.mode === 'slam' && !slam.over) {
      game.paused = true; stopTimer(); board.setLocked(true);
      modal('<h2>End this run?</h2><div class="sub">Your score so far will be saved.</div><button class="btn slam" data-act="end">End run</button><button class="btn ghost" data-act="back">Keep playing</button>',
        { end: function () { closeModal(); quitGame(); }, back: function () { resumeGame(); } });
      return;
    }
    if (game.solved) { closeModal(); slam = null; game = null; goHome(); return; }
    quitGame();
  }

  function saveCurrent() {
    if (!game || game.mode !== 'classic' || game.solved) return;
    var p = game.puzzle, sol = '', marks = '', i;
    for (i = 0; i < p.solution.length; i++) { sol += p.solution[i]; marks += game.marks[i]; }
    store.set('current', {
      puzzle: { rows: p.rows, cols: p.cols, size: p.size, difficulty: p.difficulty, seed: p.seed, solution: sol, rowClues: p.rowClues, colClues: p.colClues },
      marks: marks, elapsed: classicElapsed(), hints: game.hints, assisted: game.assisted, savedAt: Date.now()
    });
  }

  /* ---------------------------------------------------- modal + toast */
  var modalActions = null;
  function modal(html, actions) {
    var m = $('#modal'); m.innerHTML = html; modalActions = actions || {};
    $('#modal-backdrop').hidden = false;
  }
  function closeModal() { $('#modal-backdrop').hidden = true; modalActions = null; }
  $('#modal').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || !modalActions) return;
    var fn = modalActions[b.dataset.act];
    if (fn) fn();
  });
  var toastTimer = 0;
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false; t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.hidden = true; }, 200); }, ms || 2200);
  }
  function floatMsg(text, cls) {
    var d = document.createElement('div'); d.className = 'float-msg ' + (cls || ''); d.textContent = text;
    $('#board-wrap').appendChild(d);
    setTimeout(function () { d.style.opacity = '0'; d.style.transition = 'opacity 0.3s'; }, 900);
    setTimeout(function () { d.remove(); }, 1300);
  }

  /* ---------------------------------------------------------- settings */
  var SETTING_ROWS = [
    { key: 'theme', label: 'Theme', type: 'seg', options: [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']] },
    { key: 'sound', label: 'Sound effects', type: 'toggle' },
    { key: 'haptics', label: 'Vibration', small: 'Android only — iPhones ignore web vibration', type: 'toggle' },
    { key: 'autoX', label: 'Auto-X finished lines', small: 'When a line matches its clues, cross out the leftover cells', type: 'toggle' },
    { key: 'showMistakes', label: 'Show mistakes', small: 'Classic mode: tint wrong fills red. Solves with it on don\'t set best times.', type: 'toggle' },
    { key: 'longPress', label: 'Long-press for the other tool', small: 'Hold a cell to use X (or fill) for that stroke', type: 'toggle' },
    { key: 'highlightLine', label: 'Highlight row and column', type: 'toggle' },
    { key: 'thickLines', label: 'Thick lines every 5 cells', type: 'toggle' },
    { key: 'counter', label: 'Counter while dragging', type: 'toggle' },
    { key: 'timer', label: 'Show the timer', small: 'Classic mode only; Slam always shows the clock', type: 'toggle' },
    { key: 'leftHanded', label: 'Left-handed toolbar', type: 'toggle' }
  ];
  function renderSettings() {
    var body = $('#settings-body'), html = '';
    SETTING_ROWS.forEach(function (row) {
      html += '<div class="setting"><div class="label">' + row.label + (row.small ? '<small>' + row.small + '</small>' : '') + '</div>';
      if (row.type === 'toggle') html += '<button class="switch" role="switch" aria-checked="' + (settings[row.key] ? 'true' : 'false') + '" data-key="' + row.key + '" aria-label="' + row.label + '"></button>';
      else html += '<div class="seg mini" data-key="' + row.key + '">' + row.options.map(function (o) { return '<button data-val="' + o[0] + '" class="' + (settings[row.key] === o[0] ? 'active' : '') + '">' + o[1] + '</button>'; }).join('') + '</div>';
      html += '</div>';
    });
    html += '<div class="setting"><div class="label">Reset statistics<small>Clears best times and high scores on this device</small></div><button class="btn small" data-reset="1">Reset</button></div>';
    body.innerHTML = html;
  }
  $('#settings-body').addEventListener('click', function (e) {
    var sw = e.target.closest('.switch');
    if (sw) { settings[sw.dataset.key] = !settings[sw.dataset.key]; sw.setAttribute('aria-checked', settings[sw.dataset.key] ? 'true' : 'false'); applySettings(); NonoAudio.play('tick'); return; }
    var opt = e.target.closest('.seg.mini button');
    if (opt) { var seg = opt.parentNode; settings[seg.dataset.key] = opt.dataset.val; $$('.seg.mini[data-key="' + seg.dataset.key + '"] button').forEach(function (b) { b.classList.toggle('active', b === opt); }); applySettings(); return; }
    if (e.target.closest('[data-reset]')) {
      modal('<h2>Reset stats?</h2><div class="sub">Best times, high scores and totals will be cleared.</div><button class="btn" data-act="yes" style="color:var(--danger)">Reset</button><button class="btn ghost" data-act="no">Cancel</button>',
        { yes: function () { stats = { classic: {}, slam: {}, totals: { solved: 0, playMs: 0, slamRuns: 0 } }; store.set('stats', stats); closeModal(); toast('Statistics reset'); }, no: closeModal });
    }
  });

  /* ------------------------------------------------------------- stats */
  function renderStats() {
    var body = $('#stats-body'), html = '';
    var t = stats.totals;
    html += '<div class="totals"><div><div class="v">' + t.solved + '</div><div class="k">Puzzles solved</div></div><div><div class="v">' + fmtTime(t.playMs) + '</div><div class="k">Classic time</div></div><div><div class="v">' + t.slamRuns + '</div><div class="k">Slam runs</div></div></div>';
    html += '<div class="card"><h3 style="margin-top:0">Classic · best times</h3><table class="stats"><tr><th>Size</th><th>Easy</th><th>Normal</th><th>Hard</th><th>Solved</th></tr>';
    SIZES.forEach(function (sz) {
      var solved = 0, cells = ['easy', 'normal', 'hard'].map(function (d) { var s = stats.classic[cacheKey(sz, d)]; if (s) solved += s.solved; return '<td>' + (s && s.best ? fmtTime(s.best) : '—') + '</td>'; }).join('');
      html += '<tr><td>' + sz + '×' + sz + '</td>' + cells + '<td>' + solved + '</td></tr>';
    });
    html += '</table></div>';
    html += '<div class="card"><h3 style="margin-top:0">Slam · high scores</h3><table class="stats"><tr><th>Size</th><th>Easy</th><th>Normal</th><th>Hard</th><th>Streak</th></tr>';
    SIZES.forEach(function (sz) {
      var streak = 0, cells = ['easy', 'normal', 'hard'].map(function (d) { var s = stats.slam[cacheKey(sz, d)]; if (s) streak = Math.max(streak, s.bestStreak); return '<td>' + (s && s.high ? s.high.toLocaleString() : '—') + '</td>'; }).join('');
      html += '<tr><td>' + sz + '×' + sz + '</td>' + cells + '<td>' + (streak || '—') + '</td></tr>';
    });
    html += '</table></div>';
    body.innerHTML = html;
  }

  /* ------------------------------------------------------- how to play */
  function renderHowto() {
    // The letter N: rows [1,1] [2,1] [1,1,1] [1,2] [1,1] · cols [5] [1] [1] [1] [5]
    var rows = [[1, 1], [2, 1], [1, 1, 1], [1, 2], [1, 1]], cols = [[5], [1], [1], [1], [5]];
    var grid = ['1...1', '11..1', '1.1.1', '1..11', '1...1'];
    var html = '<div class="example" style="grid-template-columns: 44px repeat(5, 30px)">';
    html += '<div></div>';
    cols.forEach(function (c) { html += '<div class="k">' + c.map(function (n) { return '<span>' + n + '</span>'; }).join('') + '</div>'; });
    grid.forEach(function (line, r) {
      html += '<div class="k r" style="width:44px">' + rows[r].join(' ') + '</div>';
      for (var c = 0; c < 5; c++) html += '<div class="c ' + (line[c] === '1' ? 'f' : 'x') + '">' + (line[c] === '1' ? '' : '✕') + '</div>';
    });
    html += '</div>';
    $('#howto-example').innerHTML = html;
  }

  /* -------------------------------------------------------- puzzle code */
  function codeDialog() {
    modal('<h2>Puzzle code</h2><div class="sub">Every puzzle has a code like <b>10x10-N-482130</b>. Enter one to play the exact same puzzle as a friend.</div>' +
      '<input id="code-input" placeholder="10x10-N-482130" autocomplete="off" autocapitalize="characters">' +
      '<button class="btn primary" data-act="play">Play this puzzle</button><button class="btn ghost" data-act="cancel">Cancel</button>',
      {
        play: function () {
          var parsed = Nonogram.parseCode($('#code-input').value);
          if (!parsed) { toast('That doesn\'t look like a puzzle code'); return; }
          if (SIZES.indexOf(parsed.size) < 0) { toast('Sizes are 5, 10, 15, 20 or 25'); return; }
          prefs.size = parsed.size; prefs.difficulty = parsed.difficulty; prefs.mode = 'classic'; store.set('prefs', prefs);
          closeModal(); store.del('current'); startClassic(parsed.seed);
        },
        cancel: closeModal
      });
    setTimeout(function () { var i = $('#code-input'); if (i) i.focus(); }, 50);
  }
  function copyCode() {
    var code = game.puzzle.code;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(function () { toast('Copied ' + code); }, function () { toast(code); });
    else toast(code);
  }

  /* ------------------------------------------------------------- menu */
  function gameMenu() {
    if (!game) return;
    if (game.mode === 'slam' && !slam.over) { pauseGame(); return; }
    var html = '<h2>' + game.puzzle.code + '</h2><div class="sub">Share this code to play the same puzzle</div>' +
      '<button class="btn" data-act="copy">Copy code</button>' +
      (game.solved ? '' : '<button class="btn" data-act="restart">Restart puzzle</button>') +
      '<button class="btn" data-act="new">New puzzle</button>' +
      '<button class="btn" data-act="settings">Settings</button>' +
      '<button class="btn ghost" data-act="close">Close</button>';
    var wasRunning = game.mode === 'classic' && !game.solved && !game.paused;
    if (wasRunning) { game.paused = true; stopTimer(); board.setLocked(true); }
    var done = function () { closeModal(); if (wasRunning && game) { game.paused = false; board.setLocked(false); startTimer(); } };
    modal(html, {
      copy: function () { copyCode(); },
      restart: function () { closeModal(); restartPuzzle(); },
      new: function () { closeModal(); store.del('current'); startClassic(); },
      settings: function () { closeModal(); show('settings'); },
      close: done
    });
  }

  /* ------------------------------------------------------------ wiring */
  function init() {
    board = new NonoBoard($('#board'), $('#board-wrap'), $('#drag-badge'), boardCallbacks);
    applySettings();
    renderHowto();
    // the clue numerals are drawn on canvas: redraw once the web font has arrived
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { board.render(); });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onChange = function () { if (settings.theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
    }

    // home
    $('#mode-seg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; prefs.mode = b.dataset.mode; store.set('prefs', prefs); renderHome(); NonoAudio.play('tick'); });
    $('#size-seg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; prefs.size = +b.dataset.size; store.set('prefs', prefs); renderHome(); NonoAudio.play('tick'); });
    $('#diff-seg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; prefs.difficulty = b.dataset.diff; store.set('prefs', prefs); renderHome(); NonoAudio.play('tick'); });
    $('#btn-play').addEventListener('click', function () { NonoAudio.unlock(); if (prefs.mode === 'slam') startSlam(); else { store.del('current'); startClassic(); } });
    $('#btn-continue').addEventListener('click', function () { NonoAudio.unlock(); if (!resumeSaved()) { toast('Nothing to continue'); renderHome(); } });
    $('#nav-howto').addEventListener('click', function () { show('howto'); });
    $('#nav-stats').addEventListener('click', function () { show('stats'); });
    $('#nav-settings').addEventListener('click', function () { show('settings'); });
    $('#nav-code').addEventListener('click', codeDialog);
    $$('.nav-home').forEach(function (b) { b.addEventListener('click', function () { if (game && !game.solved && (game.mode === 'classic' || (slam && !slam.over))) { show('game'); if (game.paused) pauseGame(); } else goHome(); }); });

    // game
    $('#btn-back').addEventListener('click', onBack);
    $('#btn-pause').addEventListener('click', function () { if (game && game.paused) resumeGame(); else pauseGame(); });
    $('#btn-menu').addEventListener('click', gameMenu);
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-redo').addEventListener('click', redo);
    $('#btn-hint').addEventListener('click', giveHint);
    $('#btn-fit').addEventListener('click', function () { board.fit(); });
    $$('.tool-group .tool').forEach(function (b) { b.addEventListener('click', function () { setTool(b.dataset.tool); NonoAudio.play('tick'); }); });

    document.addEventListener('keydown', function (e) {
      if (currentScreen !== 'game' || !game) return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      var k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'z') undo(); else if (k === 'y') redo();
      else if (k === 'x') setTool(currentTool() === 'x' ? 'fill' : 'x');
      else if (k === 'p') setTool(currentTool() === 'pan' ? 'fill' : 'pan');
      else if (k === 'h') giveHint(); else if (k === 'f') board.fit();
      else if (k === 'escape' || k === ' ') { e.preventDefault(); if (game.paused) resumeGame(); else pauseGame(); }
    });

    // pause when the app goes to the background; keep the saved game fresh
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { if (game && !game.solved && !game.paused && currentScreen === 'game' && !(slam && !slam.running)) pauseGame(); saveCurrent(); }
    });
    window.addEventListener('pagehide', saveCurrent);

    show('home');

    // Service worker for offline play (only when served over http/https; not for the single-file build)
    if (!window.NONOSLAM_SINGLE_FILE && 'serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
      window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ }); });
    }

    // test hooks (used by the automated checks; harmless otherwise)
    window.NONOSLAM = {
      version: VERSION, board: board,
      getGame: function () { return game; }, getSlam: function () { return slam; }, getSettings: function () { return settings; },
      setSetting: function (k, v) { settings[k] = v; applySettings(); }, startClassic: startClassic, startSlam: startSlam, show: show
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
