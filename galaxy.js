// Kosmischer Hintergrund: Milchstraße mit Sternenband, Staubbahnen und rötlichen Nebeln, einmal vorgezeichnet.
// Darüber funkeln ein paar Sterne und ab und zu zieht eine Sternschnuppe vorbei.
// Ausgeblendet wird nichts gezeichnet; die langsame Drehung des Sternenbilds macht die Grafikkarte (CSS).
// 1:1-Port von ui/galaxy.js am Mac (ARCHITECTURE.md §10.1). Zusätze fürs iPhone (mit „iPhone:“ markiert):
// Pixelgröße × min(DPR, 2) mit ctx.scale (sonst unscharf), neu zeichnen bei orientationchange,
// setReducedMotion() (keine Sternschnuppen, Funkeln einmal gezeichnet, keine Animationsschleife).
(() => {
  const host = document.getElementById('galaxy');
  if (!host) return;
  const base = document.getElementById('gx-stars');
  const live = document.getElementById('gx-live');
  const lx = live.getContext('2d');
  const rnd = (a, b) => a + Math.random() * (b - a);
  const gauss = () => {
    let u = 0;
    while (!u) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  };
  const STAR = ['255,255,255', '255,246,236', '255,228,214', '222,232,255', '255,210,196'];
  let W = 0;
  let H = 0;
  let twinkles = [];
  let shot = null;
  let nextShot = 0;
  let paused = false;
  let running = false;
  let last = 0;
  let reduced = false; // iPhone: weniger Bewegung
  const ratio = () => Math.min(window.devicePixelRatio || 1, 2); // iPhone: scharfes Bild

  // Leuchtpunkt einmal vorzeichnen (für helle und funkelnde Sterne)
  const glow = document.createElement('canvas');
  glow.width = glow.height = 32;
  (() => {
    const g = glow.getContext('2d');
    const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, 'rgba(255,240,235,.8)');
    gr.addColorStop(0.45, 'rgba(255,170,160,.18)');
    gr.addColorStop(1, 'rgba(255,170,160,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 32, 32);
  })();

  // weicher, gedrehter Fleck (Glühen, Nebel oder Staub)
  function blob(g, x, y, rx, ry, angle, color, alpha) {
    g.save();
    g.translate(x, y);
    g.rotate(angle);
    g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, `rgba(${color},${alpha})`);
    gr.addColorStop(1, `rgba(${color},0)`);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, rx, 0, 6.29);
    g.fill();
    g.restore();
  }

  // Milchstraße: diagonales Band aus Sternen, Glühen, dunklen Staubbahnen und ein paar Nebeln
  function render() {
    W = host.clientWidth;
    H = host.clientHeight;
    if (!W || !H) return;
    const BW = Math.round(W * 1.2); // Reserve für die langsame Drehung (siehe CSS gx-drift)
    const BH = Math.round(H * 1.2);
    const dpr = ratio();
    base.width = Math.round(BW * dpr);
    base.height = Math.round(BH * dpr);
    live.width = Math.round(W * dpr);
    live.height = Math.round(H * dpr);
    lx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = base.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ang = -0.42; // Band von links unten nach rechts oben
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const len = Math.hypot(BW, BH);
    const band = BH * 0.11; // halbe Bandbreite
    const along = (t, off) => [BW / 2 + dx * t - dy * off, BH / 2 + dy * t + dx * off];
    g.clearRect(0, 0, BW, BH);
    g.globalCompositeOperation = 'lighter';
    // weiches Glühen entlang des Bands, hellerer Kern etwas links der Mitte
    for (let k = 0; k < 34; k++) {
      const t = rnd(-0.55, 0.55) * len;
      const core = Math.exp(-(((t / len) + 0.12) ** 2) / 0.02);
      const [x, y] = along(t, gauss() * band * 0.35);
      blob(g, x, y, band * rnd(1.4, 2.6), band * rnd(0.7, 1.2), ang,
        core > 0.3 ? '255,214,190' : '205,212,255', 0.05 + 0.09 * core);
    }
    // rötliche und violette Nebel, passend zum roten HUD
    const NEB = ['190,20,45', '170,30,110', '110,40,170', '220,60,40'];
    for (let k = 0; k < 9; k++) {
      const [x, y] = along(rnd(-0.45, 0.45) * len, gauss() * band * 1.4);
      blob(g, x, y, band * rnd(1.2, 3.2), band * rnd(0.8, 1.8), ang + rnd(-0.6, 0.6), NEB[k % NEB.length], rnd(0.07, 0.14));
    }
    // Sterne: dicht im Band, locker überall
    const stars = (n, inBand) => {
      for (let i = 0; i < n; i++) {
        let x;
        let y;
        if (inBand) [x, y] = along(rnd(-0.6, 0.6) * len, gauss() * band * (0.45 + 0.35 * Math.random()));
        else { x = Math.random() * BW; y = Math.random() * BH; }
        const s = Math.random() < 0.94 ? rnd(0.5, 1.1) : rnd(1.2, 1.9);
        g.fillStyle = `rgba(${STAR[(Math.random() * STAR.length) | 0]},${rnd(0.25, 0.95)})`;
        g.fillRect(x, y, s, s);
      }
    };
    stars(Math.round((BW * BH) / 520), true); // auf Full-HD gut 5.000
    stars(Math.round((BW * BH) / 2600), false); // gut 1.000
    // dunkle Staubbahnen mitten im Band
    g.globalCompositeOperation = 'source-over';
    for (let k = 0; k < 26; k++) {
      const [x, y] = along(rnd(-0.5, 0.5) * len, gauss() * band * 0.18);
      blob(g, x, y, band * rnd(0.5, 1.3), band * rnd(0.12, 0.3), ang + rnd(-0.25, 0.25), '0,0,0', rnd(0.25, 0.5));
    }
    // ein paar helle Sterne, die größten mit Strahlen
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 46; k++) {
      const x = Math.random() * BW;
      const y = Math.random() * BH;
      const s = rnd(4, 12);
      g.globalAlpha = rnd(0.4, 0.9);
      g.drawImage(glow, x - s, y - s, s * 2, s * 2);
      if (k < 10) {
        g.strokeStyle = 'rgba(255,235,230,.35)';
        g.lineWidth = 0.6;
        g.beginPath();
        g.moveTo(x - s * 1.8, y); g.lineTo(x + s * 1.8, y);
        g.moveTo(x, y - s * 1.8); g.lineTo(x, y + s * 1.8);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    // funkelnde Sterne liegen eher im Band
    const diag = Math.hypot(W, H);
    twinkles = Array.from({ length: 130 }, () => {
      let x;
      let y;
      if (Math.random() < 0.65) {
        const t = rnd(-0.5, 0.5) * diag;
        const o = gauss() * H * 0.11;
        x = W / 2 + dx * t - dy * o;
        y = H / 2 + dy * t + dx * o;
      } else {
        x = Math.random() * W;
        y = Math.random() * H;
      }
      return { x, y, s: rnd(2.5, 6), ph: Math.random() * 6.28, sp: rnd(0.6, 2.2) };
    });
    if (reduced) still(); // iPhone: ohne Schleife das Funkeln einmal stehend zeichnen
  }

  // Funkelnde Sterne zum Zeitpunkt t (Sekunden)
  function drawTwinkles(t) {
    lx.clearRect(0, 0, W, H);
    lx.globalCompositeOperation = 'lighter';
    for (const s of twinkles) {
      const a = Math.abs(Math.sin(t * s.sp + s.ph)) ** 3;
      if (a < 0.04) continue;
      lx.globalAlpha = a;
      lx.drawImage(glow, s.x - s.s, s.y - s.s, s.s * 2, s.s * 2);
    }
    lx.globalAlpha = 1;
  }

  // iPhone: weniger Bewegung – ein ruhiges Bild ohne Sternschnuppe
  function still() {
    shot = null;
    drawTwinkles(12.5);
    lx.globalCompositeOperation = 'source-over';
  }

  function frame(ts) {
    if (paused || reduced) { running = false; return; }
    requestAnimationFrame(frame);
    if (!shot && ts - last < 30) return; // Funkeln mit ~30 Bildern/s, Sternschnuppe flüssig mit 60
    last = ts;
    const t = ts / 1000;
    drawTwinkles(t);
    // Sternschnuppe alle paar Sekunden, schräg nach unten
    if (!shot && t > nextShot) {
      const a = Math.PI / 2 + rnd(0.35, 0.75) * (Math.random() < 0.5 ? 1 : -1);
      shot = { x: rnd(0.1, 0.9) * W, y: rnd(0.02, 0.35) * H, vx: Math.cos(a) * rnd(900, 1400),
        vy: Math.sin(a) * rnd(500, 800), t0: t, life: rnd(0.7, 1.1), len: rnd(0.12, 0.2) };
    }
    if (shot) {
      const k = (t - shot.t0) / shot.life;
      if (k >= 1) {
        shot = null;
        nextShot = t + rnd(6, 15);
      } else {
        const hx = shot.x + shot.vx * (t - shot.t0);
        const hy = shot.y + shot.vy * (t - shot.t0);
        const tx = hx - shot.vx * shot.len;
        const ty = hy - shot.vy * shot.len;
        const fade = Math.sin(k * Math.PI);
        const gr = lx.createLinearGradient(tx, ty, hx, hy);
        gr.addColorStop(0, 'rgba(255,200,190,0)');
        gr.addColorStop(1, `rgba(255,245,240,${0.9 * fade})`);
        lx.strokeStyle = gr;
        lx.lineWidth = 1.6;
        lx.lineCap = 'round';
        lx.beginPath(); lx.moveTo(tx, ty); lx.lineTo(hx, hy); lx.stroke();
        lx.globalAlpha = fade;
        lx.drawImage(glow, hx - 6, hy - 6, 12, 12);
        lx.globalAlpha = 1;
      }
    }
    lx.globalCompositeOperation = 'source-over';
  }

  function start() {
    if (running || paused || reduced) return;
    running = true;
    requestAnimationFrame(frame);
  }

  let resizeTimer = 0;
  const later = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 250);
  };
  window.addEventListener('resize', later);
  window.addEventListener('orientationchange', later); // iPhone: Drehen des Telefons
  render();
  nextShot = performance.now() / 1000 + rnd(3, 8);
  start();
  window.Galaxy = {
    pause(on) {
      paused = on;
      if (!on) start();
    },
    // iPhone: weniger Bewegung (ARCHITECTURE.md §9.5)
    setReducedMotion(on) {
      reduced = !!on;
      if (reduced) still();
      else {
        nextShot = performance.now() / 1000 + rnd(3, 8);
        start();
      }
    },
  };
})();
