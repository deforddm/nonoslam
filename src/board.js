/*
 * NONOSLAM — canvas board: rendering, zoom/pan, and touch/mouse gestures.
 *
 * The board owns the *view* (scale/offset, highlights, animations) and turns pointer input into
 * stroke callbacks. The game (app.js) owns the *rules*: which cells a stroke may change, mistakes,
 * undo, completion. Contract:
 *   cb.strokeStart(index, tool) -> bool      begin a stroke on a cell with 'fill' | 'x'; false = ignore
 *   cb.strokeCell(index)        -> bool      extend the stroke to a cell; false = stop the stroke
 *   cb.strokeEnd()                          commit the stroke
 *   cb.strokeCancel()                       throw the stroke away (a pinch began right after touch)
 *   cb.cellFlag(index)          -> 0|1      1 = draw this cell as a mistake
 *   cb.lineTap(kind, index)                 tapped a clue band ('row' | 'col')
 */
var NonoBoard = (function () {
  'use strict';
  var UNKNOWN = 0, FILLED = 1, EMPTY = 2;
  var CLUE_H = 0.66;           // height of one stacked column clue, in band units
  var PAD = 0.3;               // clue band padding, in band units
  var BAND_MAX = 34;           // clue bands stop growing past this cell size so zooming in doesn't let them eat the screen
  var MIN_COMFY = 20;          // smallest cell size (px) we open a board at; bigger boards scroll instead

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clueWidth(n) { return n >= 10 ? 0.92 : 0.62; }
  function now() { return performance.now(); }

  function Board(canvas, wrap, badge, cb) {
    this.canvas = canvas; this.wrap = wrap; this.badge = badge; this.cb = cb;
    this.ctx = canvas.getContext('2d');
    this.dpr = 1; this.vw = 0; this.vh = 0;
    this.puzzle = null; this.marks = null; this.rows = 0; this.cols = 0;
    this.rowClues = []; this.colClues = [];
    this.clueW = 1; this.clueH = 1;
    this.scale = 30; this.minScale = 10; this.maxScale = 80; this.fitScale = 30;
    this.ox = 0; this.oy = 0;
    this.tool = 'fill';
    this.opts = { thickLines: true, highlightLine: true, longPress: true, counter: true };
    this.colors = {};
    this.pointers = new Map(); this.gesture = null; this.lpTimer = null;
    this.hover = null;          // {r, c} from the mouse
    this.pinned = null;         // {kind, index} from tapping a clue band
    this.active = null;         // {r, c} during a stroke
    this.anims = [];            // {type, index, line, t0, dur}
    this.raf = 0;
    this.locked = false;        // ignore input (paused / finished)
    this._bind();
    var self = this;
    if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); }).observe(wrap);
    else window.addEventListener('resize', function () { self.resize(); });
  }

  /* ------------------------------------------------------------- setup */
  Board.prototype.refreshTheme = function () {
    var cs = getComputedStyle(document.documentElement);
    var get = function (n) { return cs.getPropertyValue(n).trim(); };
    this.colors = {
      bg: get('--board-bg'), empty: get('--cell-empty'), filled: get('--cell-filled'), x: get('--cell-x'),
      line: get('--grid-line'), thick: get('--grid-thick'), clue: get('--clue-text'), done: get('--clue-done'),
      band: get('--clue-band'), hl: get('--highlight'), mistake: get('--mistake'), hint: get('--hint'),
      accent: get('--accent'), slam: get('--slam'), ok: get('--ok')
    };
    this.render();
  };

  Board.prototype.setOptions = function (o) { for (var k in o) this.opts[k] = o[k]; this.render(); };
  Board.prototype.setTool = function (t) { this.tool = t; this.canvas.classList.toggle('panning', t === 'pan'); };
  Board.prototype.setLocked = function (v) { this.locked = v; if (v) this._abortGesture(); };

  Board.prototype.setPuzzle = function (puzzle, marks) {
    this.puzzle = puzzle; this.marks = marks;
    this.rows = puzzle.rows; this.cols = puzzle.cols;
    this.rowClues = puzzle.rowClues; this.colClues = puzzle.colClues;
    var maxW = 1, maxN = 1, r, c, i, w;
    for (r = 0; r < this.rows; r++) {
      var cl = this.rowClues[r]; w = 0;
      if (!cl.length) w = clueWidth(0); else for (i = 0; i < cl.length; i++) w += clueWidth(cl[i]);
      if (w > maxW) maxW = w;
    }
    for (c = 0; c < this.cols; c++) maxN = Math.max(maxN, this.colClues[c].length || 1);
    this.clueW = maxW + PAD;
    this.clueH = maxN * CLUE_H + PAD;
    this.pinned = null; this.hover = null; this.active = null; this.anims = [];
    this.pendingReset = true;
    this.resize();
  };

  Board.prototype.resize = function () {
    var rect = this.wrap.getBoundingClientRect();
    this.vw = Math.max(1, Math.round(rect.width)); this.vh = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.vw * this.dpr); this.canvas.height = Math.round(this.vh * this.dpr);
    if (!this.puzzle) return;
    if (this.vw < 40 || this.vh < 40) return; // screen is hidden; keep the pending reset for when it shows
    this.fitScale = this._computeFit();
    this.minScale = Math.min(this.fitScale, 40);
    this.maxScale = 64;
    if (this.pendingReset) {
      this.pendingReset = false;
      this.scale = clamp(this.fitScale, MIN_COMFY, this.maxScale);
      this.ox = 0; this.oy = 0;
    }
    this._clampView();
    this.render();
  };

  // Largest cell size at which the whole board (clue bands included) fits the viewport.
  Board.prototype._computeFit = function () {
    var aw = this.vw - 8, ah = this.vh - 8;
    var sw = aw / (this.clueW + this.cols);
    if (sw > BAND_MAX) sw = (aw - this.clueW * BAND_MAX) / this.cols;
    var sh = ah / (this.clueH + this.rows);
    if (sh > BAND_MAX) sh = (ah - this.clueH * BAND_MAX) / this.rows;
    return Math.max(4, Math.min(sw, sh));
  };

  // Toggle between "see everything" and a comfortable zoom.
  Board.prototype.fit = function () {
    var whole = clamp(this.fitScale, this.minScale, this.maxScale);
    var comfy = clamp(this.fitScale, MIN_COMFY, this.maxScale);
    this.scale = (Math.abs(this.scale - whole) < 0.5 && Math.abs(whole - comfy) > 0.5) ? comfy : whole;
    this._clampView(); this.render();
  };

  Board.prototype._clampView = function () {
    var g = this._geom(), bw = g.bandW + this.cols * g.s, bh = g.bandH + this.rows * g.s;
    if (bw <= this.vw) this.ox = (this.vw - bw) / 2; else this.ox = clamp(this.ox, this.vw - bw, 0);
    if (bh <= this.vh) this.oy = (this.vh - bh) / 2; else this.oy = clamp(this.oy, this.vh - bh, 0);
  };

  // Zoom so that the grid point under (px, py) stays under it.
  Board.prototype._zoomTo = function (px, py, ns, u, v) {
    ns = clamp(ns, this.minScale, this.maxScale);
    var bs = Math.min(ns, BAND_MAX);
    this.ox = px - u * ns - this.clueW * bs;
    this.oy = py - v * ns - this.clueH * bs;
    this.scale = ns; this._clampView();
  };
  Board.prototype._zoomAt = function (px, py, factor) {
    var g = this._geom();
    this._zoomTo(px, py, this.scale * factor, (px - g.gridX) / g.s, (py - g.gridY) / g.s);
  };

  /* ---------------------------------------------------------- geometry */
  // Everything in CSS px. Bands scale with the grid up to BAND_MAX and then stop growing.
  Board.prototype._geom = function () {
    var s = this.scale, bs = Math.min(s, BAND_MAX);
    var bandW = this.clueW * bs, bandH = this.clueH * bs;
    return { s: s, bs: bs, gridX: this.ox + bandW, gridY: this.oy + bandH, bandX: Math.max(this.ox, 0), bandY: Math.max(this.oy, 0), bandW: bandW, bandH: bandH };
  };

  // What is under a point: cell / rowband / colband / outside
  Board.prototype.hitTest = function (px, py) {
    var g = this._geom();
    var inRowBand = px >= g.bandX && px < g.bandX + g.bandW && py >= g.gridY && py < g.gridY + this.rows * g.s;
    var inColBand = py >= g.bandY && py < g.bandY + g.bandH && px >= g.gridX && px < g.gridX + this.cols * g.s;
    if (inRowBand) return { kind: 'rowband', index: Math.floor((py - g.gridY) / g.s) };
    if (inColBand) return { kind: 'colband', index: Math.floor((px - g.gridX) / g.s) };
    if (px < g.bandX + g.bandW || py < g.bandY + g.bandH) return { kind: 'outside' };
    var c = Math.floor((px - g.gridX) / g.s), r = Math.floor((py - g.gridY) / g.s);
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return { kind: 'outside' };
    return { kind: 'cell', r: r, c: c, index: r * this.cols + c };
  };

  Board.prototype._cellAtClamped = function (px, py) {
    var g = this._geom();
    return { r: clamp(Math.floor((py - g.gridY) / g.s), 0, this.rows - 1), c: clamp(Math.floor((px - g.gridX) / g.s), 0, this.cols - 1) };
  };

  // Screen-space centre of a cell (used by tests and hints)
  Board.prototype.cellCenter = function (r, c) {
    var g = this._geom();
    return { x: g.gridX + (c + 0.5) * g.s, y: g.gridY + (r + 0.5) * g.s };
  };

  // Scroll so a cell is visible (for hints on big boards)
  Board.prototype.revealCell = function (r, c) {
    var g = this._geom(), s = g.s;
    var x0 = g.gridX + c * s, y0 = g.gridY + r * s;
    if (x0 < g.bandX + g.bandW) this.ox += (g.bandX + g.bandW) - x0 + s;
    else if (x0 + s > this.vw) this.ox -= (x0 + s) - this.vw + s;
    if (y0 < g.bandY + g.bandH) this.oy += (g.bandY + g.bandH) - y0 + s;
    else if (y0 + s > this.vh) this.oy -= (y0 + s) - this.vh + s;
    this._clampView(); this.render();
  };

  /* --------------------------------------------------------- animation */
  Board.prototype.flashMistake = function (index) { this.anims.push({ type: 'mistake', index: index, t0: now(), dur: 650 }); this.render(); };
  Board.prototype.showHint = function (index, line) { this.anims.push({ type: 'hint', index: index, line: line, t0: now(), dur: 1800 }); this.render(); };
  Board.prototype.flashLine = function (kind, index) { this.anims.push({ type: 'line', line: { kind: kind, index: index }, t0: now(), dur: 450 }); this.render(); };
  Board.prototype.celebrate = function () { this.anims.push({ type: 'win', t0: now(), dur: 1400 }); this.render(); };

  /* ---------------------------------------------------------- gestures */
  Board.prototype._bind = function () {
    var self = this, cv = this.canvas;
    cv.addEventListener('pointerdown', function (e) { self._onDown(e); });
    cv.addEventListener('pointermove', function (e) { self._onMove(e); });
    cv.addEventListener('pointerup', function (e) { self._onUp(e); });
    cv.addEventListener('pointercancel', function (e) { self._onUp(e); });
    cv.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !self.pointers.size) { self.hover = null; self.render(); } });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = self._pos(e);
      self._zoomAt(p.x, p.y, Math.pow(1.0015, -e.deltaY));
      self.render();
    }, { passive: false });
  };

  Board.prototype._pos = function (e) {
    var rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  Board.prototype._onDown = function (e) {
    if (!this.puzzle) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    var p = this._pos(e);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, type: e.pointerType });
    this.hover = null;
    if (this.pointers.size === 1) {
      if (this.locked) { this.gesture = null; return; }
      var hit = this.hitTest(p.x, p.y);
      var wantPan = this.tool === 'pan' || e.button === 1 || hit.kind !== 'cell';
      if (wantPan) {
        this.gesture = { kind: 'pan', lx: p.x, ly: p.y, moved: false, hit: hit };
        return;
      }
      var t = this.tool;
      if (e.button === 2) t = (t === 'x') ? 'fill' : 'x';
      if (this.cb.strokeStart(hit.index, t)) {
        this.gesture = { kind: 'paint', tool: t, r: hit.r, c: hit.c, lastR: hit.r, lastC: hit.c, axis: null, moved: false, t0: now(), count: 1, type: e.pointerType };
        this.active = { r: hit.r, c: hit.c };
        this._badge(p, 1);
        if (this.opts.longPress && e.pointerType === 'touch') this._startLongPress();
        this.render();
      } else this.gesture = null;
    } else if (this.pointers.size === 2) {
      var g = this.gesture;
      if (g && g.kind === 'paint') {
        this._cancelLongPress();
        if (!g.moved && now() - g.t0 < 350) this.cb.strokeCancel(); else this.cb.strokeEnd();
        this._badge(null); this.active = null;
      }
      var pts = Array.from(this.pointers.values()), geo = this._geom();
      var mx0 = (pts[0].x + pts[1].x) / 2, my0 = (pts[0].y + pts[1].y) / 2;
      // remember which grid point sits under the pinch midpoint; keep it there while zooming
      this.gesture = { kind: 'pinch', d0: Math.max(1, dist(pts[0], pts[1])), s0: this.scale, u: (mx0 - geo.gridX) / geo.s, v: (my0 - geo.gridY) / geo.s };
    }
  };

  Board.prototype._onMove = function (e) {
    if (!this.puzzle) return;
    var p = this._pos(e), pt = this.pointers.get(e.pointerId);
    if (!pt) {
      if (e.pointerType === 'mouse' && !this.locked) {
        var hit = this.hitTest(p.x, p.y);
        var h = hit.kind === 'cell' ? { r: hit.r, c: hit.c } : null;
        if ((h && (!this.hover || this.hover.r !== h.r || this.hover.c !== h.c)) || (!h && this.hover)) { this.hover = h; this.render(); }
      }
      return;
    }
    pt.x = p.x; pt.y = p.y;
    var g = this.gesture;
    if (!g) return;
    if (g.kind === 'pan') {
      var dx = p.x - g.lx, dy = p.y - g.ly;
      this.ox += dx; this.oy += dy; g.lx = p.x; g.ly = p.y;
      if (Math.abs(p.x - pt.sx) > 5 || Math.abs(p.y - pt.sy) > 5) g.moved = true;
      this._clampView(); this.render();
    } else if (g.kind === 'pinch') {
      var pts = Array.from(this.pointers.values());
      if (pts.length < 2) return;
      var d = Math.max(1, dist(pts[0], pts[1]));
      var mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
      this._zoomTo(mx, my, g.s0 * d / g.d0, g.u, g.v);
      this.render();
    } else if (g.kind === 'paint') {
      var ddx = p.x - pt.sx, ddy = p.y - pt.sy;
      if (!g.moved && (Math.abs(ddx) > 6 || Math.abs(ddy) > 6)) { g.moved = true; this._cancelLongPress(); }
      var cell = this._cellAtClamped(p.x, p.y);
      if (!g.axis) {
        if (cell.r === g.r && cell.c === g.c) return;
        if (cell.r === g.r) g.axis = 'row';
        else if (cell.c === g.c) g.axis = 'col';
        else g.axis = Math.abs(ddx) >= Math.abs(ddy) ? 'row' : 'col';
      }
      var tr = g.axis === 'row' ? g.r : cell.r, tc = g.axis === 'row' ? cell.c : g.c;
      if (tr === g.lastR && tc === g.lastC) { this._badge(p, g.count); return; }
      var stepR = Math.sign(tr - g.lastR), stepC = Math.sign(tc - g.lastC);
      var r = g.lastR, c = g.lastC;
      while (r !== tr || c !== tc) {
        r += stepR; c += stepC;
        g.lastR = r; g.lastC = c;
        if (!this.cb.strokeCell(r * this.cols + c)) { this._finishStroke(); return; }
      }
      g.count = Math.abs(tr - g.r) + Math.abs(tc - g.c) + 1;
      this.active = { r: tr, c: tc };
      this._badge(p, g.count);
      this.render();
    }
  };

  Board.prototype._onUp = function (e) {
    var had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (!had) return;
    var g = this.gesture;
    if (!g) return;
    if (g.kind === 'paint') this._finishStroke();
    else if (g.kind === 'pan') {
      if (!g.moved && (g.hit.kind === 'rowband' || g.hit.kind === 'colband')) {
        var kind = g.hit.kind === 'rowband' ? 'row' : 'col';
        if (this.pinned && this.pinned.kind === kind && this.pinned.index === g.hit.index) this.pinned = null;
        else this.pinned = { kind: kind, index: g.hit.index };
        if (this.cb.lineTap) this.cb.lineTap(kind, g.hit.index);
        this.render();
      } else if (!g.moved && g.hit.kind === 'outside' && this.pinned) { this.pinned = null; this.render(); }
      this.gesture = null;
    } else if (g.kind === 'pinch') {
      if (this.pointers.size === 1) {
        var rest = Array.from(this.pointers.values())[0];
        this.gesture = { kind: 'pan', lx: rest.x, ly: rest.y, moved: true, hit: { kind: 'outside' } };
      } else this.gesture = null;
    }
  };

  Board.prototype._finishStroke = function () {
    this._cancelLongPress();
    this.cb.strokeEnd();
    this._badge(null); this.active = null; this.gesture = null;
    this.render();
  };

  Board.prototype._abortGesture = function () {
    this._cancelLongPress();
    if (this.gesture && this.gesture.kind === 'paint') this.cb.strokeEnd();
    this.gesture = null; this.active = null; this._badge(null); this.pointers.clear();
    this.render();
  };

  Board.prototype._startLongPress = function () {
    var self = this;
    this._cancelLongPress();
    this.lpTimer = setTimeout(function () {
      self.lpTimer = null;
      var g = self.gesture;
      if (!g || g.kind !== 'paint' || g.moved) return;
      var other = g.tool === 'x' ? 'fill' : 'x';
      self.cb.strokeCancel();
      if (self.cb.strokeStart(g.r * self.cols + g.c, other)) {
        g.tool = other; g.t0 = now();
        var pt = Array.from(self.pointers.values())[0];
        if (pt) self._badge(pt, 1, other);
        if (self.cb.longPressed) self.cb.longPressed(other);
        self.render();
      } else { self.gesture = null; self.active = null; self._badge(null); }
    }, 420);
  };
  Board.prototype._cancelLongPress = function () { if (this.lpTimer) { clearTimeout(this.lpTimer); this.lpTimer = null; } };

  Board.prototype._badge = function (p, count, tool) {
    if (!p || !this.opts.counter) { this.badge.hidden = true; return; }
    var t = tool || (this.gesture && this.gesture.tool) || this.tool;
    this.badge.textContent = (t === 'x' ? '✕ ' : '') + count;
    this.badge.style.left = p.x + 'px';
    this.badge.style.top = (p.y - 34) + 'px';
    this.badge.hidden = false;
  };

  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  /* ----------------------------------------------------------- render */
  Board.prototype.render = function () {
    if (this.raf) return;
    var self = this;
    this.raf = requestAnimationFrame(function () { self.raf = 0; self._draw(); });
  };

  Board.prototype._draw = function () {
    var ctx = this.ctx, C = this.colors, t = now();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg || '#000';
    ctx.fillRect(0, 0, this.vw, this.vh);
    if (!this.puzzle || !this.marks) return;

    var g = this._geom(), s = g.s, rows = this.rows, cols = this.cols, marks = this.marks;
    var r0 = clamp(Math.floor((0 - g.gridY) / s), 0, rows - 1), r1 = clamp(Math.ceil((this.vh - g.gridY) / s), 0, rows - 1);
    var c0 = clamp(Math.floor((0 - g.gridX) / s), 0, cols - 1), c1 = clamp(Math.ceil((this.vw - g.gridX) / s), 0, cols - 1);
    var r, c, x, y, i;

    // prune finished animations, find the active ones
    this.anims = this.anims.filter(function (a) { return t - a.t0 < a.dur; });
    var win = null, hint = null, lineFlash = null, mistakes = [];
    for (i = 0; i < this.anims.length; i++) {
      var a = this.anims[i];
      if (a.type === 'win') win = a; else if (a.type === 'hint') hint = a; else if (a.type === 'line') lineFlash = a; else mistakes.push(a);
    }

    // ---- line highlight (row + column of the active / hovered / pinned cell)
    var hlR = -1, hlC = -1;
    if (this.opts.highlightLine) {
      var src = this.active || this.hover;
      if (src) { hlR = src.r; hlC = src.c; }
      if (this.gesture && this.gesture.kind === 'paint' && this.gesture.axis) {
        if (this.gesture.axis === 'row') hlC = -1; else hlR = -1;
      }
    }
    if (this.pinned) { if (this.pinned.kind === 'row') hlR = this.pinned.index; else hlC = this.pinned.index; }

    // ---- cells
    var inset = s > 14 ? 1 : 0.5;
    for (r = r0; r <= r1; r++) {
      y = g.gridY + r * s;
      for (c = c0; c <= c1; c++) {
        x = g.gridX + c * s;
        var v = marks[r * cols + c];
        ctx.fillStyle = C.empty; ctx.fillRect(x, y, s, s);
        if (v === FILLED) {
          ctx.fillStyle = C.filled;
          ctx.fillRect(x + inset, y + inset, s - inset * 2, s - inset * 2);
        } else if (v === EMPTY) {
          ctx.strokeStyle = C.x; ctx.lineWidth = Math.max(1, s * 0.08); ctx.lineCap = 'round';
          var m = s * 0.3;
          ctx.beginPath(); ctx.moveTo(x + m, y + m); ctx.lineTo(x + s - m, y + s - m); ctx.moveTo(x + s - m, y + m); ctx.lineTo(x + m, y + s - m); ctx.stroke();
        }
        if (this.cb.cellFlag && this.cb.cellFlag(r * cols + c)) { ctx.fillStyle = C.mistake; ctx.fillRect(x + inset, y + inset, s - inset * 2, s - inset * 2); }
      }
    }
    // win sweep: filled cells light up along a diagonal wave
    if (win) {
      var p = (t - win.t0) / win.dur, span = rows + cols;
      for (r = r0; r <= r1; r++) for (c = c0; c <= c1; c++) {
        if (marks[r * cols + c] !== FILLED) continue;
        var d = (r + c) / span, k = p * 1.6 - d; // wave front
        if (k < 0 || k > 0.6) continue;
        ctx.globalAlpha = 0.9 * (1 - k / 0.6);
        ctx.fillStyle = C.accent; ctx.fillRect(g.gridX + c * s + inset, g.gridY + r * s + inset, s - inset * 2, s - inset * 2);
      }
      ctx.globalAlpha = 1;
    }
    // highlight
    if (hlR >= 0 || hlC >= 0) {
      ctx.fillStyle = C.hl;
      if (hlR >= 0) ctx.fillRect(g.gridX, g.gridY + hlR * s, cols * s, s);
      if (hlC >= 0) ctx.fillRect(g.gridX + hlC * s, g.gridY, s, rows * s);
    }
    if (lineFlash) {
      ctx.globalAlpha = 0.35 * (1 - (t - lineFlash.t0) / lineFlash.dur); ctx.fillStyle = C.ok;
      if (lineFlash.line.kind === 'row') ctx.fillRect(g.gridX, g.gridY + lineFlash.line.index * s, cols * s, s);
      else ctx.fillRect(g.gridX + lineFlash.line.index * s, g.gridY, s, rows * s);
      ctx.globalAlpha = 1;
    }
    if (hint) {
      var hp = (t - hint.t0) / hint.dur;
      if (hint.line) {
        ctx.globalAlpha = 0.25 * (1 - hp); ctx.fillStyle = C.hint;
        if (hint.line.kind === 'row') ctx.fillRect(g.gridX, g.gridY + hint.line.index * s, cols * s, s);
        else ctx.fillRect(g.gridX + hint.line.index * s, g.gridY, s, rows * s);
        ctx.globalAlpha = 1;
      }
      var hr = Math.floor(hint.index / cols), hc = hint.index % cols;
      var pulse = 0.5 + 0.5 * Math.sin(hp * Math.PI * 6);
      ctx.strokeStyle = C.hint; ctx.lineWidth = 2 + pulse * 2;
      ctx.strokeRect(g.gridX + hc * s + 2, g.gridY + hr * s + 2, s - 4, s - 4);
    }
    for (i = 0; i < mistakes.length; i++) {
      var ma = mistakes[i], mr = Math.floor(ma.index / cols), mc = ma.index % cols;
      ctx.globalAlpha = 1 - (t - ma.t0) / ma.dur; ctx.fillStyle = C.mistake;
      ctx.fillRect(g.gridX + mc * s, g.gridY + mr * s, s, s);
      ctx.globalAlpha = 1;
    }

    // ---- grid lines
    ctx.lineWidth = 1; ctx.strokeStyle = C.line; ctx.beginPath();
    for (c = c0; c <= c1 + 1; c++) { x = Math.round(g.gridX + c * s) + 0.5; ctx.moveTo(x, g.gridY + r0 * s); ctx.lineTo(x, g.gridY + (r1 + 1) * s); }
    for (r = r0; r <= r1 + 1; r++) { y = Math.round(g.gridY + r * s) + 0.5; ctx.moveTo(g.gridX + c0 * s, y); ctx.lineTo(g.gridX + (c1 + 1) * s, y); }
    ctx.stroke();
    ctx.lineWidth = s > 20 ? 2 : 1.5; ctx.strokeStyle = C.thick; ctx.beginPath();
    for (c = c0; c <= c1 + 1; c++) {
      if (!(c === 0 || c === cols || (this.opts.thickLines && c % 5 === 0))) continue;
      x = Math.round(g.gridX + c * s) + (ctx.lineWidth === 2 ? 0 : 0.5); ctx.moveTo(x, g.gridY); ctx.lineTo(x, g.gridY + rows * s);
    }
    for (r = r0; r <= r1 + 1; r++) {
      if (!(r === 0 || r === rows || (this.opts.thickLines && r % 5 === 0))) continue;
      y = Math.round(g.gridY + r * s) + (ctx.lineWidth === 2 ? 0 : 0.5); ctx.moveTo(g.gridX, y); ctx.lineTo(g.gridX + cols * s, y);
    }
    ctx.stroke();

    // ---- clue bands (frozen at the viewport edge when the board scrolls under them)
    var bs = g.bs, font = Math.max(8, bs * 0.46);
    ctx.font = '700 ' + font.toFixed(1) + 'px Rubik, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    // row band
    ctx.fillStyle = C.band; ctx.fillRect(g.bandX, g.gridY, g.bandW, rows * s);
    ctx.textAlign = 'right';
    for (r = r0; r <= r1; r++) {
      var cl = this.rowClues[r], status = Nonogram.clueStatus(marks, r * cols, 1, cols, cl);
      y = g.gridY + (r + 0.5) * s;
      if (hlR === r) { ctx.fillStyle = C.hl; ctx.fillRect(g.bandX, g.gridY + r * s, g.bandW, s); }
      var cx = g.bandX + g.bandW - PAD * bs * 0.5;
      if (!cl.length) { ctx.fillStyle = C.done; ctx.fillText('0', cx, y); continue; }
      for (i = cl.length - 1; i >= 0; i--) {
        var w = clueWidth(cl[i]) * bs;
        ctx.fillStyle = status[i] ? C.done : C.clue;
        ctx.fillText(String(cl[i]), cx, y + 0.5);
        cx -= w;
      }
    }
    // row band separators
    ctx.lineWidth = 1; ctx.strokeStyle = C.line; ctx.beginPath();
    for (r = r0; r <= r1 + 1; r++) { y = Math.round(g.gridY + r * s) + 0.5; ctx.moveTo(g.bandX, y); ctx.lineTo(g.bandX + g.bandW, y); }
    ctx.stroke();
    if (this.opts.thickLines) {
      ctx.lineWidth = 1.5; ctx.strokeStyle = C.thick; ctx.beginPath();
      for (r = r0; r <= r1 + 1; r++) if (r % 5 === 0 || r === rows) { y = Math.round(g.gridY + r * s) + 0.5; ctx.moveTo(g.bandX, y); ctx.lineTo(g.bandX + g.bandW, y); }
      ctx.stroke();
    }
    // column band
    ctx.fillStyle = C.band; ctx.fillRect(g.gridX, g.bandY, cols * s, g.bandH);
    ctx.textAlign = 'center';
    for (c = c0; c <= c1; c++) {
      var ccl = this.colClues[c], cst = Nonogram.clueStatus(marks, c, cols, rows, ccl);
      x = g.gridX + (c + 0.5) * s;
      if (hlC === c) { ctx.fillStyle = C.hl; ctx.fillRect(g.gridX + c * s, g.bandY, s, g.bandH); }
      var cy = g.bandY + g.bandH - PAD * bs * 0.5 - CLUE_H * bs * 0.5;
      if (!ccl.length) { ctx.fillStyle = C.done; ctx.fillText('0', x, cy); continue; }
      for (i = ccl.length - 1; i >= 0; i--) {
        ctx.fillStyle = cst[i] ? C.done : C.clue;
        ctx.fillText(String(ccl[i]), x, cy + 0.5);
        cy -= CLUE_H * bs;
      }
    }
    ctx.lineWidth = 1; ctx.strokeStyle = C.line; ctx.beginPath();
    for (c = c0; c <= c1 + 1; c++) { x = Math.round(g.gridX + c * s) + 0.5; ctx.moveTo(x, g.bandY); ctx.lineTo(x, g.bandY + g.bandH); }
    ctx.stroke();
    if (this.opts.thickLines) {
      ctx.lineWidth = 1.5; ctx.strokeStyle = C.thick; ctx.beginPath();
      for (c = c0; c <= c1 + 1; c++) if (c % 5 === 0 || c === cols) { x = Math.round(g.gridX + c * s) + 0.5; ctx.moveTo(x, g.bandY); ctx.lineTo(x, g.bandY + g.bandH); }
      ctx.stroke();
    }
    // corner
    ctx.fillStyle = C.bg; ctx.fillRect(g.bandX, g.bandY, g.bandW, g.bandH);

    if (this.anims.length) this.render();
  };

  return Board;
})();
