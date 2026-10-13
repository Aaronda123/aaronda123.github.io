// Jarvis-Gehirn als Neuronen-Ball: viele kleine leuchtende Kugeln, mit Ketten verbunden, ohne Rand.
// Federnde Physik: jede Kugel lässt sich mit dem Finger ein Stück herausziehen, das ganze Netz schwingt nach und findet
// wieder in die Ballform zurück. Impulse laufen als Kettenreaktion von Kugel zu Kugel (mehr beim Zuhören, Denken,
// Sprechen). Schnittstelle: setMode, setLevel, level, pause, grab, nudge, pick, pull, release.
// 1:1-Port von ui/neuro.js am Mac (ARCHITECTURE.md §10.2). Zusätze fürs iPhone (mit „iPhone:“ markiert):
// setPalette() für das Türkis-Thema, resize() für ein scharfes Bild (CSS-Größe × min(DPR, 2)),
// setReducedMotion() (≤ 10 Bilder/s, weniger Impulse, keine Drehung), 30 Bilder/s im Ruhezustand (Akku).
(() => {
  const PALETTE = {
    idle: [255, 34, 54], loading: [255, 34, 54], listening: [255, 118, 112],
    transcribing: [255, 64, 44], thinking: [255, 22, 34], speaking: [255, 84, 62], error: [255, 40, 140],
  };
  // iPhone: Türkis-Thema (Farben des früheren Türkis-Shaders × 255, ARCHITECTURE.md §9.6)
  const PALETTES = {
    mac: PALETTE,
    tuerkis: {
      idle: [64, 240, 224], loading: [64, 240, 224], listening: [140, 255, 240],
      transcribing: [255, 77, 92], thinking: [255, 69, 84], speaking: [115, 219, 255], error: [255, 79, 161],
    },
  };
  const ACTIVITY = { idle: 0, loading: 0.45, listening: 1, transcribing: 0.8, thinking: 0.7, speaking: 1, error: 0.6 };
  const CASCADE = { idle: 0.25, loading: 0.3, listening: 0.4, transcribing: 0.6, thinking: 0.72, speaking: 0.5, error: 0.3 };
  const N_OUT = 78; // Kugeln auf der Hülle
  const N_IN = 28; // Kugeln im Inneren
  const N = N_OUT + N_IN;
  const NEAR = 3; // Ketten pro Kugel zu den nächsten Nachbarn
  const MAX_SIG = 70;
  const IDLE_FRAME_MS = 1000 / 30; // iPhone: Ruhezustand mit 30 Bildern/s
  const REDUCED_FRAME_MS = 100; // iPhone: weniger Bewegung, höchstens 10 Bilder/s

  class Orb {
    constructor(canvas) {
      this.canvas = canvas;
      this.x = canvas.getContext('2d');
      this.mode = 'loading';
      this.level = 0;
      this.levelTarget = 0;
      this.act = 0;
      this.palette = PALETTE; // iPhone: Farbsatz je Thema
      this.col = PALETTE.loading.slice();
      this.last = 0;
      this.drawn = 0; // iPhone: Zeitpunkt des letzten gezeichneten Bilds (Bildraten-Deckel)
      this.reduced = false; // iPhone: weniger Bewegung
      this.t = 0;
      this.rot = 0;
      this.uyaw = 0;
      this.upitch = 0;
      this.spin = [0, 0];
      this.held = false;
      this.drag = null; // gezogene Kugel: {i, x, y} in Canvas-Pixeln
      // Ausgangsform: gleichmäßig auf der Hülle (Fibonacci-Kugel), dazu ein lockerer Kern
      this.home = new Float32Array(N * 3);
      this.pos = new Float32Array(N * 3);
      this.vel = new Float32Array(N * 3);
      this.size = new Float32Array(N);
      this.flash = new Float32Array(N);
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        let x, y, z;
        if (i < N_OUT) {
          y = 1 - (2 * (i + 0.5)) / N_OUT;
          const r = Math.sqrt(1 - y * y), a = i * golden;
          const k = 0.94 + Math.random() * 0.12;
          [x, y, z] = [Math.cos(a) * r * k, y * k, Math.sin(a) * r * k];
          this.size[i] = 0.85 + Math.random() * 0.45 + (i % 17 === 0 ? 0.6 : 0);
        } else {
          const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = 0.2 + Math.random() * 0.45;
          [x, y, z] = [Math.cos(a) * Math.sqrt(1 - u * u) * r, u * r, Math.sin(a) * Math.sqrt(1 - u * u) * r];
          this.size[i] = 0.7 + Math.random() * 0.35;
        }
        this.home.set([x, y, z], i * 3);
        this.pos.set([x, y, z], i * 3);
      }
      // Ketten: jede Kugel hängt an ihren nächsten Nachbarn (feste Verbindungen, Ruhelänge = Abstand)
      const seen = new Set(), ea = [], eb = [], rest = [];
      const dist = (i, j) => Math.hypot(this.home[i * 3] - this.home[j * 3], this.home[i * 3 + 1] - this.home[j * 3 + 1],
        this.home[i * 3 + 2] - this.home[j * 3 + 2]);
      for (let i = 0; i < N; i++) {
        const near = [];
        for (let j = 0; j < N; j++) if (j !== i) near.push([dist(i, j), j]);
        near.sort((a, b) => a[0] - b[0]);
        near.slice(0, i < N_OUT ? NEAR : NEAR + 1).forEach(([d, j]) => {
          const key = i < j ? `${i}-${j}` : `${j}-${i}`;
          if (seen.has(key)) return;
          seen.add(key); ea.push(i); eb.push(j); rest.push(d);
        });
      }
      this.ea = Int16Array.from(ea);
      this.eb = Int16Array.from(eb);
      this.rest = Float32Array.from(rest);
      this.adj = Array.from({ length: N }, () => []);
      ea.forEach((a, e) => { this.adj[a].push(eb[e]); this.adj[eb[e]].push(a); });
      this.p = new Float32Array(N * 3); // auf dem Bild: x, y, Tiefe 0 hinten … 1 vorne
      this.order = Array.from({ length: N }, (_, i) => i);
      this.signals = [];
      this.sprites = new Map();
      this.paused = false;
      this.running = true;
      this.resize();
      requestAnimationFrame((ts) => this.frame(ts));
    }

    pause(on) {
      this.paused = on;
      if (!on && !this.running) {
        this.running = true;
        this.last = 0; // iPhone: nach der Pause keinen Zeitsprung rechnen
        requestAnimationFrame((ts) => this.frame(ts));
      }
    }

    setMode(mode) { this.mode = PALETTE[mode] ? mode : 'idle'; }

    setLevel(level) { this.levelTarget = level; }

    // iPhone: Farbsatz je Thema („mac“ = rot wie am Mac, „tuerkis“); die Farben gleiten wie bei einem Zustandswechsel
    setPalette(name) { this.palette = PALETTES[name] || PALETTE; }

    // iPhone: Pixelgröße des Canvas = CSS-Größe × min(DPR, 2); alle Maße skalieren schon mit canvas.width / 600
    resize() {
      const css = this.canvas.clientWidth;
      if (!css) return;
      const w = Math.max(1, Math.round(css * Math.min(window.devicePixelRatio || 1, 2)));
      if (this.canvas.width !== w || this.canvas.height !== w) {
        this.canvas.width = w;
        this.canvas.height = w;
        if (this.paused || !this.running) this.draw(); // angehalten: trotzdem ein aktuelles Bild
      }
    }

    // iPhone: weniger Bewegung (≤ 10 Bilder/s, Impulse × 0,3, keine Eigendrehung)
    setReducedMotion(on) { this.reduced = !!on; }

    // ganzen Ball drehen (beim Verschieben mit dem Finger)
    grab(on) { this.held = on; if (on) this.spin = [0, 0]; }

    nudge(dx, dy) {
      this.uyaw += dx;
      this.upitch = Math.max(-1.2, Math.min(1.2, this.upitch + dy));
      this.spin = [dx, dy];
    }

    // Kugel unter dem Finger (Canvas-Pixel), vorne zuerst; -1 = keine
    pick(x, y) {
      let best = -1, bestD = 1e9;
      for (let i = 0; i < N; i++) {
        const dx = this.p[i * 3] - x, dy = this.p[i * 3 + 1] - y, d = Math.hypot(dx, dy);
        const reach = this.radius(i) * 1.6 + 8;
        const score = d - this.p[i * 3 + 2] * 6; // bei Überlappung die vordere
        if (d < reach && score < bestD) { best = i; bestD = score; }
      }
      return best;
    }

    pull(i, x, y) { this.drag = { i, x, y }; }

    release() {
      if (this.drag) this.flash[this.drag.i] = 1;
      this.drag = null;
    }

    radius(i) { return (6 + 7.5 * this.p[i * 3 + 2]) * this.size[i] * (this.canvas.width / 600); }

    frame(ts) {
      if (this.paused) { this.running = false; return; }
      requestAnimationFrame((t) => this.frame(t));
      // iPhone: Bildraten-Deckel (Ruhezustand 30/s, weniger Bewegung 10/s), sonst volle Bildrate wie am Mac
      const cap = this.reduced ? REDUCED_FRAME_MS : this.mode === 'idle' ? IDLE_FRAME_MS : 0;
      if (cap && this.drawn && ts - this.drawn < cap - 2) return;
      this.drawn = ts;
      const dt = Math.max(0, Math.min(0.05, (ts - (this.last || ts)) / 1000));
      this.last = ts;
      const ease = (a, b, k) => a + (b - a) * Math.min(1, k * dt);
      const pal = this.palette;
      this.level = ease(this.level, this.levelTarget, this.levelTarget > this.level ? 18 : 6);
      this.act = ease(this.act, ACTIVITY[this.mode] ?? 0, 3);
      this.col = this.col.map((v, i) => ease(v, (pal[this.mode] || pal.idle)[i], 4));
      if (!this.reduced) this.rot += dt * (0.1 + 0.45 * this.act);
      this.t += dt;
      if (!this.held) { // Schwung ausrollen, Neigung gleitet zurück
        this.uyaw += this.spin[0];
        this.upitch = Math.max(-1.2, Math.min(1.2, this.upitch + this.spin[1]));
        const k = Math.pow(0.05, dt);
        this.spin = [this.spin[0] * k, this.spin[1] * k];
        this.upitch *= Math.pow(0.6, dt);
      }
      this.view();
      this.physics(dt / 2);
      this.physics(dt / 2);
      this.impulses(dt);
      this.draw();
    }

    // Drehung des Balls (Gieren um y, dann Neigen um x) für Bild und Finger
    view() {
      const yaw = this.rot + this.uyaw, pitch = 0.32 + 0.1 * Math.sin(this.t * 0.27) + this.upitch;
      this.cy = Math.cos(yaw); this.sy = Math.sin(yaw); this.cp = Math.cos(pitch); this.sp = Math.sin(pitch);
    }

    physics(dt) {
      if (dt <= 0) return;
      const { pos, vel, home } = this;
      const breathe = 1 + 0.035 * Math.sin(this.t * 1.4) + 0.09 * this.level;
      const F = new Float32Array(N * 3);
      for (let i = 0; i < N * 3; i++) F[i] = (home[i] * breathe - pos[i]) * 9; // zurück in die Ballform
      for (let e = 0; e < this.ea.length; e++) { // Ketten ziehen die Nachbarn mit
        const a = this.ea[e] * 3, b = this.eb[e] * 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const len = Math.hypot(dx, dy, dz) || 1e-6;
        const f = (60 * (len - this.rest[e] * breathe)) / len;
        F[a] += f * dx; F[a + 1] += f * dy; F[a + 2] += f * dz;
        F[b] -= f * dx; F[b + 1] -= f * dy; F[b + 2] -= f * dz;
      }
      const damp = Math.exp(-5 * dt);
      for (let i = 0; i < N * 3; i++) {
        vel[i] = (vel[i] + F[i] * dt) * damp;
        pos[i] += vel[i] * dt;
      }
      if (this.drag) { // gezogene Kugel folgt dem Finger (in ihrer Tiefe), die Ketten ziehen den Rest mit
        const i = this.drag.i, W = this.canvas.width, C = W / 2, R = W * 0.31;
        const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        const Z = y * this.sp + (-x * this.sy + z * this.cy) * this.cp, f = 1 + 0.16 * Z;
        let X = (this.drag.x - C) / (R * f), Y = (this.drag.y - C) / (R * f);
        const len = Math.hypot(X, Y, Z);
        if (len > 1.35) { X *= 1.35 / len; Y *= 1.35 / len; } // nicht beliebig weit herausreißen
        // zurück ins Modell: Neigen und Gieren umkehren
        const y1 = Y * this.cp + Z * this.sp, z1 = -Y * this.sp + Z * this.cp;
        const tx = X * this.cy - z1 * this.sy, tz = X * this.sy + z1 * this.cy;
        const k = Math.min(1, 30 * dt);
        pos[i * 3] += (tx - x) * k; pos[i * 3 + 1] += (y1 - y) * k; pos[i * 3 + 2] += (tz - z) * k;
        vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0;
      }
    }

    impulses(dt) {
      for (let i = 0; i < N; i++) this.flash[i] *= Math.exp(-dt * 3);
      const rate = (0.9 + 8 * this.act + 14 * this.level) * (this.reduced ? 0.3 : 1);
      if (Math.random() < rate * dt) this.fire((Math.random() * N) | 0, -1, 3);
      const cascade = (CASCADE[this.mode] ?? 0.3) + 0.2 * this.level;
      this.signals = this.signals.filter((sg) => {
        sg.p += sg.sp * dt;
        if (sg.p < 1) return true;
        this.flash[sg.b] = 1;
        if (Math.random() < cascade) this.fire(sg.b, sg.a, 2);
        return false;
      });
    }

    fire(i, from, max) {
      this.flash[i] = 1;
      const nb = this.adj[i].filter((j) => j !== from);
      for (let k = 0; k < max && nb.length && this.signals.length < MAX_SIG; k++) {
        const j = nb.splice((Math.random() * nb.length) | 0, 1)[0];
        this.signals.push({ a: i, b: j, p: 0, sp: 1.6 + Math.random() * 1.6 });
      }
    }

    // vorgezeichnete Kugel mit Licht von oben links (pro Farbe einmal)
    ball(r, g, b) {
      const key = `b${r >> 3},${g >> 3},${b >> 3}`;
      let s = this.sprites.get(key);
      if (s) return s;
      s = document.createElement('canvas');
      s.width = s.height = 64;
      const c = s.getContext('2d');
      const gr = c.createRadialGradient(24, 22, 2, 32, 32, 30);
      gr.addColorStop(0, 'rgba(255,246,242,1)');
      gr.addColorStop(0.18, `rgb(${Math.min(255, r + 60)},${Math.min(255, g + 90)},${Math.min(255, b + 90)})`);
      gr.addColorStop(0.62, `rgb(${r},${g},${b})`);
      gr.addColorStop(1, `rgb(${r * 0.22 | 0},${g * 0.12 | 0},${b * 0.14 | 0})`);
      c.fillStyle = gr;
      c.beginPath(); c.arc(32, 32, 30, 0, Math.PI * 2); c.fill();
      this.sprites.set(key, s);
      return s;
    }

    glow(r, g, b) {
      const key = `g${r >> 3},${g >> 3},${b >> 3}`;
      let s = this.sprites.get(key);
      if (s) return s;
      s = document.createElement('canvas');
      s.width = s.height = 64;
      const c = s.getContext('2d');
      const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
      gr.addColorStop(0.35, `rgba(${r},${g},${b},0.35)`);
      gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
      c.fillStyle = gr; c.fillRect(0, 0, 64, 64);
      this.sprites.set(key, s);
      return s;
    }

    draw() {
      const { x, canvas, pos, p } = this;
      const W = canvas.width, C = W / 2, R = W * 0.31, sc = W / 600;
      if (this.cy === undefined) this.view(); // iPhone: Bild vor dem ersten Frame (resize während der Pause)
      const [r, g, b] = this.col.map(Math.round);
      for (let i = 0; i < N; i++) {
        const qx = pos[i * 3], qy = pos[i * 3 + 1], qz = pos[i * 3 + 2];
        const X = qx * this.cy + qz * this.sy, Z0 = -qx * this.sy + qz * this.cy;
        const Y = qy * this.cp - Z0 * this.sp, Z = qy * this.sp + Z0 * this.cp;
        const f = 1 + 0.16 * Z;
        p[i * 3] = C + X * R * f;
        p[i * 3 + 1] = C + Y * R * f;
        p[i * 3 + 2] = Math.max(0, Math.min(1, (Z + 1.2) / 2.4));
      }
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = 1;
      x.clearRect(0, 0, W, W);
      // nur ein Hauch Leuchten im Kern, kein Rand
      const core = x.createRadialGradient(C, C, 0, C, C, R * 1.05);
      core.addColorStop(0, `rgba(${r},${g},${b},${0.13 + 0.2 * this.level + 0.06 * this.act})`);
      core.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = core;
      x.fillRect(0, 0, W, W);
      // Ketten: dünne Linie mit kleinen Gliedern, hinten blasser
      const spr = this.glow(r, g, b);
      x.lineCap = 'round';
      for (let e = 0; e < this.ea.length; e++) {
        const i = this.ea[e], j = this.eb[e];
        const d = (p[i * 3 + 2] + p[j * 3 + 2]) / 2;
        const lit = Math.max(this.flash[i], this.flash[j]);
        const a = Math.min(1, (0.12 + 0.55 * d) * (0.75 + 0.5 * this.act) + 0.4 * lit);
        x.strokeStyle = `rgba(${r},${g},${b},${a})`;
        x.lineWidth = (0.8 + 1.4 * d) * sc;
        x.beginPath(); x.moveTo(p[i * 3], p[i * 3 + 1]); x.lineTo(p[j * 3], p[j * 3 + 1]); x.stroke();
        const gs = (4.5 + 5 * d) * sc; // Kettenglieder
        x.globalAlpha = a;
        for (const k of [0.33, 0.66]) {
          x.drawImage(spr, p[i * 3] + (p[j * 3] - p[i * 3]) * k - gs / 2, p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * k - gs / 2, gs, gs);
        }
        x.globalAlpha = 1;
      }
      // Impulse als helle Funken auf den Ketten
      x.globalCompositeOperation = 'lighter';
      for (const sg of this.signals) {
        const ax = p[sg.a * 3], ay = p[sg.a * 3 + 1], bx = p[sg.b * 3], by = p[sg.b * 3 + 1];
        const d = (p[sg.a * 3 + 2] + p[sg.b * 3 + 2]) / 2;
        const hx = ax + (bx - ax) * sg.p, hy = ay + (by - ay) * sg.p;
        const sz = (12 + 12 * d) * sc;
        x.globalAlpha = 0.5 + 0.5 * d;
        x.drawImage(this.glow(255, 200, 190), hx - sz / 2, hy - sz / 2, sz, sz);
      }
      x.globalAlpha = 1;
      x.globalCompositeOperation = 'source-over';
      // Kugeln von hinten nach vorne, feuernde leuchten auf
      this.order.sort((a2, b2) => p[a2 * 3 + 2] - p[b2 * 3 + 2]);
      const ball = this.ball(r, g, b);
      for (const i of this.order) {
        const d = p[i * 3 + 2], fl = this.flash[i] + (this.drag && this.drag.i === i ? 0.8 : 0);
        const rad = this.radius(i) * (1 + 0.35 * fl);
        if (fl > 0.05) {
          x.globalCompositeOperation = 'lighter';
          x.globalAlpha = Math.min(1, fl);
          x.drawImage(spr, p[i * 3] - rad * 2.6, p[i * 3 + 1] - rad * 2.6, rad * 5.2, rad * 5.2);
          x.globalCompositeOperation = 'source-over';
        }
        x.globalAlpha = 0.45 + 0.55 * d;
        x.drawImage(ball, p[i * 3] - rad, p[i * 3 + 1] - rad, rad * 2, rad * 2);
      }
      x.globalAlpha = 1;
    }
  }

  window.Orb = Orb;
})();
