// 3D-Modelle im Jarvis-Fenster: „zeig mir ein 3D-Modell von einem Würfel“, „zeig mir einen
// 4D-Würfel“. Eigener kleiner Renderer auf Canvas 2D, ohne Bibliothek und ohne Internet: Grundkörper, Polyeder,
// Torus, Helix/DNA, Atom, Funktionsflächen z = f(x, y), Hyperwürfel und Simplexe in 4 bis 7 Dimensionen und frei
// zusammengesetzte Modelle aus Grundkörpern (die baut Claude für „ein Haus“, „eine Rakete“ …).
// Finger: ziehen = drehen, zwei Finger = zoomen, doppelt tippen = zurück auf Anfang (Maus: Rad und Doppelklick).
// 1:1-Port von ui/model3d.js am Mac (ARCHITECTURE.md §10.3). Zusätze fürs iPhone (mit „iPhone:“ markiert): die Box
// bekommt ihre Größe vom CSS (sie deckt die Bühne ab), größer/kleiner skalieren das Bild statt der Box, Zwei-Finger-
// Zoom und Doppeltippen, Model3D.onClose statt der Mac-Nachricht, bei „weniger Bewegung“ keine Eigendrehung.
(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const box = document.getElementById('model3d');
  const canvas = document.getElementById('model3d-canvas');
  const cap = document.getElementById('model3d-cap');
  if (!box || !canvas) return;
  const ctx = canvas.getContext('2d');

  // ---------- kleine Vektorhelfer ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const num = (v, d, lo = -50, hi = 50) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const vec = (v, d) => (Array.isArray(v) ? [0, 1, 2].map((i) => num(v[i], d[i])) : d.slice());
  function rotator(deg) { // Drehung um x, dann y, dann z (Grad)
    const [ax, ay, az] = deg.map((g) => (g * Math.PI) / 180);
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)];
    return (p) => {
      let [x, y, z] = p;
      [y, z] = [y * cx - z * sx, y * sx + z * cx];
      [x, z] = [x * cy + z * sy, -x * sy + z * cy];
      [x, y] = [x * cz - y * sz, x * sz + y * cz];
      return [x, y, z];
    };
  }

  // ---------- Farben ----------
  function rgb(c) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  let accent = [255, 42, 64], accentAt = 0;
  function themeColor() {
    if (performance.now() - accentAt > 600) {
      accentAt = performance.now();
      accent = rgb(getComputedStyle(document.body).getPropertyValue('--accent')) || rgb(getComputedStyle(document.documentElement).getPropertyValue('--cyan')) || accent;
    }
    return accent;
  }
  const mix = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));
  const AMBER = [255, 184, 77];

  // ---------- Grundkörper: Listen von Flächen {p: [[x,y,z]…], c} ----------
  // jede Fläche zeigt nach außen (vom Mittelpunkt bzw. von der Rohrmitte weg), sonst stimmt das Licht nicht
  function orient(faces, center = () => [0, 0, 0]) {
    return faces.map((f) => {
      const q = f.p, n = cross(sub(q[1], q[0]), sub(q[q.length - 1], q[0]));
      const c = q.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]).map((x) => x / q.length);
      const d = sub(c, center(c));
      return n[0] * d[0] + n[1] * d[1] + n[2] * d[2] < 0 ? { ...f, p: q.slice().reverse() } : f;
    });
  }
  function quad(a, b, c, d, col) { return { p: [a, b, c, d], c: col }; }
  function boxMesh(sx, sy, sz, col) {
    const x = sx / 2, y = sy / 2, z = sz / 2;
    const v = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
    return orient([[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]
      .map((f) => ({ p: f.map((i) => v[i]), c: col })));
  }
  function sphereMesh(r, col, seg = 22, rings = 14) {
    const faces = [];
    const pt = (i, j) => {
      const th = (i / seg) * TAU, ph = (j / rings) * Math.PI;
      return [r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)];
    };
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < seg; i++) {
        const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
        faces.push(j === 0 ? { p: [a, c, d], c: col } : j === rings - 1 ? { p: [a, b, c], c: col } : quad(a, b, c, d, col));
      }
    }
    return orient(faces);
  }
  function cylinderMesh(r1, r2, h, col, seg = 26) { // r2 = 0: Kegel
    const faces = [], y0 = -h / 2, y1 = h / 2;
    const ring = (r, y) => Array.from({ length: seg }, (_, i) => [r * Math.cos((i / seg) * TAU), y, r * Math.sin((i / seg) * TAU)]);
    const lo = ring(r1, y0), hi = ring(r2, y1);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      faces.push(r2 > 0 ? quad(lo[i], lo[j], hi[j], hi[i], col) : { p: [lo[i], lo[j], [0, y1, 0]], c: col });
    }
    faces.push({ p: lo.slice().reverse(), c: col, cap: true });
    if (r2 > 0) faces.push({ p: hi, c: col, cap: true });
    return orient(faces);
  }
  function torusMesh(R, r, col, seg = 30, tube = 14) {
    const faces = [];
    const pt = (i, j) => {
      const u = (i / seg) * TAU, v = (j / tube) * TAU;
      return [(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)];
    };
    for (let i = 0; i < seg; i++) for (let j = 0; j < tube; j++) faces.push(quad(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1), col));
    return orient(faces, (c) => { const u = Math.atan2(c[2], c[0]); return [R * Math.cos(u), 0, R * Math.sin(u)]; });
  }
  function pyramidMesh(w, h, d, col) {
    const x = w / 2, z = d / 2, y0 = -h / 2, top = [0, h / 2, 0];
    const b = [[-x, y0, -z], [x, y0, -z], [x, y0, z], [-x, y0, z]];
    return orient([{ p: [b[0], b[1], top], c: col }, { p: [b[1], b[2], top], c: col }, { p: [b[2], b[3], top], c: col },
      { p: [b[3], b[0], top], c: col }, { p: b.slice().reverse(), c: col, cap: true }]);
  }
  function prismMesh(r, h, col, n = 3) { return cylinderMesh(r, r, h, col, n); }
  // Platonische Körper (Ecken auf Radius r)
  function polyMesh(kind, r, col) {
    const p = (1 + Math.sqrt(5)) / 2;
    let v, f;
    if (kind === 'tetrahedron') {
      v = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
      f = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
    } else if (kind === 'octahedron') {
      v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      f = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
    } else {
      v = [[-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p], [0, -1, -p], [0, 1, -p],
        [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1]];
      f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
        [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
      if (kind === 'dodecahedron') { // Dual des Ikosaeders: je Ecke ein Fünfeck aus den Mittelpunkten der Nachbarflächen
        const cen = f.map((t) => [0, 1, 2].map((k) => (v[t[0]][k] + v[t[1]][k] + v[t[2]][k]) / 3));
        const nf = v.map((vert, vi) => {
          const ids = f.map((t, i) => (t.includes(vi) ? i : -1)).filter((i) => i >= 0);
          const n = norm(vert), ref = norm(sub(cen[ids[0]], vert)), ref2 = cross(n, ref);
          return ids.map((i) => { const d = sub(cen[i], vert); return [i, Math.atan2(d[0] * ref2[0] + d[1] * ref2[1] + d[2] * ref2[2], d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2])]; })
            .sort((a, b) => a[1] - b[1]).map((x) => x[0]);
        });
        v = cen; f = nf;
      }
    }
    v = v.map((x) => { const n = norm(x); return [n[0] * r, n[1] * r, n[2] * r]; });
    return orient(f.map((t) => ({ p: t.map((i) => v[i]), c: col })));
  }
  function surfaceMesh(fn, range, col) {
    const N = 34, faces = [], zs = [];
    for (let i = 0; i <= N; i++) {
      zs.push([]);
      for (let j = 0; j <= N; j++) {
        let z = fn(-range + (2 * range * i) / N, -range + (2 * range * j) / N);
        if (!Number.isFinite(z)) z = 0;
        zs[i].push(Math.max(-1e6, Math.min(1e6, z)));
      }
    }
    const flat = zs.flat(), lo = Math.min(...flat), hi = Math.max(...flat), mid = (lo + hi) / 2, span = Math.max(hi - lo, 1e-9);
    const P = (i, j) => [-1 + (2 * i) / N, ((zs[i][j] - mid) / span) * (hi - lo > 1e-9 ? 1.1 : 0), -1 + (2 * j) / N];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const t = ((zs[i][j] + zs[i + 1][j + 1]) / 2 - lo) / span;
        faces.push({ ...quad(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), col ? col : mix(themeColor(), AMBER, t)), two: true });
      }
    }
    return faces;
  }

  // ---------- Formeln für Flächen: kleiner, sicherer Parser (kein eval) ----------
  const FUNCS = { sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: (x) => Math.sqrt(Math.abs(x)), abs: Math.abs,
    exp: (x) => Math.exp(Math.min(x, 50)), log: (x) => Math.log(Math.abs(x) || 1e-9), ln: (x) => Math.log(Math.abs(x) || 1e-9),
    atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, floor: Math.floor, round: Math.round };
  function parseFormula(src) {
    const toks = [];
    const re = /\s*(\d+(?:\.\d+)?|\.\d+|[a-z]+|[-+*/^(),])/gy;
    const s = String(src).toLowerCase().replace(/,/g, '.').replace(/²/g, '^2').replace(/³/g, '^3').replace(/·|×/g, '*')
      .replace(/\*\*/g, '^').replace(/^\s*(?:f\s*\(\s*x\s*[,.;]\s*y\s*\)|z)\s*=\s*/, '').trim();
    let m;
    while (re.lastIndex < s.length && (m = re.exec(s))) {
      if (/^[xyr]{2,}$/.test(m[1])) m[1].split('').forEach((c, k) => toks.push(...(k ? ['*', c] : [c]))); // „xy“ = x·y
      else toks.push(m[1]);
    }
    if (re.lastIndex < s.length || toks.length > 160) throw new Error('Formel');
    let i = 0;
    const peek = () => toks[i], take = () => toks[i++];
    const expr = () => {
      let a = term();
      while (peek() === '+' || peek() === '-') { const op = take(), b = term(), l = a; a = op === '+' ? (x, y) => l(x, y) + b(x, y) : (x, y) => l(x, y) - b(x, y); }
      return a;
    };
    const term = () => {
      let a = unary();
      for (;;) {
        const t = peek();
        if (t === '*' || t === '/') { take(); const b = unary(), l = a; a = t === '*' ? (x, y) => l(x, y) * b(x, y) : (x, y) => l(x, y) / b(x, y); }
        else if (t !== undefined && (/^[\d.a-z(]/.test(t))) { const b = unary(), l = a; a = (x, y) => l(x, y) * b(x, y); } // 2x, 3sin(x)
        else return a;
      }
    };
    const unary = () => {
      if (peek() === '-') { take(); const a = unary(); return (x, y) => -a(x, y); }
      if (peek() === '+') { take(); return unary(); }
      return power();
    };
    const power = () => {
      const a = primary();
      if (peek() === '^') { take(); const b = unary(); return (x, y) => Math.pow(a(x, y), b(x, y)); }
      return a;
    };
    const primary = () => {
      const t = take();
      if (t === undefined) throw new Error('Formel');
      if (/^[\d.]/.test(t)) { const v = parseFloat(t); return () => v; }
      if (t === '(') { const a = expr(); if (take() !== ')') throw new Error('Formel'); return a; }
      if (t === 'x') return (x) => x;
      if (t === 'y') return (x, y) => y;
      if (t === 'r') return (x, y) => Math.hypot(x, y);
      if (t === 'pi') return () => Math.PI;
      if (t === 'e') return () => Math.E;
      if (FUNCS[t]) {
        const f = FUNCS[t];
        if (take() !== '(') throw new Error('Formel');
        const a = expr();
        if (take() !== ')') throw new Error('Formel');
        return (x, y) => f(a(x, y));
      }
      throw new Error('Formel');
    };
    const fn = expr();
    if (i !== toks.length) throw new Error('Formel');
    return fn;
  }

  // ---------- n-dimensionale Drahtmodelle (Hyperwürfel, Simplex) ----------
  function ndShape(kind, n, spec = {}) {
    let verts = [], edges = [], dots = true;
    const ring = (pts) => { const o = verts.length; verts.push(...pts); pts.forEach((_, i) => edges.push([o + i, o + ((i + 1) % pts.length)])); };
    if (kind === 'orthoplex') { // Kreuzpolytop: 4D = 16-Zeller (alle Ecken verbunden außer den Gegenüberliegenden)
      for (let k = 0; k < n; k++) for (const sg of [1, -1]) verts.push(Array.from({ length: n }, (_, j) => (j === k ? sg * 1.3 : 0)));
      for (let i = 0; i < verts.length; i++) for (let j = i + 1; j < verts.length; j++) if ((i >> 1) !== (j >> 1)) edges.push([i, j]);
    } else if (kind === 'cell24') { // 24-Zeller: alle Vertauschungen von (±1, ±1, 0, 0)
      n = 4;
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) for (const sa of [1, -1]) for (const sb of [1, -1]) {
        const v = [0, 0, 0, 0]; v[a] = sa; v[b] = sb; verts.push(v);
      }
      for (let i = 0; i < 24; i++) for (let j = i + 1; j < 24; j++) {
        if (Math.abs(verts[i].reduce((s, x, k) => s + (x - verts[j][k]) ** 2, 0) - 2) < 1e-9) edges.push([i, j]);
      }
    } else if (kind === 'hypersphere') { // 4D-Kugel: Hopf-Fasern, ineinanderliegende Tori aus Großkreisen
      n = 4; dots = false;
      for (const eta of [0.32, 0.785, 1.25]) for (let c = 0; c < 8; c++) {
        const off = (c / 8) * TAU;
        ring(Array.from({ length: 40 }, (_, i) => { const x = (i / 40) * TAU; return [Math.cos(eta) * Math.cos(x), Math.cos(eta) * Math.sin(x), Math.sin(eta) * Math.cos(x + off), Math.sin(eta) * Math.sin(x + off)].map((v) => v * 1.3); }));
      }
    } else if (kind === 'clifford') { // 4D-Torus (Clifford-Torus): (cos a, sin a, cos b, sin b)
      n = 4; dots = false;
      const P = (a, b) => [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)].map((v) => v * 0.92);
      for (let i = 0; i < 16; i++) ring(Array.from({ length: 36 }, (_, j) => P((i / 16) * TAU, (j / 36) * TAU)));
      for (let j = 0; j < 16; j++) ring(Array.from({ length: 36 }, (_, i) => P((i / 36) * TAU, (j / 16) * TAU)));
    } else if (kind === 'nd') { // eigenes n-dimensionales Drahtmodell (von Claude: Ecken und Kanten)
      const vs = (Array.isArray(spec.vertices) ? spec.vertices : []).slice(0, 256).map((v) => Array.from({ length: n }, (_, j) => num(Array.isArray(v) ? v[j] : 0, 0)));
      const c = Array.from({ length: n }, (_, j) => vs.reduce((s, v) => s + v[j], 0) / Math.max(1, vs.length));
      const R = Math.max(1e-9, ...vs.map((v) => Math.hypot(...v.map((x, j) => x - c[j]))));
      verts = vs.map((v) => v.map((x, j) => ((x - c[j]) / R) * 1.3));
      edges = (Array.isArray(spec.edges) ? spec.edges : []).slice(0, 1000)
        .map((e) => (Array.isArray(e) ? [Math.round(num(e[0], -1, -1, 1e4)), Math.round(num(e[1], -1, -1, 1e4))] : [-1, -1]))
        .filter(([a, b]) => a >= 0 && b >= 0 && a < verts.length && b < verts.length && a !== b);
      if (!verts.length) return ndShape('hypercube', n);
      dots = verts.length <= 120;
    } else if (kind === 'hypercube') {
      for (let i = 0; i < 1 << n; i++) verts.push(Array.from({ length: n }, (_, k) => ((i >> k) & 1 ? 1 : -1)));
      for (let i = 0; i < verts.length; i++) for (let k = 0; k < n; k++) { const j = i ^ (1 << k); if (j > i) edges.push([i, j]); }
    } else { // regelmäßiger Simplex: Einheitsvektoren + ein Punkt auf der Diagonalen, dann zentriert
      const a = (1 - Math.sqrt(n + 1)) / n;
      for (let k = 0; k < n; k++) verts.push(Array.from({ length: n }, (_, j) => (j === k ? 1 : 0)));
      verts.push(Array(n).fill(a));
      const c = Array.from({ length: n }, (_, j) => verts.reduce((s, v) => s + v[j], 0) / verts.length);
      verts = verts.map((v) => v.map((x, j) => x - c[j]));
      const r = Math.max(...verts.map((v) => Math.hypot(...v)));
      verts = verts.map((v) => v.map((x) => (x / r) * 1.3));
      for (let i = 0; i < verts.length; i++) for (let j = i + 1; j < verts.length; j++) edges.push([i, j]);
    }
    const planes = [];
    for (let k = 3; k < n; k++) planes.push([0, k, 0.45 + 0.13 * k], [1, k, 0.27 + 0.07 * k], [2, k, 0.18 + 0.05 * k]);
    // perspektivisch Dimension für Dimension herunter auf 3D; je Schritt auf den größten Abstand bezogen, damit auch
    // 6D/7D nicht explodieren
    const project = (t) => {
      const vs = verts.map((v0) => {
        const v = v0.slice();
        for (const [a, b, sp] of planes) { const ang = t * sp, c = Math.cos(ang), s = Math.sin(ang); [v[a], v[b]] = [v[a] * c - v[b] * s, v[a] * s + v[b] * c]; }
        return v;
      });
      const ws = vs.map(() => 0);
      for (let d = n - 1; d >= 3; d--) {
        const M = Math.max(...vs.map((v) => Math.hypot(...v.slice(0, d + 1))), 1e-9);
        vs.forEach((v, i) => {
          const f = 1 / (1 + 0.32 * (v[d] / M));
          if (d === n - 1) ws[i] = v[d] / M;
          for (let j = 0; j < d; j++) v[j] = (v[j] / M) * f;
        });
      }
      return vs.map((v, i) => ({ p: [v[0], v[1], v[2]], w: ws[i] }));
    };
    const scale = 0.84;
    const wmax = 1;
    return (t) => {
      const pts = project(t);
      const P = pts.map((q) => [q.p[0] * scale, q.p[1] * scale, q.p[2] * scale]);
      return { faces: [], lines: edges.map(([i, j]) => ({ p: [P[i], P[j]], a: 0.35 + 0.65 * (1 - ((pts[i].w + pts[j].w) / 2 + wmax) / (2 * wmax)) })),
        points: dots ? P.map((p, i) => ({ p, r: 2.6, a: 0.45 + 0.55 * (1 - (pts[i].w + wmax) / (2 * wmax)) })) : [] };
    };
  }
  function atomShape() {
    const orbits = [[0, 0, 0], [62, 0, 30], [-62, 0, -30]].map((d) => rotator(d));
    const nucleus = [];
    [[0.07, 0.05, 0], [-0.07, 0.03, 0.04], [0, -0.07, 0.03], [0.03, 0.02, -0.08], [-0.04, -0.04, -0.05], [0.05, -0.03, 0.07]]
      .forEach((p, i) => sphereMesh(0.1, i % 2 ? [120, 190, 255] : null, 10, 7).forEach((f) => nucleus.push({ p: f.p.map((q) => [q[0] + p[0], q[1] + p[1], q[2] + p[2]]), c: f.c })));
    return (t) => {
      const lines = [], points = [];
      orbits.forEach((rot, k) => {
        const ring = Array.from({ length: 64 }, (_, i) => rot([Math.cos((i / 64) * TAU), 0, 0.62 * Math.sin((i / 64) * TAU)]));
        ring.forEach((p, i) => lines.push({ p: [p, ring[(i + 1) % 64]], a: 0.45 }));
        const u = t * (1.4 + 0.35 * k) + k * 2;
        points.push({ p: rot([Math.cos(u), 0, 0.62 * Math.sin(u)]), r: 4.2, a: 1 });
      });
      return { faces: nucleus, lines, points };
    };
  }
  function helixShape(dna) {
    const lines = [], points = [], steps = 64, turns = 2.6;
    const strand = (off) => Array.from({ length: steps + 1 }, (_, i) => {
      const a = (i / steps) * turns * TAU + off;
      return [0.42 * Math.cos(a), -1 + (2 * i) / steps, 0.42 * Math.sin(a)];
    });
    const s1 = strand(0), s2 = dna ? strand(Math.PI) : null;
    for (let i = 0; i < steps; i++) {
      lines.push({ p: [s1[i], s1[i + 1]], a: 1, w: 2.2 });
      if (s2) lines.push({ p: [s2[i], s2[i + 1]], a: 1, w: 2.2, c: [120, 190, 255] });
      if (s2 && i % 3 === 0) {
        const m = [(s1[i][0] + s2[i][0]) / 2, s1[i][1], (s1[i][2] + s2[i][2]) / 2];
        lines.push({ p: [s1[i], m], a: 0.7, c: AMBER }, { p: [m, s2[i]], a: 0.7, c: [92, 255, 182] });
      }
      if (i % 3 === 0) { points.push({ p: s1[i], r: 3.2, a: 0.9 }); if (s2) points.push({ p: s2[i], r: 3.2, a: 0.9, c: [120, 190, 255] }); }
    }
    return { faces: [], lines, points };
  }

  // ---------- Modell aus der Nachricht bauen ----------
  const NAMES = { cube: 'Würfel', box: 'Quader', sphere: 'Kugel', globe: 'Globus', cylinder: 'Zylinder', cone: 'Kegel',
    pyramid: 'Pyramide', prism: 'Prisma', tetrahedron: 'Tetraeder', octahedron: 'Oktaeder', dodecahedron: 'Dodekaeder',
    icosahedron: 'Ikosaeder', torus: 'Torus', helix: 'Helix', dna: 'DNA-Doppelhelix', atom: 'Atom' };
  function partMesh(pt) {
    const col = rgb(pt.color);
    const s = String(pt.shape || pt.type || 'box').toLowerCase();
    const size = vec(pt.size, [1, 1, 1]).map((x) => Math.max(0.01, Math.abs(x)));
    const r = Math.max(0.01, Math.abs(num(pt.r ?? pt.radius, 0.5)));
    const h = Math.max(0.01, Math.abs(num(pt.h ?? pt.height, 1)));
    let faces;
    if (s === 'line') {
      return { faces: [], lines: [{ p: [vec(pt.from, [0, 0, 0]), vec(pt.to, [0, 1, 0])], a: 1, c: col, w: num(pt.width, 2, 0.5, 8) }] };
    }
    if (s === 'sphere' || s === 'kugel' || s === 'ball') faces = sphereMesh(r, col, 16, 10);
    else if (s === 'cylinder' || s === 'zylinder') faces = cylinderMesh(r, r, h, col);
    else if (s === 'cone' || s === 'kegel') faces = cylinderMesh(r, 0, h, col);
    else if (s === 'torus' || s === 'ring') {
      const ringR = Math.max(0.01, Math.abs(num(pt.r ?? pt.R ?? pt.ring, 0.7)));
      faces = torusMesh(ringR, Math.max(0.005, Math.abs(num(pt.tube, ringR * 0.3, 0.001, 20))), col, 22, 10);
    }
    else if (s === 'pyramid' || s === 'pyramide') faces = pyramidMesh(size[0], size[1], size[2], col);
    else if (s === 'prism' || s === 'prisma') faces = prismMesh(r, h, col, Math.round(num(pt.sides, 3, 3, 12)));
    else if (['tetrahedron', 'octahedron', 'icosahedron', 'dodecahedron'].includes(s)) faces = polyMesh(s, r, col);
    else faces = boxMesh(size[0], size[1], size[2], col);
    const rv = pt.rot ?? pt.rotation;
    const rot = rotator(Array.isArray(rv) ? [0, 1, 2].map((i) => num(rv[i], 0, -720, 720)) : [0, 0, 0]);
    const pos = vec(pt.pos ?? pt.position, [0, 0, 0]);
    return { faces: faces.map((f) => ({ ...f, p: f.p.map((q) => { const v = rot(q); return [v[0] + pos[0], v[1] + pos[1], v[2] + pos[2]]; }) })) };
  }
  function fitStatic(geo) { // in die Mitte und auf Radius ~1
    const all = [...geo.faces.flatMap((f) => f.p), ...(geo.lines || []).flatMap((l) => l.p), ...(geo.points || []).map((q) => q.p)];
    if (!all.length) return geo;
    const lo = [0, 1, 2].map((k) => Math.min(...all.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])));
    const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    const R = Math.max(...all.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])), 1e-6);
    const T = (p) => [(p[0] - c[0]) / R, (p[1] - c[1]) / R, (p[2] - c[2]) / R];
    return { faces: geo.faces.map((f) => ({ ...f, p: f.p.map(T) })), lines: (geo.lines || []).map((l) => ({ ...l, p: l.p.map(T) })),
      points: (geo.points || []).map((q) => ({ ...q, p: T(q.p) })) };
  }
  function build(m) {
    const shape = String(m.shape || '').toLowerCase();
    const col = rgb(m.color);
    const dims = Math.round(num(m.dims, 4, 4, 7));
    if (['hypercube', 'simplex', 'orthoplex', 'cell24', 'hypersphere', 'clifford', 'nd'].includes(shape)) {
      const d = ['cell24', 'hypersphere', 'clifford'].includes(shape) ? 4 : dims;
      const name = m.title || {
        hypercube: d === 4 ? 'Tesserakt' : d === 5 ? 'Penterakt' : 'Hyperwürfel', simplex: d === 4 ? 'Pentachoron' : 'Simplex',
        orthoplex: d === 4 ? '16-Zeller' : 'Kreuzpolytop', cell24: '24-Zeller', hypersphere: 'Hyperkugel', clifford: 'Clifford-Torus',
        nd: 'Modell' }[shape];
      return { dyn: ndShape(shape, d, m), label: `${d}D · ${name}` };
    }
    if (shape === 'atom') return { dyn: atomShape(), label: '3D · Atom' };
    if (shape === 'helix' || shape === 'dna') return { geo: helixShape(shape === 'dna'), label: `3D · ${NAMES[shape]}` };
    if (shape === 'surface' || m.formula) {
      let fn, used = String(m.formula || 'sin(x)*cos(y)');
      try { fn = parseFormula(used); } catch { used = 'sin(x)*cos(y)'; fn = parseFormula(used); }
      const range = num(m.range, 3, 0.1, 50);
      used = used.replace(/^\s*(?:f\s*\(\s*x\s*[,.;]\s*y\s*\)|z)\s*=\s*/i, '');
      return { geo: fitStatic({ faces: surfaceMesh(fn, range, col) }), label: `3D · z = ${used.slice(0, 40)}` };
    }
    if (Array.isArray(m.parts) && m.parts.length) {
      const geo = { faces: [], lines: [] };
      m.parts.slice(0, 80).forEach((pt) => { if (pt && typeof pt === 'object') { const g = partMesh(pt); geo.faces.push(...g.faces); geo.lines.push(...(g.lines || [])); } });
      return { geo: fitStatic(geo), label: `3D · ${m.title || 'Modell'}` };
    }
    const faces = {
      cube: () => boxMesh(1, 1, 1, col), box: () => boxMesh(1.6, 0.9, 1, col), sphere: () => sphereMesh(1, col), globe: () => sphereMesh(1, col, 24, 16),
      cylinder: () => cylinderMesh(0.6, 0.6, 1.5, col), cone: () => cylinderMesh(0.7, 0, 1.5, col), pyramid: () => pyramidMesh(1.4, 1.2, 1.4, col),
      prism: () => prismMesh(0.75, 1.4, col, 3), torus: () => torusMesh(0.75, 0.3, col),
      tetrahedron: () => polyMesh('tetrahedron', 1, col), octahedron: () => polyMesh('octahedron', 1, col),
      dodecahedron: () => polyMesh('dodecahedron', 1, col), icosahedron: () => polyMesh('icosahedron', 1, col),
    }[shape] || (() => boxMesh(1, 1, 1, col));
    return { geo: fitStatic({ faces: faces() }), label: `3D · ${m.title || NAMES[shape] || 'Würfel'}` };
  }


  // ---------- Ansicht, Finger/Maus und Zeichnen ----------
  const DEFAULT_VIEW = { yaw: -0.6, pitch: -0.42, zoom: 1 };
  let model = null, view = { ...DEFAULT_VIEW }, spin = 0.45, spinOn = true, scale = 1;
  let drag = null, vel = [0, 0], idleUntil = 0, raf = 0, t0 = performance.now(), last = t0;
  // iPhone: Finger auf dem Canvas (für zwei Finger = Zoom) und letztes Loslassen (für Doppeltippen)
  const touches = new Map();
  let pinch = null, lastUp = null;
  // iPhone: „weniger Bewegung“ (Systemeinstellung oder html.reduced) → keine Eigendrehung
  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reducedMotion = () => document.documentElement.classList.contains('reduced') || !!(motionQuery && motionQuery.matches);

  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  const LIGHT = norm([-0.45, 0.75, -0.6]);
  function draw(now) {
    raf = 0;
    if (!model) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!drag && !pinch) {
      if (Math.abs(vel[0]) + Math.abs(vel[1]) > 1e-4) { // Schwung nach dem Loslassen
        view.yaw += vel[0]; view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch + vel[1]));
        vel = vel.map((v) => v * 0.92);
      } else if (spinOn && now > idleUntil && !reducedMotion()) view.yaw += spin * dt;
    }
    if (!document.hidden) render((now - t0) / 1000);
    raf = requestAnimationFrame(draw);
  }
  function render(t) {
    resize();
    const W = canvas.width, H = canvas.height, base = themeColor();
    ctx.clearRect(0, 0, W, H);
    const geo = model.dyn ? model.dyn(t) : model.geo;
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    // iPhone: „größer“/„kleiner“ (scale) vergrößern das Bild, die Box bleibt so groß wie die Bühne
    const cam = 3.4, f = Math.min(W, H) * 0.35 * cam * view.zoom * scale, ox = W / 2, oy = H * 0.47;
    const T = (p) => { // Modell → Kamera (y nach oben)
      const x1 = p[0] * cy + p[2] * sy, z1 = -p[0] * sy + p[2] * cy;
      const y2 = p[1] * cp - z1 * sp, z2 = p[1] * sp + z1 * cp;
      return [x1, y2, z2 + cam];
    };
    const S = (q) => [ox + (q[0] * f) / q[2], oy - (q[1] * f) / q[2]];
    // Sockel: leuchtender Ring unter dem Modell
    const ringY = -1.02, ring = [];
    for (let i = 0; i <= 48; i++) ring.push(S(T([0.95 * Math.cos((i / 48) * TAU), ringY, 0.95 * Math.sin((i / 48) * TAU)])));
    ctx.beginPath(); ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = `rgba(${base},.28)`; ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1); ctx.stroke();
    const items = [];
    for (const fc of geo.faces) {
      const q = fc.p.map(T);
      if (q.some((v) => v[2] < 0.15)) continue;
      const n = norm(cross(sub(q[1], q[0]), sub(q[q.length - 1], q[0])));
      const c = q.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]).map((x) => x / q.length);
      const facing = fc.two || n[0] * c[0] + n[1] * c[1] + n[2] * c[2] < 0; // zur Kamera hin
      const dl = n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2];
      const lam = fc.two ? Math.abs(dl) * 0.8 + 0.2 : 0.25 + 0.75 * Math.max(0, dl);
      items.push({ z: c[2], k: 0, s: q.map(S), col: fc.c || base, facing, lam, many: geo.faces.length > 260 });
    }
    for (const l of geo.lines || []) {
      const a = T(l.p[0]), b = T(l.p[1]);
      if (a[2] < 0.15 || b[2] < 0.15) continue;
      items.push({ z: (a[2] + b[2]) / 2, k: 1, s: [S(a), S(b)], col: l.c || base, a: l.a ?? 1, w: l.w || 1.6 });
    }
    for (const p of geo.points || []) {
      const q = T(p.p);
      if (q[2] < 0.15) continue;
      items.push({ z: q[2], k: 2, s: [S(q)], col: p.c || base, a: p.a ?? 1, r: (p.r || 3) * (cam / q[2]) });
    }
    items.sort((a, b) => b.z - a.z);
    const dpr = window.devicePixelRatio || 1;
    ctx.lineJoin = 'round';
    for (const it of items) {
      const [r, g, b] = it.col;
      if (it.k === 0) {
        ctx.beginPath();
        it.s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = `rgba(${r},${g},${b},${it.facing ? 0.1 + 0.42 * it.lam : 0.05})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${Math.min(255, r + 60)},${Math.min(255, g + 60)},${Math.min(255, b + 60)},${it.facing ? (it.many ? 0.45 : 0.85) : 0.16})`;
        ctx.lineWidth = (it.facing ? 1.3 : 0.8) * dpr;
        ctx.stroke();
      } else if (it.k === 1) {
        ctx.beginPath(); ctx.moveTo(...it.s[0]); ctx.lineTo(...it.s[1]);
        ctx.strokeStyle = `rgba(${r},${g},${b},${it.a})`; ctx.lineWidth = it.w * dpr; ctx.stroke();
      } else {
        const [x, y] = it.s[0];
        const gr = ctx.createRadialGradient(x, y, 0, x, y, it.r * 2.4 * dpr);
        gr.addColorStop(0, `rgba(255,255,255,${it.a})`); gr.addColorStop(0.35, `rgba(${r},${g},${b},${it.a})`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, it.r * 2.4 * dpr, 0, TAU); ctx.fill();
      }
    }
  }
  function kick() { if (!raf && model) { last = performance.now(); raf = requestAnimationFrame(draw); } }

  // ziehen: drehen; zwei Finger (oder Mausrad): zoomen; doppelt tippen (oder Doppelklick): zurück
  const spread = () => { const [a, b] = [...touches.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
  canvas.addEventListener('pointerdown', (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* egal */ }
    box.classList.add('grab');
    if (touches.size >= 2) { // iPhone: zweiter Finger → Zoom statt Drehen
      pinch = { d0: spread(), z0: view.zoom };
      drag = null; vel = [0, 0];
      return;
    }
    drag = { x: e.clientX, y: e.clientY }; vel = [0, 0];
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && touches.size >= 2) {
      view.zoom = Math.max(0.4, Math.min(3, pinch.z0 * (spread() / pinch.d0)));
      idleUntil = performance.now() + 2500;
      return;
    }
    if (!drag) return;
    const dx = (e.clientX - drag.x) * 0.0085, dy = (e.clientY - drag.y) * 0.0085;
    drag = { x: e.clientX, y: e.clientY };
    view.yaw -= dx; view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch - dy));
    vel = [-dx, -dy];
  });
  const release = (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* egal */ }
    if (touches.size === 1) { // iPhone: vom Zoom zurück zum Drehen mit dem verbliebenen Finger
      const [p] = [...touches.values()];
      pinch = null; drag = { x: p.x, y: p.y }; vel = [0, 0];
      return;
    }
    if (touches.size) return;
    const wasPinch = !!pinch;
    pinch = null; drag = null; idleUntil = performance.now() + 3500; box.classList.remove('grab');
    // iPhone: zweimal kurz hintereinander an derselben Stelle getippt = Doppelklick am Mac (zurück auf Anfang)
    const now = performance.now();
    if (e.type === 'pointerup' && !wasPinch && e.pointerType !== 'mouse') {
      if (lastUp && now - lastUp.t < 300 && Math.hypot(e.clientX - lastUp.x, e.clientY - lastUp.y) < 20) {
        view = { ...DEFAULT_VIEW }; vel = [0, 0]; lastUp = null;
      } else lastUp = { t: now, x: e.clientX, y: e.clientY };
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = Math.max(0.4, Math.min(3, view.zoom * Math.exp(-e.deltaY * 0.0012))); idleUntil = performance.now() + 2500; }, { passive: false });
  canvas.addEventListener('dblclick', () => { view = { ...DEFAULT_VIEW }; vel = [0, 0]; });
  // iPhone: ✕ meldet sich über Model3D.onClose (am Mac: Nachricht „model_closed“ ans Backend)
  document.getElementById('model3d-close')?.addEventListener('click', () => {
    hide();
    try { window.Model3D.onClose?.(); } catch (err) { console.error('3D-Modell', err); }
  });

  // iPhone: die Box hat ihre Größe vom CSS (deckt die Bühne ab); hier nur fürs nächste Bild neu messen
  function applySize() { if (model) kick(); }
  window.addEventListener('resize', () => { if (model) applySize(); });
  function show(m) {
    m = m && typeof m === 'object' ? m : {};
    let built;
    try { built = build(m || {}); } catch (e) { console.error('3D-Modell', e); built = build({ shape: 'cube' }); }
    model = built;
    view = { ...DEFAULT_VIEW }; vel = [0, 0]; spinOn = true; spin = 0.45; idleUntil = 0;
    touches.clear(); pinch = null; drag = null; lastUp = null;
    if (!m.keep) scale = 1;
    applySize();
    cap.textContent = String(built.label || '3D').toUpperCase();
    box.classList.add('show');
    document.body.classList.add('model-open');
    t0 = performance.now();
    kick();
  }
  function hide() {
    model = null;
    touches.clear(); pinch = null; drag = null;
    box.classList.remove('show', 'grab');
    document.body.classList.remove('model-open');
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  // per Stimme: größer, kleiner, schneller, langsamer, anhalten, weiterdrehen, nach links/rechts/oben/unten, zurück
  function adjust(op) {
    if (!model) return;
    if (op === 'bigger' || op === 'smaller') { scale = Math.max(0.55, Math.min(2.2, scale * (op === 'bigger' ? 1.25 : 0.8))); applySize(); }
    else if (op === 'faster') { spinOn = true; spin = Math.min(4, (spin || 0.45) * 1.7); }
    else if (op === 'slower') { spin = Math.max(0.08, spin / 1.7); }
    else if (op === 'stop') spinOn = false;
    else if (op === 'spin') { spinOn = true; spin = spin || 0.45; idleUntil = 0; }
    else if (op === 'left' || op === 'right') { view.yaw += op === 'left' ? 0.6 : -0.6; idleUntil = performance.now() + 3000; }
    else if (op === 'up' || op === 'down') { view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch + (op === 'up' ? 0.45 : -0.45))); idleUntil = performance.now() + 3000; }
    else if (op === 'reset') { view = { ...DEFAULT_VIEW }; scale = 1; applySize(); spinOn = true; spin = 0.45; }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  window.Model3D = { show, hide, adjust, isOpen: () => !!model,
    onClose: null, // iPhone: wird von hud.js gesetzt, ✕ ruft es nach dem Ausblenden auf
    _test: { parseFormula, build, boxMesh, sphereMesh, cylinderMesh, torusMesh, pyramidMesh, polyMesh, ndShape, render: (t) => render(t) } };
})();
