// Jarvis-Gehirn als Neuronen-Ball: viele kleine leuchtende Kugeln, mit Ketten verbunden, ohne Rand.
// Federnde Physik: jede Kugel lässt sich ein Stück herausziehen, das ganze Netz schwingt nach und findet wieder in die
// Form zurück. Impulse laufen als Kettenreaktion von Kugel zu Kugel (mehr beim Zuhören, Denken, Sprechen).
// Formen wie am Mac (Stand 13.10. abends): „ringe“ (Standard: Gyroskop aus Kern, innerem Ring und fünf gekippten
// Ringen, durch die 4. Dimension gedreht), „kern“, „galaxie“, „netz“, „schalen“. Langziehen (stretchTo) und Aufziehen
// (unfold) machen daraus eine lila-blaue Milchstraße mit drei Spiralarmen; dabei setzt das Gehirn die CSS-Variable
// --galaxy (0 … 1), die die schwache Milchstraße im Hintergrund (.milkyway) heller macht. resetForm() holt die
// Ursprungsform zurück.
// Schnittstelle: setMode, setLevel, level, pause, grab, nudge, pick, pull, release, setShape, shape, stretchState,
// stretchTo, stretchSave, unfold, resetForm, openAmount.
// 1:1-Port von ui/neuro.js am Mac (ARCHITECTURE.md §10.2). Zusätze fürs Handy (mit „Handy:“ markiert):
// setPalette() für das Türkis-Thema, resize() für ein scharfes Bild (CSS-Größe × min(DPR, 1,5)), setReducedMotion()
// (≤ 10 Bilder/s, weniger Impulse, keine Eigendrehung), 30 Bilder/s im Ruhezustand (Akku), Form und Aufzug in einem
// eigenen Speicher-Schlüssel (jarvis.v2.orbform), wiederverwendete Puffer statt neuer Arrays in jedem Bild.
(() => {
  const PALETTE = {
    idle: [255, 34, 54], loading: [255, 34, 54], listening: [255, 118, 112],
    transcribing: [255, 64, 44], thinking: [255, 22, 34], speaking: [255, 84, 62], error: [255, 40, 140],
  };
  // Handy: Türkis-Thema (Farben des früheren Türkis-Shaders × 255, ARCHITECTURE.md §9.6)
  const PALETTES = {
    mac: PALETTE,
    tuerkis: {
      idle: [64, 240, 224], loading: [64, 240, 224], listening: [140, 255, 240],
      transcribing: [255, 77, 92], thinking: [255, 69, 84], speaking: [115, 219, 255], error: [255, 79, 161],
    },
  };
  const ACTIVITY = { idle: 0, loading: 0.45, listening: 1, transcribing: 0.8, thinking: 0.7, speaking: 1, error: 0.6 };
  const CASCADE = { idle: 0.25, loading: 0.3, listening: 0.4, transcribing: 0.6, thinking: 0.72, speaking: 0.5, error: 0.3 };
  const N_OUT = 150; // Kugeln auf der Hülle (Ringe-Form: mehr, dafür kleiner)
  const N_IN = 50; // Kugeln im Inneren
  const N = N_OUT + N_IN;
  const NEAR = 3; // Ketten pro Kugel zu den nächsten Nachbarn
  const MAX_SIG = 70;
  const SHAPES = ['ringe', 'kern', 'galaxie', 'netz', 'schalen'];
  const GALAXY_RGB = [150, 135, 255]; // aufgezogen: lila-blau
  const IDLE_FRAME_MS = 1000 / 30; // Handy: Ruhezustand mit 30 Bildern/s
  const REDUCED_FRAME_MS = 100; // Handy: weniger Bewegung, höchstens 10 Bilder/s
  const DPR_MAX = 1.5; // Handy: das Canvas ist 1,5 × so groß wie die Bühne (Platz zum Aufziehen), darum 1,5 statt 2
  const STORE_KEY = 'jarvis.v2.orbform'; // Handy: { shape, sk, sdx, sdy, spread } (store.KEYS.orbForm, „alles löschen“)

  function loadForm() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return v && typeof v === 'object' ? v : {};
    } catch { return {}; }
  }

  class Orb {
    constructor(canvas) {
      this.canvas = canvas;
      this.x = canvas.getContext('2d');
      this.mode = 'loading';
      this.level = 0;
      this.levelTarget = 0;
      this.act = 0;
      this.palette = PALETTE; // Handy: Farbsatz je Thema
      this.col = PALETTE.loading.slice();
      this.last = 0;
      this.drawn = 0; // Handy: Zeitpunkt des letzten gezeichneten Bilds (Bildraten-Deckel)
      this.reduced = false; // Handy: weniger Bewegung
      this.t = 0;
      this.rot = 0;
      this.uyaw = 0;
      this.upitch = 0;
      this.spin = [0, 0];
      this.held = false;
      this.drag = null; // gezogene Kugel: {i, x, y} in Canvas-Pixeln
      this.home = new Float32Array(N * 3);
      this.pos = new Float32Array(N * 3);
      this.vel = new Float32Array(N * 3);
      this.size = new Float32Array(N);
      this.flash = new Float32Array(N);
      this.F = new Float32Array(N * 3); // Handy: Kräfte, wiederverwendet
      this.prev = new Float32Array(N * 3); // Handy: Ringe-Ziele des letzten Bilds, wiederverwendet
      // 4D: jede Kugel hat eine vierte Koordinate; das Netz atmet in Wellen durch die 4. Dimension
      this.w4 = Float32Array.from({ length: N }, () => Math.random() * 2 - 1);
      this.ph4 = Float32Array.from({ length: N }, () => Math.random() * Math.PI * 2);
      // Sternenstaub: ein loser kosmischer Schleier um das Gehirn
      this.dust = Array.from({ length: 150 }, () => {
        const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, rr = 1.15 + Math.random() * 0.45;
        return { p: [Math.cos(a) * Math.sqrt(1 - u * u) * rr, u * rr * 0.75, Math.sin(a) * Math.sqrt(1 - u * u) * rr],
          s: 0.4 + Math.random() * 1.2, tw: Math.random() * 6.28, sp: 0.03 + Math.random() * 0.08 };
      });
      this.spread = 1; this.spreadNow = 1; // „aufziehen“ (Mausrad am Mac)
      this.sk = 1; this.skNow = 1; this.sdx = 1; this.sdy = 0; // Langziehen in eine Richtung (Milchstraße)
      this.openNow = 0;
      const f = loadForm();
      const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
      this.sk = num(f.sk, 1, 1, 3.2);
      this.spread = num(f.spread, 1, 0.6, 2.1);
      const dl = Math.hypot(Number(f.sdx) || 0, Number(f.sdy) || 0);
      if (dl > 0.01) { this.sdx = f.sdx / dl; this.sdy = f.sdy / dl; }
      this.build(SHAPES.includes(f.shape) ? f.shape : 'ringe');
      this.p = new Float32Array(N * 3); // auf dem Bild: x, y, Tiefe 0 hinten … 1 vorne
      this.order = Array.from({ length: N }, (_, i) => i);
      this.signals = [];
      this.sprites = new Map();
      this.paused = false;
      this.running = true;
      this.resize();
      requestAnimationFrame((ts) => this.frame(ts));
    }

    // Formen: ringe (Gyroskop), kern (Neutron mit Strahlen), galaxie, netz, schalen (4D)
    build(shape) {
      this.shape = SHAPES.includes(shape) ? shape : 'ringe';
      this.ring = null;
      const H = this.home, rnd = (a, b) => a + Math.random() * (b - a);
      const sph = (r) => { const u = rnd(-1, 1), a = rnd(0, 6.283), q = Math.sqrt(1 - u * u); return [Math.cos(a) * q * r, u * r, Math.sin(a) * q * r]; };
      const edges = [];
      const golden = Math.PI * (3 - Math.sqrt(5));
      if (this.shape === 'ringe') { // Gyroskop: Kern, innerer Ring, Außenringe, die sich umeinander drehen; alles wird
        // zusätzlich durch die 4. Dimension gedreht und perspektivisch zurückprojiziert
        const N_CORE = 22, per = [26, 30, 34, 38, 28, N - N_CORE - 156];
        this.ring = new Int8Array(N); this.rang = new Float32Array(N); this.coreP = new Float32Array(N * 3);
        let i = 0;
        for (; i < N_CORE; i++) { this.ring[i] = -1; this.coreP.set(sph(rnd(0.03, 0.16)), i * 3); this.size[i] = rnd(0.7, 1.0); }
        per.forEach((n, r) => {
          const first = i;
          for (let k = 0; k < n; k++, i++) {
            this.ring[i] = r; this.rang[i] = (k / n) * 6.2832; this.size[i] = r === 0 ? rnd(0.5, 0.7) : rnd(0.38, 0.62) + (k % 8 === 0 ? 0.25 : 0);
            edges.push([i, k + 1 < n ? i + 1 : first]); // Ring schließen
            if (r === 0 && k % 5 === 0) edges.push([i, (k / 5) % N_CORE]); // Speichen zum Kern
          }
        });
        for (let a = 0; a < N_CORE; a++) for (let b = a + 1; b < N_CORE; b++) if (Math.random() < 0.3) edges.push([a, b]);
        this.ringHome(0);
      } else if (this.shape === 'kern') { // dichter Kern, davon verzweigte Strahlen mit einzelnen Punkten nach außen
        for (let i = 0; i < N; i++) {
          const core = i < 14, r = core ? rnd(0.02, 0.17) : Math.pow(rnd(0.12, 1), 0.8) * 1.05;
          H.set(sph(r), i * 3);
          this.size[i] = core ? rnd(1.3, 1.9) : rnd(0.45, 1.0) + (i % 13 === 0 ? 0.5 : 0);
        }
        const rad = (i) => Math.hypot(H[i * 3], H[i * 3 + 1], H[i * 3 + 2]);
        const order = [...Array(N).keys()].sort((a, b) => rad(a) - rad(b));
        for (let k = 1; k < N; k++) { // jeder Punkt hängt am nächsten, der näher am Kern liegt: ein Baum aus Strahlen
          const i = order[k]; let best = order[0], bd = 1e9;
          for (let m = 0; m < k; m++) {
            const j = order[m];
            const d = Math.hypot(H[i * 3] - H[j * 3], H[i * 3 + 1] - H[j * 3 + 1], H[i * 3 + 2] - H[j * 3 + 2]);
            if (d < bd) { bd = d; best = j; }
          }
          edges.push([i, best]);
        }
        for (let i = 0; i < 14; i++) for (let j = i + 1; j < 14; j++) if (Math.random() < 0.35) edges.push([i, j]);
      } else if (this.shape === 'galaxie') { // Kern und zwei Spiralarme in einer flachen Scheibe
        for (let i = 0; i < N; i++) {
          if (i < 12) { H.set(sph(rnd(0.03, 0.16)), i * 3); this.size[i] = rnd(1.2, 1.7); continue; }
          const arm = i % 2, k = (i - 12) / (N - 12), ang = arm * Math.PI + k * 4.2 + rnd(-0.12, 0.12), r = 0.18 + k * 0.85;
          const gx = Math.cos(ang) * r, gy = rnd(-0.06, 0.06) * (1 - k * 0.5), gz = Math.sin(ang) * r, tl = 1.0; // Scheibe gekippt
          H.set([gx, gy * Math.cos(tl) - gz * Math.sin(tl), gy * Math.sin(tl) + gz * Math.cos(tl)], i * 3);
          this.size[i] = rnd(0.5, 1.05);
        }
        for (let i = 12; i + 2 < N; i++) edges.push([i, i + 2]); // entlang der Arme
        for (let a2 = 0; a2 < 2; a2++) edges.push([12 + a2, a2]);
        for (let i = 0; i < 12; i++) edges.push([i, (i + 1) % 12]);
      } else if (this.shape === 'schalen') { // drei ineinander liegende Schalen, wie Ebenen einer 4D-Welt
        const shells = [0.32, 0.64, 1.0], per = [18, 34, N - 52];
        let i = 0;
        shells.forEach((r, s2) => {
          for (let k = 0; k < per[s2]; k++, i++) {
            const y = 1 - (2 * (k + 0.5)) / per[s2], q = Math.sqrt(1 - y * y), a = k * golden + s2;
            H.set([Math.cos(a) * q * r, y * r, Math.sin(a) * q * r], i * 3); this.size[i] = 1.25 - s2 * 0.25 + rnd(0, 0.2);
          }
        });
      } else { // netz: die bisherige Kugel
        for (let i = 0; i < N; i++) {
          if (i < N_OUT) {
            const y = 1 - (2 * (i + 0.5)) / N_OUT, q = Math.sqrt(1 - y * y), a = i * golden, k = rnd(0.94, 1.06);
            H.set([Math.cos(a) * q * k, y * k, Math.sin(a) * q * k], i * 3); this.size[i] = rnd(0.85, 1.3) + (i % 17 === 0 ? 0.6 : 0);
          } else { H.set(sph(rnd(0.2, 0.65)), i * 3); this.size[i] = rnd(0.7, 1.05); }
        }
      }
      if (!edges.length) { // nächste Nachbarn verketten
        const seen = new Set();
        for (let i = 0; i < N; i++) {
          const near = [];
          for (let j = 0; j < N; j++) if (j !== i) near.push([Math.hypot(H[i * 3] - H[j * 3], H[i * 3 + 1] - H[j * 3 + 1], H[i * 3 + 2] - H[j * 3 + 2]), j]);
          near.sort((a, b) => a[0] - b[0]);
          near.slice(0, NEAR).forEach(([, j]) => { const key = i < j ? i + '-' + j : j + '-' + i; if (!seen.has(key)) { seen.add(key); edges.push([i, j]); } });
        }
      }
      if (!this.pos.some((v) => v)) this.pos.set(H);
      // aufgezogen wird daraus eine Milchstraße: drei Spiralarme in einer leicht gekippten Scheibe
      this.gal = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const k = i / N, arm = i % 3, ang = arm * 2.094 + k * 5.2 + rnd(-0.25, 0.25), r = 0.08 + Math.pow(k, 0.8) * 1.15;
        const gx = Math.cos(ang) * r, gy = rnd(-0.05, 0.05), gz = Math.sin(ang) * r, tl = 0.55;
        this.gal.set([gx, gy * Math.cos(tl) - gz * Math.sin(tl), gy * Math.sin(tl) + gz * Math.cos(tl)], i * 3);
      }
      this.edges = edges;
      this.ea = Int16Array.from(edges.map((e) => e[0]));
      this.eb = Int16Array.from(edges.map((e) => e[1]));
      this.rest = Float32Array.from(edges.map(([i, j]) => Math.hypot(H[i * 3] - H[j * 3], H[i * 3 + 1] - H[j * 3 + 1], H[i * 3 + 2] - H[j * 3 + 2])));
      this.adj = Array.from({ length: N }, () => []);
      edges.forEach(([a2, b2]) => { this.adj[a2].push(b2); this.adj[b2].push(a2); });
      this.signals = [];
      this.drag = null;
    }

    // Ringe-Form: Zielpositionen zum Zeitpunkt t (Ringe kreisen, kippen umeinander, 4D-Drehung in der x-w-Ebene)
    ringHome(t) {
      const H = this.home, R = [ // Radius, Kippung um x, um z, Drehtempo, Kipptempo, Lage in der 4. Dimension
        [0.42, 0.0, 0.0, 0.9, 0.0, 0.0], [0.86, 1.15, 0.25, -0.45, 0.13, 0.12],
        [0.98, 0.35, 1.25, 0.32, -0.09, -0.12], [1.1, 1.57, -0.7, -0.22, 0.07, 0.2], [1.28, 0.2, 0.1, 0.12, 0.03, -0.06],
        [0.62, 0.8, -1.0, 0.7, -0.15, 0.08]];
      const a4 = t * 0.21, c4 = Math.cos(a4), s4 = Math.sin(a4), cs = Math.cos(t * 0.5), ss = Math.sin(t * 0.5);
      for (let i = 0; i < N; i++) {
        let x, y, z, w;
        if (this.ring[i] < 0) { // Kern dreht sich langsam in sich
          const px = this.coreP[i * 3], pz = this.coreP[i * 3 + 2];
          x = px * cs - pz * ss; y = this.coreP[i * 3 + 1]; z = px * ss + pz * cs; w = 0;
        } else {
          const [r, tx0, tz0, sp, tsp, w0] = R[this.ring[i]], a = this.rang[i] + t * sp;
          const tx = tx0 + t * tsp, tz = tz0 + t * tsp * 0.7;
          x = Math.cos(a) * r; y = 0; z = Math.sin(a) * r; w = w0 + 0.12 * Math.sin(2 * a);
          const y1 = y * Math.cos(tx) - z * Math.sin(tx), z1 = y * Math.sin(tx) + z * Math.cos(tx); // kippen um x
          const x2 = x * Math.cos(tz) - y1 * Math.sin(tz), y2 = x * Math.sin(tz) + y1 * Math.cos(tz); // kippen um z
          x = x2; y = y2; z = z1;
        }
        const xr = x * (0.8 + 0.2 * c4) - w * s4, wr = x * s4 * 0.5 + w * c4, f = 2.2 / (2.2 - wr * 0.5); // sanft durch 4D drehen und projizieren
        H[i * 3] = xr * f; H[i * 3 + 1] = y * f; H[i * 3 + 2] = z * f;
      }
      if (this.rest && this.edges && this.rest.length === this.edges.length) {
        const E = this.edges;
        for (let e = 0; e < E.length; e++) {
          const i = E[e][0], j = E[e][1];
          this.rest[e] = Math.hypot(H[i * 3] - H[j * 3], H[i * 3 + 1] - H[j * 3 + 1], H[i * 3 + 2] - H[j * 3 + 2]);
        }
      }
    }

    // Langziehen in eine Richtung (Bildschirm-Pixel vom Startpunkt): stretch = Richtung + Faktor, spread wächst mit
    stretchState() { return { k: this.sk, dx: this.sdx, dy: this.sdy, spread: this.spread }; }

    stretchTo(px, py, st) {
      const d = Math.hypot(px, py);
      if (d < 4) return;
      this.sdx = px / d; this.sdy = py / d;
      this.sk = Math.max(1, Math.min(3.2, (st ? st.k : 1) + d / 220));
      this.spread = Math.max(0.6, Math.min(2.1, (st ? st.spread : 1) + d / 600));
    }

    resetForm() { this.sk = 1; this.spread = 1; this.stretchSave(); } // Doppelklick/Doppeltippen: Ursprungsform

    stretchSave() { this.saveForm(); }

    // Handy: Form, Richtung, Langziehen und Aufziehen in einem Schlüssel
    saveForm() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ shape: this.shape, sk: Math.round(this.sk * 1000) / 1000,
          sdx: Math.round(this.sdx * 1000) / 1000, sdy: Math.round(this.sdy * 1000) / 1000,
          spread: Math.round(this.spread * 1000) / 1000 }));
      } catch { /* egal */ }
    }

    setShape(shape) {
      this.build(shape);
      this.saveForm();
      if (this.paused || !this.running) this.draw(); // Handy: angehalten trotzdem die neue Form zeigen
      return this.shape;
    }

    // Mausrad / Handy-Wischen: kosmisch auseinander- oder zusammenziehen
    unfold(f) {
      this.spread = Math.max(0.6, Math.min(2.1, this.spread * f));
      if (f < 1) this.sk = Math.max(1, this.sk * f);
      this.saveForm();
    }

    // Handy: wie weit das Gehirn gerade zur Milchstraße aufgezogen ist (0 … 1), für Tests und die Anzeige
    openAmount() {
      return Math.min(1, Math.max(0, (this.sk - 1) / 1.2 + (this.spread - 1) / 0.8));
    }

    pause(on) {
      this.paused = on;
      if (!on && !this.running) {
        this.running = true;
        this.last = 0; // Handy: nach der Pause keinen Zeitsprung rechnen
        requestAnimationFrame((ts) => this.frame(ts));
      }
    }

    setMode(mode) { this.mode = PALETTE[mode] ? mode : 'idle'; }

    setLevel(level) { this.levelTarget = level; }

    // Handy: Farbsatz je Thema („mac“ = rot wie am Mac, „tuerkis“); die Farben gleiten wie bei einem Zustandswechsel
    setPalette(name) { this.palette = PALETTES[name] || PALETTE; }

    // Handy: Pixelgröße des Canvas = CSS-Größe × min(DPR, 1,5); alle Maße skalieren mit canvas.width / 900
    resize() {
      const css = this.canvas.clientWidth;
      if (!css) return;
      const w = Math.max(1, Math.min(1400, Math.round(css * Math.min(window.devicePixelRatio || 1, DPR_MAX))));
      if (this.canvas.width !== w || this.canvas.height !== w) {
        this.canvas.width = w;
        this.canvas.height = w;
        this.milky = null;
        if (this.paused || !this.running) this.draw(); // angehalten: trotzdem ein aktuelles Bild
      }
    }

    // Handy: weniger Bewegung (≤ 10 Bilder/s, Impulse × 0,3, keine Eigendrehung, Ringe langsam)
    setReducedMotion(on) { this.reduced = !!on; }

    // ganzen Ball drehen (beim Verschieben)
    grab(on) { this.held = on; if (on) this.spin = [0, 0]; }

    nudge(dx, dy) {
      this.uyaw += dx;
      this.upitch = Math.max(-1.2, Math.min(1.2, this.upitch + dy));
      this.spin = [dx, dy];
    }

    // Kugel unter dem Zeiger (Canvas-Pixel), vorne zuerst; -1 = keine. Handy: extra = größere Trefferfläche (Finger)
    pick(x, y, extra = 0) {
      let best = -1, bestD = 1e9;
      for (let i = 0; i < N; i++) {
        const dx = this.p[i * 3] - x, dy = this.p[i * 3 + 1] - y, d = Math.hypot(dx, dy);
        const reach = this.radius(i) * 1.6 + 8 * (this.canvas.width / 900) + (Number(extra) || 0);
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

    radius(i) { return (3.4 + 4.2 * this.p[i * 3 + 2]) * this.size[i] * (1 - 0.62 * (this.openNow || 0)) * (this.canvas.width / 900); }

    frame(ts) {
      if (this.paused) { this.running = false; return; }
      requestAnimationFrame((t) => this.frame(t));
      // Handy: Bildraten-Deckel (Ruhezustand 30/s, weniger Bewegung 10/s), sonst volle Bildrate wie am Mac;
      // beim Ziehen und Aufziehen immer volle Bildrate
      const busy = this.held || this.drag || Math.abs(this.openNow - this.openAmount()) > 0.01;
      const cap = this.reduced ? REDUCED_FRAME_MS : this.mode === 'idle' && !busy ? IDLE_FRAME_MS : 0;
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
      this.spreadNow += (this.spread - this.spreadNow) * Math.min(1, 4 * dt);
      this.skNow += (this.sk - this.skNow) * Math.min(1, 5 * dt);
      const openT = this.openAmount();
      this.openNow = (this.openNow || 0) + (openT - (this.openNow || 0)) * Math.min(1, 2 * dt);
      this.view();
      this.rt = (this.rt || 0) + dt * (0.6 + 0.8 * this.act) * (this.reduced ? 0.3 : 1); // Ringe drehen beim Sprechen schneller
      if (this.ring) { // Kugeln fahren mit ihren Ringen mit; die Federn regeln nur noch Abweichungen (Ziehen, Atmen)
        const prev = this.prev, m = this.spreadNow * (1 - (this.openNow || 0));
        prev.set(this.home);
        this.ringHome(this.rt);
        for (let i = 0; i < N * 3; i++) this.pos[i] += (this.home[i] - prev[i]) * m;
      }
      this.physics(dt / 2);
      this.physics(dt / 2);
      this.impulses(dt);
      this.draw();
    }

    // Drehung des Balls (Gieren um y, dann Neigen um x) für Bild und Zeiger
    view() {
      const yaw = this.rot + this.uyaw, pitch = 0.32 + 0.1 * Math.sin(this.t * 0.27) + this.upitch;
      this.cy = Math.cos(yaw); this.sy = Math.sin(yaw); this.cp = Math.cos(pitch); this.sp = Math.sin(pitch);
    }

    physics(dt) {
      if (dt <= 0) return;
      const { pos, vel, home } = this;
      const breathe = 1 + 0.035 * Math.sin(this.t * 1.4) + 0.09 * this.level;
      const F = this.F;
      const op = this.openNow || 0, gal = this.gal;
      for (let i = 0; i < N; i++) { // Ballform, die in 4D-Wellen atmet; aufgezogen wird es zur Milchstraße
        const w = this.w4[i] * Math.cos(this.t * 0.35) + Math.sin(this.t * 0.27 + this.ph4[i]) * 0.6;
        const k = breathe * (1 + (this.ring ? 0.03 : 0.16) * w * (1 - op)) * this.spreadNow;
        for (let d = 0; d < 3; d++) F[i * 3 + d] = ((home[i * 3 + d] * (1 - op) + gal[i * 3 + d] * op) * k - pos[i * 3 + d]) * 9;
      }
      for (let e = 0; e < this.ea.length; e++) { // Ketten ziehen die Nachbarn mit
        const a = this.ea[e] * 3, b = this.eb[e] * 3;
        const dx = pos[b] - pos[a], dy = pos[b + 1] - pos[a + 1], dz = pos[b + 2] - pos[a + 2];
        const len = Math.hypot(dx, dy, dz) || 1e-6;
        const f = (60 * (1 - 0.95 * op) * (len - this.rest[e] * breathe * this.spreadNow)) / len;
        F[a] += f * dx; F[a + 1] += f * dy; F[a + 2] += f * dz;
        F[b] -= f * dx; F[b + 1] -= f * dy; F[b + 2] -= f * dz;
      }
      const damp = Math.exp(-5 * dt);
      for (let i = 0; i < N * 3; i++) {
        vel[i] = (vel[i] + F[i] * dt) * damp;
        pos[i] += vel[i] * dt;
      }
      if (this.drag) { // gezogene Kugel folgt dem Zeiger (in ihrer Tiefe), die Ketten ziehen den Rest mit
        const i = this.drag.i, W = this.canvas.width, C = W / 2, R = W * 0.2;
        const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        const Z = y * this.sp + (-x * this.sy + z * this.cy) * this.cp, f = 1 + 0.16 * Z;
        let X = (this.drag.x - C) / (R * f), Y = (this.drag.y - C) / (R * f);
        const len = Math.hypot(X, Y, Z);
        if (len > 2.1) { X *= 2.1 / len; Y *= 2.1 / len; } // nicht beliebig weit herausreißen
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
      gr.addColorStop(0, `rgba(${Math.min(255, r + 110)},${Math.min(255, g + 150)},${Math.min(255, b + 140)},1)`);
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

    // einmal vorzeichnen: Nebelband und feine Sterne der Milchstraße (900 × 380 wie am Mac)
    milkyway() {
      const m = document.createElement('canvas'); m.width = 900; m.height = 380;
      const g = m.getContext('2d');
      for (let k = 0; k < 7; k++) {
        const gx = 450 + (Math.random() - 0.5) * 520, gy = 190 + (Math.random() - 0.5) * 90, gr = 120 + Math.random() * 160;
        const rg = g.createRadialGradient(gx, gy, 0, gx, gy, gr);
        const neb = [[120, 70, 230], [70, 90, 240], [160, 80, 220], [90, 120, 255], [140, 100, 240], [60, 70, 200], [180, 150, 255]][k];
        rg.addColorStop(0, `rgba(${neb[0]},${neb[1]},${neb[2]},0.9)`); rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg; g.fillRect(0, 0, 900, 380);
      }
      for (let k = 0; k < 900; k++) {
        const sy = 190 + (Math.random() + Math.random() + Math.random() - 1.5) * 120;
        const wv = 190 + Math.random() * 65 | 0;
        g.fillStyle = `rgba(${wv},${wv},255,${0.3 + Math.random() * 0.7})`;
        g.fillRect(Math.random() * 900, sy, Math.random() < 0.08 ? 2 : 1, Math.random() < 0.08 ? 2 : 1);
      }
      return m;
    }

    draw() {
      const { x, canvas, pos, p } = this;
      const W = canvas.width, C = W / 2, R = W * 0.2, sc = W / 900;
      if (this.cy === undefined) this.view(); // Handy: Bild vor dem ersten Frame (resize während der Pause)
      const op0 = this.openNow || 0;
      const mix = (c, t) => c.map((v, k) => Math.round(v + (t[k] - v) * op0));
      const [r, g, b] = mix(this.col, GALAXY_RGB); // Kugeln/Linien: aufgezogen lila-blau
      const [sr, sg2, sb] = mix([255, 120, 110], [200, 205, 255]); // Funken: bläulich weiß
      if (Math.abs((this._gv ?? -1) - op0) > 0.02 || (op0 < 0.02 && this._gv > 0)) { // Hintergrund mitfärben
        this._gv = op0 < 0.02 ? 0 : op0;
        document.documentElement.style.setProperty('--galaxy', this._gv.toFixed(2));
      }
      for (let i = 0; i < N; i++) {
        const qx = pos[i * 3], qy = pos[i * 3 + 1], qz = pos[i * 3 + 2];
        const X = qx * this.cy + qz * this.sy, Z0 = -qx * this.sy + qz * this.cy;
        const Y = qy * this.cp - Z0 * this.sp, Z = qy * this.sp + Z0 * this.cp;
        const f = 1 + 0.16 * Z;
        const dot = (X * this.sdx + Y * this.sdy) * (this.skNow - 1);
        p[i * 3] = C + (X + this.sdx * dot) * R * f;
        p[i * 3 + 1] = C + (Y + this.sdy * dot) * R * f;
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
      // aufgezogen: ganz schwach eine Milchstraße dahinter (ca. 5 % Helligkeit), entlang der Zugrichtung
      const open = Math.min(1, Math.max(0, (this.skNow - 1) / 1.2 + (this.spreadNow - 1) / 0.8));
      if (open > 0.02) {
        if (!this.milky) this.milky = this.milkyway();
        x.save();
        x.translate(C, C);
        x.rotate(Math.atan2(this.sdy, this.sdx) + this.t * 0.01);
        x.globalAlpha = Math.min(1, 0.05 * open * 2.2 + 0.3 * op0); // aufgezogen: richtige Milchstraße
        x.globalCompositeOperation = 'lighter';
        x.drawImage(this.milky, -W * 0.5 * (0.7 + 0.3 * this.skNow / 3.2), -W * 0.21, W * (0.7 + 0.3 * this.skNow / 3.2), W * 0.42);
        x.restore();
        x.globalAlpha = 1; x.globalCompositeOperation = 'source-over';
      }
      // Sternenstaub, dreht langsam gegen das Gehirn
      for (const d of this.dust) {
        const a = this.t * d.sp, ca = Math.cos(a), sa = Math.sin(a);
        const sp2 = this.spreadNow, qx = (d.p[0] * ca - d.p[2] * sa) * sp2, qz = (d.p[0] * sa + d.p[2] * ca) * sp2, qy = d.p[1] * sp2;
        const X = qx * this.cy + qz * this.sy, Z0 = -qx * this.sy + qz * this.cy;
        const Y = qy * this.cp - Z0 * this.sp, Z = qy * this.sp + Z0 * this.cp;
        const f = 1 + 0.16 * Z, tw = 0.35 + 0.35 * Math.sin(this.t * 2 + d.tw);
        x.fillStyle = `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)},${tw * (0.35 + 0.3 * (Z + 1.6) / 3.2)})`;
        const dot = (X * this.sdx + Y * this.sdy) * (this.skNow - 1);
        x.beginPath(); x.arc(C + (X + this.sdx * dot) * R * f, C + (Y + this.sdy * dot) * R * f, d.s * sc, 0, 6.29); x.fill();
      }
      // Ketten: dünne Linie mit kleinen Gliedern, hinten blasser
      const spr = this.glow(r, g, b);
      x.lineCap = 'round';
      const fade = 1 - 0.9 * op0, thin = 1 - 0.6 * op0, link = 1 - 0.7 * op0;
      for (let e = 0; e < this.ea.length; e++) {
        const i = this.ea[e], j = this.eb[e];
        const d = (p[i * 3 + 2] + p[j * 3 + 2]) / 2;
        const lit = Math.max(this.flash[i], this.flash[j]);
        const a = Math.min(1, (0.12 + 0.55 * d) * (0.75 + 0.5 * this.act) + 0.4 * lit) * fade; // Milchstraße: alte Ketten verblassen
        x.strokeStyle = `rgba(${r},${g},${b},${a})`;
        x.lineWidth = (0.8 + 1.4 * d) * sc * thin;
        x.beginPath(); x.moveTo(p[i * 3], p[i * 3 + 1]); x.lineTo(p[j * 3], p[j * 3 + 1]); x.stroke();
        const gs = (2.8 + 3 * d) * sc * link; // Kettenglieder
        x.globalAlpha = a;
        for (const k of [0.33, 0.66]) {
          x.drawImage(spr, p[i * 3] + (p[j * 3] - p[i * 3]) * k - gs / 2, p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * k - gs / 2, gs, gs);
        }
        x.globalAlpha = 1;
      }
      // Milchstraße: feine Linien entlang der Spiralarme (jede dritte Kugel liegt auf demselben Arm)
      if (op0 > 0.05) {
        x.lineWidth = 0.7 * sc;
        for (let i = 0; i + 3 < N; i++) {
          const j = i + 3, d = (p[i * 3 + 2] + p[j * 3 + 2]) / 2;
          x.strokeStyle = `rgba(${r},${g},${b},${0.35 * op0 * (0.4 + 0.6 * d)})`;
          x.beginPath(); x.moveTo(p[i * 3], p[i * 3 + 1]); x.lineTo(p[j * 3], p[j * 3 + 1]); x.stroke();
        }
      }
      // Impulse als helle Funken auf den Ketten
      x.globalCompositeOperation = 'lighter';
      const sparks = this.glow(sr, sg2, sb);
      for (const sg of this.signals) {
        const ax = p[sg.a * 3], ay = p[sg.a * 3 + 1], bx = p[sg.b * 3], by = p[sg.b * 3 + 1];
        const d = (p[sg.a * 3 + 2] + p[sg.b * 3 + 2]) / 2;
        const hx = ax + (bx - ax) * sg.p, hy = ay + (by - ay) * sg.p;
        const sz = (12 + 12 * d) * sc;
        x.globalAlpha = 0.5 + 0.5 * d;
        x.drawImage(sparks, hx - sz / 2, hy - sz / 2, sz, sz);
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

  Orb.SHAPES = SHAPES.slice();
  window.Orb = Orb;
})();
