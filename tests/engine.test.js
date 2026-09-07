// Run with: node tests/engine.test.js
'use strict';
const N = require('../src/nonogram.js');
const assert = require('assert');
const { UNKNOWN, FILLED, EMPTY } = N;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name); console.log(e.stack || e); process.exitCode = 1; }
}

// ---------- brute-force reference for one line
function bruteLine(states, clues) {
  const n = states.length;
  let feasible = false;
  const canF = new Array(n).fill(false), canE = new Array(n).fill(false);
  for (let mask = 0; mask < (1 << n); mask++) {
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const f = (mask >> i) & 1;
      if (states[i] === FILLED && !f) ok = false;
      if (states[i] === EMPTY && f) ok = false;
    }
    if (!ok) continue;
    const runs = [];
    let run = 0;
    for (let i = 0; i < n; i++) { if ((mask >> i) & 1) run++; else if (run) { runs.push(run); run = 0; } }
    if (run) runs.push(run);
    if (runs.length !== clues.length || runs.some((v, i) => v !== clues[i])) continue;
    feasible = true;
    for (let i = 0; i < n; i++) { if ((mask >> i) & 1) canF[i] = true; else canE[i] = true; }
  }
  return { feasible, canF, canE };
}

test('line solver matches brute force on 3000 random lines', () => {
  const rng = N.mulberry32(12345);
  const ls = new N.LineSolver(12);
  for (let t = 0; t < 3000; t++) {
    const n = 1 + Math.floor(rng() * 12);
    // random truth line -> clues, then random partial reveal (sometimes deliberately wrong)
    const truth = [];
    for (let i = 0; i < n; i++) truth.push(rng() < 0.55 ? FILLED : EMPTY);
    const clues = N.lineClues(truth, 0, 1, n);
    const states = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const u = rng();
      if (u < 0.3) states[i] = truth[i];
      else if (u < 0.35) states[i] = truth[i] === FILLED ? EMPTY : FILLED; // inject a contradiction sometimes
    }
    const ref = bruteLine(Array.from(states), clues);
    const s = new Uint8Array(states);
    const out = [];
    const ok = ls.solveLine(s, n, clues, out);
    assert.strictEqual(ok, ref.feasible, `feasibility mismatch n=${n} clues=${clues} states=${Array.from(states)}`);
    if (!ok) continue;
    for (let i = 0; i < n; i++) {
      let expect = states[i];
      if (expect === UNKNOWN) {
        if (ref.canF[i] && !ref.canE[i]) expect = FILLED;
        else if (ref.canE[i] && !ref.canF[i]) expect = EMPTY;
      }
      assert.strictEqual(s[i], expect, `cell ${i} n=${n} clues=${clues} states=${Array.from(states)} got=${Array.from(s)}`);
    }
    // out must list exactly the newly determined cells
    const newly = [];
    for (let i = 0; i < n; i++) if (states[i] === UNKNOWN && s[i] !== UNKNOWN) newly.push(i);
    assert.deepStrictEqual(out, newly);
  }
});

test('empty-clue lines are forced empty, contradiction on a filled cell', () => {
  const ls = new N.LineSolver(5);
  const s = new Uint8Array(5);
  assert.ok(ls.solveLine(s, 5, [], null));
  assert.deepStrictEqual(Array.from(s), [2, 2, 2, 2, 2]);
  s[2] = FILLED;
  assert.strictEqual(ls.solveLine(s, 5, [], null), false);
});

test('classic overlap: [4] in 5 cells forces the middle three', () => {
  const ls = new N.LineSolver(5);
  const s = new Uint8Array(5);
  ls.solveLine(s, 5, [4], null);
  assert.deepStrictEqual(Array.from(s), [0, 1, 1, 1, 0]);
});

test('full line: [1,1,1] in 5 cells solves completely', () => {
  const ls = new N.LineSolver(5);
  const s = new Uint8Array(5);
  ls.solveLine(s, 5, [1, 1, 1], null);
  assert.deepStrictEqual(Array.from(s), [1, 2, 1, 2, 1]);
});

test('parseCode / puzzleCode round trip', () => {
  const code = N.puzzleCode(10, 'hard', 482130);
  assert.strictEqual(code, '10x10-H-482130');
  assert.deepStrictEqual(N.parseCode(code), { size: 10, difficulty: 'hard', seed: 482130 });
  assert.deepStrictEqual(N.parseCode(' 5 x 5 - n - 7 '), { size: 5, difficulty: 'normal', seed: 7 });
  assert.strictEqual(N.parseCode('10x12-N-1'), null);
  assert.strictEqual(N.parseCode('garbage'), null);
});

test('generate is deterministic for the same size/difficulty/seed', () => {
  const a = N.generate(10, { difficulty: 'normal', seed: 777 });
  const b = N.generate(10, { difficulty: 'normal', seed: 777 });
  assert.deepStrictEqual(Array.from(a.solution), Array.from(b.solution));
  const c = N.generate(10, { difficulty: 'hard', seed: 777 });
  assert.notDeepStrictEqual(Array.from(a.solution), Array.from(c.solution));
});

test('generated puzzles are line-solvable and the solver reproduces the solution', () => {
  for (const size of [5, 10, 15]) {
    for (let s = 1; s <= 6; s++) {
      const p = N.generate(size, { seed: s * 31 + size, difficulty: ['easy', 'normal', 'hard'][s % 3] });
      const res = N.solve(p.rowClues, p.colClues);
      assert.strictEqual(res.status, 'solved', `size ${size} seed ${s}`);
      assert.deepStrictEqual(Array.from(res.grid), Array.from(p.solution));
    }
  }
});

test('generated 5x5 and 10x10 puzzles have exactly one solution (independent backtracking count)', () => {
  for (const size of [5, 10]) {
    for (let s = 1; s <= 25; s++) {
      const p = N.generate(size, { seed: 1000 + s * 7 + size });
      assert.strictEqual(N.countSolutions(p.rowClues, p.colClues, 2), 1, `size ${size} seed ${s}`);
    }
  }
});

test('countSolutions finds 2 for a known ambiguous puzzle', () => {
  // 2x2 checkerboard: rows [1],[1]; cols [1],[1] -> two solutions
  assert.strictEqual(N.countSolutions([[1], [1]], [[1], [1]], 5), 2);
});

test('clueStatus marks closed runs from both ends only', () => {
  // line:  X # # X . . # #   clues [2, 2]  -> both done? the right run is closed by the edge; the left run closed by X
  const cells = new Uint8Array([EMPTY, FILLED, FILLED, EMPTY, UNKNOWN, UNKNOWN, FILLED, FILLED]);
  assert.deepStrictEqual(N.clueStatus(cells, 0, 1, 8, [2, 2]), [true, true]);
  // an unknown before the first run means the first run might be a later clue
  const cells2 = new Uint8Array([UNKNOWN, FILLED, FILLED, EMPTY, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]);
  assert.deepStrictEqual(N.clueStatus(cells2, 0, 1, 8, [2, 2]), [false, false]);
  // open run (unknown after it) is not done
  const cells3 = new Uint8Array([EMPTY, FILLED, FILLED, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN, UNKNOWN]);
  assert.deepStrictEqual(N.clueStatus(cells3, 0, 1, 8, [2, 2]), [false, false]);
  // whole line matching the clues => all done even with unknowns left
  const cells4 = new Uint8Array([UNKNOWN, FILLED, FILLED, UNKNOWN, UNKNOWN, UNKNOWN, FILLED, FILLED]);
  assert.deepStrictEqual(N.clueStatus(cells4, 0, 1, 8, [2, 2]), [true, true]);
  assert.ok(N.lineComplete(cells4, 0, 1, 8, [2, 2]));
  // strided access (a column)
  const grid = new Uint8Array(9); grid[1] = FILLED; grid[4] = FILLED; grid[7] = EMPTY;
  assert.deepStrictEqual(N.clueStatus(grid, 1, 3, 3, [2]), [true]);
});

test('hint points out mistakes first, then a deducible cell', () => {
  const p = N.generate(5, { seed: 42 });
  const marks = new Uint8Array(25);
  // wrong fill
  let idx = Array.from(p.solution).findIndex(v => v === EMPTY);
  marks[idx] = FILLED;
  let h = N.hint(marks, p.solution, 5, 5, p.rowClues, p.colClues);
  assert.deepStrictEqual(h, { type: 'wrongFill', index: idx });
  marks[idx] = UNKNOWN;
  // wrong X
  idx = Array.from(p.solution).findIndex(v => v === FILLED);
  marks[idx] = EMPTY;
  h = N.hint(marks, p.solution, 5, 5, p.rowClues, p.colClues);
  assert.deepStrictEqual(h, { type: 'wrongX', index: idx });
  marks[idx] = UNKNOWN;
  // deduction: the hinted value must match the solution
  h = N.hint(marks, p.solution, 5, 5, p.rowClues, p.colClues);
  assert.strictEqual(h.type, 'deduce');
  assert.strictEqual(h.value, p.solution[h.index]);
  assert.ok(h.line && (h.line.kind === 'row' || h.line.kind === 'col'));
  // hints keep working until solved (monotone: extra correct info never blocks the line solver)
  let steps = 0;
  while ((h = N.hint(marks, p.solution, 5, 5, p.rowClues, p.colClues)) && steps < 30) {
    assert.strictEqual(h.type, 'deduce');
    assert.strictEqual(h.value, p.solution[h.index]);
    marks[h.index] = h.value; steps++;
  }
  assert.strictEqual(h, null);
});

console.log(`\n${passed} test group(s) passed${process.exitCode ? ', with failures' : ''}`);
