/*
 * NONOSLAM puzzle engine
 * ----------------------
 * Pure logic, no DOM. Works as a plain <script>, inside a Web Worker, or in Node.
 *
 *   Nonogram.generate(size, {difficulty, seed})  -> puzzle (guaranteed line-solvable => unique solution)
 *   Nonogram.solve(rowClues, colClues)           -> {status, grid, rounds, score}
 *   Nonogram.clueStatus(cells, clues)            -> per-clue satisfied flags for the UI
 *
 * Cell states: 0 = UNKNOWN, 1 = FILLED, 2 = EMPTY (X)
 *
 * The whole engine lives in NonogramEngineFactory so the UI can spin up a Worker from
 * NonogramEngineFactory.toString() without needing a second file (works over file:// too).
 */
var NonogramEngineFactory = function () {
  'use strict';

  var UNKNOWN = 0, FILLED = 1, EMPTY = 2;

  /* ------------------------------------------------------------------ RNG */
  // mulberry32 — small, fast, deterministic. Same seed => same puzzle everywhere.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomSeed() {
    return (Math.floor(Math.random() * 900000) + 100000) >>> 0; // 6 digits, easy to type
  }

  /* ---------------------------------------------------------------- clues */
  // Run lengths of FILLED cells along a line given as (start, step, n) into a flat array.
  function lineClues(cells, start, step, n) {
    var clues = [], run = 0;
    for (var i = 0; i < n; i++) {
      if (cells[start + i * step] === FILLED) run++;
      else if (run) { clues.push(run); run = 0; }
    }
    if (run) clues.push(run);
    return clues;
  }

  function cluesFromGrid(grid, rows, cols) {
    var rowClues = [], colClues = [], r, c;
    for (r = 0; r < rows; r++) rowClues.push(lineClues(grid, r * cols, 1, cols));
    for (c = 0; c < cols; c++) colClues.push(lineClues(grid, c, cols, rows));
    return { rowClues: rowClues, colClues: colClues };
  }

  /* ---------------------------------------------------------- line solver */
  // Reusable scratch buffers so solving thousands of lines doesn't churn the GC.
  function LineSolver(maxN) {
    this.maxN = maxN;
    var maxM = ((maxN + 1) >> 1) + 1;
    this.stride = maxM + 1;
    this.L = new Uint8Array((maxN + 1) * this.stride);
    this.R = new Uint8Array((maxN + 2) * this.stride);
    this.emptyPrefix = new Int16Array(maxN + 1);
    this.fillDiff = new Int16Array(maxN + 2);
    this.line = new Uint8Array(maxN);
    this.canEmpty = new Uint8Array(maxN);
    this.canFill = new Uint8Array(maxN);
  }

  /*
   * Deduce every cell that is forced given the current states of one line.
   *   s      : Uint8Array line states (modified in place)
   *   n      : line length
   *   clues  : array of run lengths ([] for an empty line)
   *   out    : optional array; indices of newly determined cells are pushed here
   * Returns false if the line is contradictory (no arrangement fits).
   *
   * L[i][j] = first i cells can be assigned consistently containing exactly blocks 0..j-1
   * R[i][j] = cells i..n-1 can be assigned consistently containing exactly blocks j..m-1
   */
  LineSolver.prototype.solveLine = function (s, n, clues, out) {
    var m = clues.length, i, j, k, p;
    var st = this.stride, L = this.L, R = this.R;
    var ep = this.emptyPrefix, diff = this.fillDiff;
    var canEmpty = this.canEmpty, canFill = this.canFill;

    if (m === 0) {
      for (i = 0; i < n; i++) {
        if (s[i] === FILLED) return false;
        if (s[i] === UNKNOWN) { s[i] = EMPTY; if (out) out.push(i); }
      }
      return true;
    }

    ep[0] = 0;
    for (i = 0; i < n; i++) ep[i + 1] = ep[i] + (s[i] === EMPTY ? 1 : 0);

    // ---- forward table
    for (j = 0; j <= m; j++) L[j] = j === 0 ? 1 : 0;
    for (i = 1; i <= n; i++) {
      var rowI = i * st, rowPrev = (i - 1) * st;
      for (j = 0; j <= m; j++) {
        var v = (L[rowPrev + j] && s[i - 1] !== FILLED) ? 1 : 0;
        if (!v && j >= 1) {
          k = clues[j - 1];
          p = i - k; // block j-1 occupies [p, i)
          if (p >= 0 && ep[i] - ep[p] === 0) {
            if (p === 0) v = (j === 1) ? 1 : 0;
            else if (s[p - 1] !== FILLED && L[(p - 1) * st + (j - 1)]) v = 1;
          }
        }
        L[rowI + j] = v;
      }
    }
    if (!L[n * st + m]) return false;

    // ---- backward table
    for (j = 0; j <= m; j++) R[n * st + j] = (j === m) ? 1 : 0;
    for (i = n - 1; i >= 0; i--) {
      var rI = i * st, rNext = (i + 1) * st;
      for (j = 0; j <= m; j++) {
        var w = (R[rNext + j] && s[i] !== FILLED) ? 1 : 0;
        if (!w && j < m) {
          k = clues[j];
          var e = i + k; // block j occupies [i, e)
          if (e <= n && ep[e] - ep[i] === 0) {
            if (e === n) w = (j === m - 1) ? 1 : 0;
            else if (s[e] !== FILLED && R[(e + 1) * st + (j + 1)]) w = 1;
          }
        }
        R[rI + j] = w;
      }
    }

    // ---- which cells may be empty in some arrangement
    for (i = 0; i < n; i++) {
      var ce = 0;
      if (s[i] !== FILLED) {
        var li = i * st, ri = (i + 1) * st;
        for (j = 0; j <= m; j++) if (L[li + j] && R[ri + j]) { ce = 1; break; }
      }
      canEmpty[i] = ce;
    }

    // ---- which cells may be filled in some arrangement (difference array over valid placements)
    for (i = 0; i <= n; i++) diff[i] = 0;
    for (j = 0; j < m; j++) {
      k = clues[j];
      for (p = 0; p + k <= n; p++) {
        if (ep[p + k] - ep[p] !== 0) continue;
        var okL = (p === 0) ? (j === 0) : (s[p - 1] !== FILLED && L[(p - 1) * st + j]);
        if (!okL) continue;
        var q = p + k;
        var okR = (q === n) ? (j === m - 1) : (s[q] !== FILLED && R[(q + 1) * st + (j + 1)]);
        if (!okR) continue;
        diff[p]++; diff[q]--;
      }
    }
    var acc = 0;
    for (i = 0; i < n; i++) { acc += diff[i]; canFill[i] = acc > 0 ? 1 : 0; }

    for (i = 0; i < n; i++) {
      if (s[i] !== UNKNOWN) continue;
      if (canFill[i] && !canEmpty[i]) { s[i] = FILLED; if (out) out.push(i); }
      else if (canEmpty[i] && !canFill[i]) { s[i] = EMPTY; if (out) out.push(i); }
      else if (!canEmpty[i] && !canFill[i]) return false; // cannot happen when L[n][m] holds
    }
    return true;
  };

  /* ---------------------------------------------------------- full solver */
  /*
   * Round-based propagation: every round runs all dirty rows, then all dirty columns.
   * Returns { status: 'solved'|'stuck'|'contradiction', grid, rounds, cellRound, score }
   *   cellRound[i] = the round in which cell i was determined (1-based); 0 if never.
   *   score        = difficulty estimate (higher = harder), see difficultyScore().
   * `initial` (optional Uint8Array) seeds the grid, e.g. with a player's marks, for hints.
   */
  function solve(rowClues, colClues, initial, maxRounds) {
    var rows = rowClues.length, cols = colClues.length, n = rows * cols;
    var grid = new Uint8Array(n);
    if (initial) grid.set(initial);
    var ls = new LineSolver(Math.max(rows, cols));
    var line = ls.line, changed = [];
    var rowDirty = new Uint8Array(rows), colDirty = new Uint8Array(cols);
    var cellRound = new Uint8Array(n);
    var r, c, i, rounds = 0, unknown = 0, determinedByRound = [];
    for (i = 0; i < n; i++) if (grid[i] === UNKNOWN) unknown++;
    for (r = 0; r < rows; r++) rowDirty[r] = 1;
    for (c = 0; c < cols; c++) colDirty[c] = 1;
    maxRounds = maxRounds || 250;

    while (unknown > 0 && rounds < maxRounds) {
      rounds++;
      var progress = 0;
      for (r = 0; r < rows; r++) {
        if (!rowDirty[r]) continue;
        rowDirty[r] = 0;
        var base = r * cols;
        for (c = 0; c < cols; c++) line[c] = grid[base + c];
        changed.length = 0;
        if (!ls.solveLine(line, cols, rowClues[r], changed)) return { status: 'contradiction', grid: grid, rounds: rounds, cellRound: cellRound, score: 0 };
        for (i = 0; i < changed.length; i++) {
          c = changed[i];
          grid[base + c] = line[c];
          cellRound[base + c] = rounds;
          colDirty[c] = 1;
        }
        unknown -= changed.length; progress += changed.length;
      }
      for (c = 0; c < cols; c++) {
        if (!colDirty[c]) continue;
        colDirty[c] = 0;
        for (r = 0; r < rows; r++) line[r] = grid[r * cols + c];
        changed.length = 0;
        if (!ls.solveLine(line, rows, colClues[c], changed)) return { status: 'contradiction', grid: grid, rounds: rounds, cellRound: cellRound, score: 0 };
        for (i = 0; i < changed.length; i++) {
          r = changed[i];
          grid[r * cols + c] = line[r];
          cellRound[r * cols + c] = rounds;
          rowDirty[r] = 1;
        }
        unknown -= changed.length; progress += changed.length;
      }
      determinedByRound.push(progress);
      if (progress === 0) break;
    }
    var status = unknown === 0 ? 'solved' : 'stuck';
    return {
      status: status, grid: grid, rounds: rounds, cellRound: cellRound,
      score: status === 'solved' ? difficultyScore(cellRound, n, rounds) : 0
    };
  }

  // Difficulty ~ how deep the deduction chain runs. Mean round of determination, scaled so
  // that a puzzle solved almost entirely in round 1 scores ~1 and long chains score higher.
  function difficultyScore(cellRound, n, rounds) {
    var sum = 0;
    for (var i = 0; i < n; i++) sum += cellRound[i];
    var mean = sum / n;
    return Math.round((mean * 0.7 + rounds * 0.3) * 100) / 100;
  }

  /* ----------------------------------------------------------- generator */
  var DIFFICULTY = { easy: 0, normal: 1, hard: 2 };

  // Tuning per size: candidates to compare when picking a difficulty, and repair budget.
  function genParams(size) {
    if (size <= 5)  return { candidates: 16, repairs: 60,  density: [0.45, 0.65] };
    if (size <= 10) return { candidates: 12, repairs: 120, density: [0.48, 0.62] };
    if (size <= 15) return { candidates: 10, repairs: 250, density: [0.50, 0.62] };
    if (size <= 20) return { candidates: 8,  repairs: 400, density: [0.52, 0.62] };
    return           { candidates: 6,  repairs: 600, density: [0.54, 0.62] };
  }

  /*
   * Make one line-solvable grid: random fill, then while the logic solver gets stuck,
   * flip a few cells inside the undetermined region and try again. Converges quickly
   * because every flip perturbs exactly the rows/columns that were ambiguous.
   */
  function makeSolvableGrid(rows, cols, rng, density, maxRepairs) {
    var n = rows * cols, grid = new Uint8Array(n), i;
    for (i = 0; i < n; i++) grid[i] = rng() < density ? FILLED : EMPTY;
    for (var attempt = 0; attempt <= maxRepairs; attempt++) {
      var cl = cluesFromGrid(grid, rows, cols);
      var res = solve(cl.rowClues, cl.colClues);
      if (res.status === 'solved') {
        return { grid: grid, rowClues: cl.rowClues, colClues: cl.colClues, score: res.score, rounds: res.rounds, repairs: attempt };
      }
      // collect undetermined cells and flip a handful of them
      var unknown = [];
      for (i = 0; i < n; i++) if (res.grid[i] === UNKNOWN) unknown.push(i);
      var flips = 1 + Math.floor(rng() * Math.min(3, unknown.length));
      for (var f = 0; f < flips; f++) {
        var idx = unknown[Math.floor(rng() * unknown.length)];
        grid[idx] = grid[idx] === FILLED ? EMPTY : FILLED;
      }
    }
    return null;
  }

  /*
   * generate(size, opts)
   *   opts.difficulty : 'easy' | 'normal' | 'hard'   (default 'normal')
   *   opts.seed       : uint32 (default random)  — same size+difficulty+seed => same puzzle
   *   opts.rows/cols  : override for non-square boards
   * Deterministic for a given (rows, cols, difficulty, seed).
   */
  function generate(size, opts) {
    opts = opts || {};
    var rows = opts.rows || size, cols = opts.cols || size;
    var difficulty = (opts.difficulty in DIFFICULTY) ? opts.difficulty : 'normal';
    var seed = (opts.seed === undefined || opts.seed === null) ? randomSeed() : (opts.seed >>> 0);
    // difficulty folded into the stream so easy/normal/hard with the same seed differ
    var rng = mulberry32((seed ^ (DIFFICULTY[difficulty] * 0x9E3779B1)) >>> 0);
    var P = genParams(Math.max(rows, cols));
    var candidates = [], t0 = now();
    for (var k = 0; k < P.candidates; k++) {
      var density = P.density[0] + rng() * (P.density[1] - P.density[0]);
      var g = makeSolvableGrid(rows, cols, rng, density, P.repairs);
      if (g) candidates.push(g);
    }
    if (!candidates.length) { // astronomically unlikely, but never return nothing
      var g2 = null;
      while (!g2) g2 = makeSolvableGrid(rows, cols, rng, 0.55, 5000);
      candidates.push(g2);
    }
    candidates.sort(function (a, b) { return a.score - b.score; });
    var last = candidates.length - 1, pick;
    if (difficulty === 'easy') pick = candidates[Math.round(last * 0.2)];        // gentle, not braindead
    else if (difficulty === 'hard') pick = candidates[last];                       // longest deduction chain
    else pick = candidates[Math.round(last * 0.55)];                               // a touch above the median
    return {
      rows: rows, cols: cols, size: size, difficulty: difficulty, seed: seed,
      code: puzzleCode(size, difficulty, seed),
      solution: pick.grid, rowClues: pick.rowClues, colClues: pick.colClues,
      score: pick.score, rounds: pick.rounds, genMs: Math.round(now() - t0)
    };
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function puzzleCode(size, difficulty, seed) {
    return size + 'x' + size + '-' + difficulty.charAt(0).toUpperCase() + '-' + seed;
  }

  // "10x10-N-482130" -> {size, difficulty, seed} or null
  function parseCode(str) {
    var m = /^\s*(\d{1,2})\s*[xX×]\s*(\d{1,2})\s*[-\s]\s*([ENHenh])\s*[-\s]\s*(\d{1,10})\s*$/.exec(str || '');
    if (!m) return null;
    var size = parseInt(m[1], 10);
    if (size !== parseInt(m[2], 10) || size < 5 || size > 30) return null;
    var d = { E: 'easy', N: 'normal', H: 'hard' }[m[3].toUpperCase()];
    return { size: size, difficulty: d, seed: parseInt(m[4], 10) >>> 0 };
  }

  /* ------------------------------------------------- helpers for the UI */
  // Does the player's marking of this line satisfy its clues exactly? (X and unknown both count as empty)
  function lineComplete(cells, start, step, n, clues) {
    var got = lineClues(cells, start, step, n);
    if (got.length !== clues.length) return false;
    for (var i = 0; i < clues.length; i++) if (got[i] !== clues[i]) return false;
    return true;
  }

  /*
   * Per-clue satisfied flags for greying out clue numbers while solving.
   * Conservative: a clue is marked only when its run is closed (bounded by X or the edge on
   * both sides) and everything before it (from that side) is already resolved. Never marks
   * something a careful player couldn't also mark.
   */
  function clueStatus(cells, start, step, n, clues) {
    var m = clues.length, done = new Array(m), i;
    for (i = 0; i < m; i++) done[i] = false;
    if (m === 0) return done;
    if (lineComplete(cells, start, step, n, clues)) { for (i = 0; i < m; i++) done[i] = true; return done; }
    var get = function (i) { return cells[start + i * step]; };
    // from the left
    var pos = 0, ci = 0;
    while (ci < m && pos < n) {
      var v = get(pos);
      if (v === EMPTY) { pos++; continue; }
      if (v === UNKNOWN) break;
      var runStart = pos;
      while (pos < n && get(pos) === FILLED) pos++;
      var closed = (pos === n) || get(pos) === EMPTY;
      if (!closed || pos - runStart !== clues[ci]) break;
      done[ci] = true; ci++;
    }
    // from the right
    pos = n - 1; ci = m - 1;
    while (ci >= 0 && pos >= 0 && !done[ci]) {
      var w = get(pos);
      if (w === EMPTY) { pos--; continue; }
      if (w === UNKNOWN) break;
      var runEnd = pos;
      while (pos >= 0 && get(pos) === FILLED) pos--;
      var closedR = (pos < 0) || get(pos) === EMPTY;
      if (!closedR || runEnd - pos !== clues[ci]) break;
      done[ci] = true; ci--;
    }
    return done;
  }

  /*
   * Find a hint for the player.
   *   marks: player's current grid (0/1/2), solution: truth (1/2)
   * Returns one of:
   *   { type:'wrongFill', index }        a filled cell that should be empty
   *   { type:'wrongX', index }           an X on a cell that should be filled
   *   { type:'deduce', index, value, line:{kind:'row'|'col', index} }  a cell that logic determines now
   *   null                               nothing left (solved)
   */
  function hint(marks, solution, rows, cols, rowClues, colClues) {
    var n = rows * cols, i;
    for (i = 0; i < n; i++) if (marks[i] === FILLED && solution[i] !== FILLED) return { type: 'wrongFill', index: i };
    for (i = 0; i < n; i++) if (marks[i] === EMPTY && solution[i] === FILLED) return { type: 'wrongX', index: i };
    var ls = new LineSolver(Math.max(rows, cols)), line = ls.line, out = [];
    var best = null, r, c;
    for (r = 0; r < rows; r++) {
      for (c = 0; c < cols; c++) line[c] = marks[r * cols + c];
      out.length = 0;
      if (ls.solveLine(line, cols, rowClues[r], out) && out.length && (!best || out.length > best.count)) {
        best = { count: out.length, index: r * cols + out[0], value: line[out[0]], line: { kind: 'row', index: r } };
      }
    }
    for (c = 0; c < cols; c++) {
      for (r = 0; r < rows; r++) line[r] = marks[r * cols + c];
      out.length = 0;
      if (ls.solveLine(line, rows, colClues[c], out) && out.length && (!best || out.length > best.count)) {
        best = { count: out.length, index: out[0] * cols + c, value: line[out[0]], line: { kind: 'col', index: c } };
      }
    }
    if (best) return { type: 'deduce', index: best.index, value: best.value, line: best.line };
    // Fallback (should not happen on a line-solvable puzzle with correct marks): reveal any unknown cell
    for (i = 0; i < n; i++) if (marks[i] === UNKNOWN) return { type: 'deduce', index: i, value: solution[i], line: null };
    return null;
  }

  // Count solutions by backtracking (capped). Used by tests to prove uniqueness independently.
  function countSolutions(rowClues, colClues, cap) {
    var rows = rowClues.length, cols = colClues.length;
    var grid = new Uint8Array(rows * cols), count = 0;
    cap = cap || 2;
    var ls = new LineSolver(Math.max(rows, cols)), line = ls.line;
    function colOk(c) { // partial column check via DP feasibility (unknown below current row)
      for (var r = 0; r < rows; r++) line[r] = grid[r * cols + c];
      return ls.solveLine(line, rows, colClues[c], null);
    }
    function placeRow(r) {
      if (count >= cap) return;
      if (r === rows) { count++; return; }
      // enumerate all arrangements of row r
      var clues = rowClues[r], m = clues.length;
      var pos = new Int16Array(m);
      function rec(j, from) {
        if (count >= cap) return;
        if (j === m) {
          var base = r * cols, c;
          for (c = 0; c < cols; c++) grid[base + c] = EMPTY;
          for (var t = 0; t < m; t++) for (c = 0; c < clues[t]; c++) grid[base + pos[t] + c] = FILLED;
          for (c = 0; c < cols; c++) if (!colOk(c)) { for (var cc = 0; cc < cols; cc++) grid[base + cc] = UNKNOWN; return; }
          placeRow(r + 1);
          for (c = 0; c < cols; c++) grid[base + c] = UNKNOWN;
          return;
        }
        var rest = 0; for (var t2 = j + 1; t2 < m; t2++) rest += clues[t2] + 1;
        for (var p = from; p + clues[j] + rest <= cols; p++) { pos[j] = p; rec(j + 1, p + clues[j] + 1); }
      }
      rec(0, 0);
    }
    placeRow(0);
    return count;
  }

  return {
    UNKNOWN: UNKNOWN, FILLED: FILLED, EMPTY: EMPTY,
    mulberry32: mulberry32, randomSeed: randomSeed,
    lineClues: lineClues, cluesFromGrid: cluesFromGrid,
    LineSolver: LineSolver, solve: solve, generate: generate,
    puzzleCode: puzzleCode, parseCode: parseCode,
    lineComplete: lineComplete, clueStatus: clueStatus, hint: hint,
    countSolutions: countSolutions, genParams: genParams
  };
};

var Nonogram = NonogramEngineFactory();
if (typeof module !== 'undefined' && module.exports) module.exports = Nonogram;
