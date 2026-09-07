// node tests/bench.js  — generation timing + difficulty spread per size
'use strict';
const N = require('../src/nonogram.js');
const sizes = [5, 10, 15, 20, 25];
for (const size of sizes) {
  const times = [], scores = { easy: [], normal: [], hard: [] }, rounds = { easy: [], normal: [], hard: [] };
  const runs = size >= 20 ? 6 : 12;
  for (let i = 0; i < runs; i++) {
    for (const d of ['easy', 'normal', 'hard']) {
      const t0 = process.hrtime.bigint();
      const p = N.generate(size, { seed: 5000 + i * 13 + size, difficulty: d });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      times.push(ms);
      scores[d].push(p.score);
      rounds[d].push(p.rounds);
    }
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)], max = times[times.length - 1];
  const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  console.log(`${size}x${size}: gen median ${med.toFixed(0)} ms, max ${max.toFixed(0)} ms | score easy ${avg(scores.easy)} normal ${avg(scores.normal)} hard ${avg(scores.hard)} | rounds easy ${avg(rounds.easy)} normal ${avg(rounds.normal)} hard ${avg(rounds.hard)}`);
}
// single solve timing at 25x25
const p = N.generate(25, { seed: 99 });
let t0 = process.hrtime.bigint();
for (let i = 0; i < 50; i++) N.solve(p.rowClues, p.colClues);
console.log(`25x25 solve: ${(Number(process.hrtime.bigint() - t0) / 1e6 / 50).toFixed(2)} ms each`);
// repairs needed
for (const size of sizes) {
  const rng = N.mulberry32(1);
  const P = N.genParams(size);
  let tot = 0, fails = 0, n = size >= 20 ? 10 : 30;
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    // emulate one candidate
    const g = (function () {
      const rows = size, cols = size, grid = new Uint8Array(rows * cols);
      const density = P.density[0] + rng() * (P.density[1] - P.density[0]);
      for (let k = 0; k < grid.length; k++) grid[k] = rng() < density ? 1 : 2;
      for (let a = 0; a <= P.repairs; a++) {
        const cl = N.cluesFromGrid(grid, rows, cols);
        const res = N.solve(cl.rowClues, cl.colClues);
        if (res.status === 'solved') return a;
        const unk = []; for (let k = 0; k < grid.length; k++) if (res.grid[k] === 0) unk.push(k);
        const flips = 1 + Math.floor(rng() * Math.min(3, unk.length));
        for (let f = 0; f < flips; f++) { const idx = unk[Math.floor(rng() * unk.length)]; grid[idx] = grid[idx] === 1 ? 2 : 1; }
      }
      return null;
    })();
    if (g === null) fails++; else tot += g;
  }
  console.log(`${size}x${size}: avg repairs ${(tot / Math.max(1, n - fails)).toFixed(1)}, failures ${fails}/${n}`);
}
