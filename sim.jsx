/*
 * Eolic Sea Park — simulation engine.
 * Pure canvas rendering. React layer in app.jsx drives the state.
 * Physics model lifted from the Jensen/Park wake equations described in
 * the source repo's README, simplified for the redesigned visualisation.
 */

const CFG = {
  ROTOR_R: 14,            // px, rotor radius (top-down icon)
  BLADE_LEN: 22,          // px, drawn blade length
  WAKE_K: 0.08,
  WAKE_A: 0.33,
  PARTICLE_N: 260,
  PARTICLE_LIFE: 2.2,     // seconds
  MOVE_RANGE: 130,        // px, max signed slide along diagonal
  AXIS_DASH_GAP: 6,
};

/** Convert wind FROM-angle (degrees, 0=N, 90=E…) → flow unit vector (y-down). */
function flowVec(fromDeg) {
  const r = (fromDeg * Math.PI) / 180;
  return { x: -Math.sin(r), y: Math.cos(r) };
}

/** Axis unit vector for a given diagonal. y-down screen coords. */
function axisVec(axis) {
  const inv = 1 / Math.SQRT2;
  // NE-SW: goes from lower-left to upper-right → positive t moves up-right
  if (axis === 'NE-SW') return { x: inv, y: -inv };
  // NW-SE: from upper-left to lower-right → positive t moves down-right
  return { x: inv, y: inv };
}

/** Turbine factory. home is the placement origin; t is signed offset along the axis. */
function makeTurbine(id, hx, hy) {
  return {
    id,
    homeX: hx,
    homeY: hy,
    t: 0,
    blade: Math.random() * Math.PI * 2,
    power: 0,
    lastWind: 0,
  };
}

/** Project a turbine to its current world position. */
function turbinePos(t, axis) {
  const a = axisVec(axis);
  return { x: t.homeX + a.x * t.t, y: t.homeY + a.y * t.t };
}

/** Single-turbine Jensen wake deficit at point (px,py). */
function wakeDeficit(turbine, axis, flow, px, py) {
  const p = turbinePos(turbine, axis);
  const dx = px - p.x;
  const dy = py - p.y;
  // distance along flow (downstream)
  const ds = dx * flow.x + dy * flow.y;
  if (ds <= 0) return 0;
  // perpendicular distance
  const perpX = dx - ds * flow.x;
  const perpY = dy - ds * flow.y;
  const r = Math.hypot(perpX, perpY);
  const R = CFG.ROTOR_R + CFG.WAKE_K * ds;
  if (r > R * 1.8) return 0;
  const base = (2 * CFG.WAKE_A) / Math.pow(1 + (CFG.WAKE_K * ds) / CFG.ROTOR_R, 2);
  const gauss = Math.exp(-2 * Math.pow(r / R, 2));
  return base * gauss;
}

/** Compose local wind at a point: vBase * Π(1 - wake_i), excluding self. */
function windAt(px, py, turbines, axis, flow, vBase, excludeId) {
  let mul = 1;
  for (const t of turbines) {
    if (t.id === excludeId) continue;
    const d = wakeDeficit(t, axis, flow, px, py);
    mul *= 1 - d;
    if (mul < 0.05) break;
  }
  return vBase * Math.max(0, mul);
}

/** Average local wind across the rotor (9 samples). */
function windAtRotor(turbine, turbines, axis, flow, vBase) {
  const p = turbinePos(turbine, axis);
  // perp axis for rotor sampling, perpendicular to flow
  const px = -flow.y, py = flow.x;
  const samples = 9;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const a = (i - (samples - 1) / 2) / ((samples - 1) / 2); // -1..1
    const sx = p.x + px * a * CFG.ROTOR_R;
    const sy = p.y + py * a * CFG.ROTOR_R;
    sum += windAt(sx, sy, turbines, axis, flow, vBase, turbine.id);
  }
  return sum / samples;
}

/** Cubic power curve, capped, normalised to 0..1 then scaled to watts. */
function turbinePower(vEff) {
  const norm = Math.min(1, Math.pow(vEff / 15, 3));
  return norm * 240; // peak ≈ 240 W per turbine for display
}

// ─────────────────────────────────────────────────────────────
// Particle field
// ─────────────────────────────────────────────────────────────
class ParticleField {
  constructor() {
    this.parts = [];
    for (let i = 0; i < CFG.PARTICLE_N; i++) {
      this.parts.push({ x: 0, y: 0, life: Math.random() * CFG.PARTICLE_LIFE, born: 0 });
    }
  }
  respawn(p, w, h, flow) {
    // spawn at upwind boundary, slightly off-edge
    const cx = w / 2, cy = h / 2;
    // pick a random offset perpendicular to flow, project against bounds
    const perpX = -flow.y, perpY = flow.x;
    const t = (Math.random() - 0.5) * Math.max(w, h) * 1.3;
    // go upstream until outside bounds
    const back = Math.max(w, h) * 0.55;
    p.x = cx + perpX * t - flow.x * back;
    p.y = cy + perpY * t - flow.y * back;
    p.life = 0;
    p.born = Math.random() * 0.2;
  }
  update(dt, w, h, flow, turbines, axis, vBase) {
    for (const p of this.parts) {
      // local wind affects particle speed
      const localV = windAt(p.x, p.y, turbines, axis, flow, vBase) / 15; // 0..1
      const speed = 18 + localV * 110;
      p.x += flow.x * speed * dt;
      p.y += flow.y * speed * dt;
      p.life += dt;
      if (
        p.life > CFG.PARTICLE_LIFE ||
        p.x < -50 || p.x > w + 50 || p.y < -50 || p.y > h + 50
      ) {
        this.respawn(p, w, h, flow);
      }
    }
  }
  draw(ctx, flow) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'oklch(85% 0.04 200 / 0.55)';
    ctx.lineWidth = 1;
    for (const p of this.parts) {
      const tail = 6;
      const ageFade = Math.min(1, p.life / 0.4) * Math.min(1, (CFG.PARTICLE_LIFE - p.life) / 0.6);
      if (ageFade <= 0) continue;
      ctx.globalAlpha = 0.4 * ageFade;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - flow.x * tail, p.y - flow.y * tail);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────
// Drawing helpers
// ─────────────────────────────────────────────────────────────
function drawSea(ctx, w, h, time) {
  // base flat
  ctx.fillStyle = getCSS('--bg-sea');
  ctx.fillRect(0, 0, w, h);

  // very faint diagonal "current" stripes
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = getCSS('--ink');
  ctx.lineWidth = 1;
  const gap = 38;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 9);
  for (let y = -h; y < h; y += gap) {
    const off = Math.sin(time * 0.2 + y * 0.02) * 3;
    ctx.beginPath();
    ctx.moveTo(-w, y + off);
    ctx.lineTo(w, y + off);
    ctx.stroke();
  }
  ctx.restore();

  // very subtle vignette
  const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function drawAxisGuide(ctx, turbine, axis, opts) {
  const a = axisVec(axis);
  const len = CFG.MOVE_RANGE;
  const x1 = turbine.homeX - a.x * len;
  const y1 = turbine.homeY - a.y * len;
  const x2 = turbine.homeX + a.x * len;
  const y2 = turbine.homeY + a.y * len;
  ctx.save();
  const col = opts.invalid
    ? getCSS('--warn')
    : opts.selected ? getCSS('--beacon') : getCSS('--line');
  ctx.strokeStyle = col;
  ctx.globalAlpha = opts.invalid ? 0.65 : opts.selected ? 0.45 : 0.35;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.setLineDash([]);

  // tick marks at -1, -0.5, 0, 0.5, 1
  const ticks = [-1, -0.5, 0, 0.5, 1];
  const perpX = -a.y, perpY = a.x;
  ctx.globalAlpha = opts.invalid ? 0.85 : opts.selected ? 0.6 : 0.4;
  for (const tk of ticks) {
    const cx = turbine.homeX + a.x * len * tk;
    const cy = turbine.homeY + a.y * len * tk;
    const tickLen = tk === 0 ? 7 : 4;
    ctx.beginPath();
    ctx.moveTo(cx + perpX * tickLen, cy + perpY * tickLen);
    ctx.lineTo(cx - perpX * tickLen, cy - perpY * tickLen);
    ctx.stroke();
  }

  // home label
  ctx.fillStyle = opts.invalid ? getCSS('--warn') : getCSS('--ink-fade');
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';
  ctx.globalAlpha = opts.invalid ? 1 : opts.selected ? 0.9 : 0.55;
  const label = `T${String(opts.index + 1).padStart(2, '0')}`;
  ctx.fillText(label, x2 + perpX * 10 + 4, y2 + perpY * 10 + 3);
  ctx.restore();
}

function drawWakeCone(ctx, turbine, axis, flow) {
  const p = turbinePos(turbine, axis);
  const maxLen = 280;
  // Base half-width = the visible rotor body radius (the drawn ring).
  // BLADE_LEN was too wide and made the cone overhang the turbine.
  const startW = CFG.ROTOR_R;
  const endW = startW + CFG.WAKE_K * maxLen * 1.6;
  const perpX = -flow.y, perpY = flow.x;
  // Start the cone right at the rotor disc (not slightly behind).
  // Anchor at turbine center; the swept disc visually caps it.
  const baseX = p.x;
  const baseY = p.y;
  const tipX = baseX + flow.x * maxLen;
  const tipY = baseY + flow.y * maxLen;

  ctx.save();
  // Clip the upwind half away so the cone never bleeds back past the rotor.
  ctx.beginPath();
  const farBack = 40;
  // half-plane mask in flow direction: rect from rotor outward
  const fx = flow.x, fy = flow.y;
  // Build a clip polygon: a large quad spanning from the rotor disc downwind
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const reach = Math.max(W, H) * 2;
  const ax = baseX + perpX * reach, ay = baseY + perpY * reach;
  const bx = baseX - perpX * reach, by = baseY - perpY * reach;
  const cx = bx + fx * reach,        cy = by + fy * reach;
  const dx = ax + fx * reach,        dy = ay + fy * reach;
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.lineTo(dx, dy);
  ctx.closePath();
  ctx.clip();

  const grad = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
  grad.addColorStop(0, 'oklch(40% 0.04 220 / 0.32)');
  grad.addColorStop(1, 'oklch(40% 0.04 220 / 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(baseX + perpX * startW, baseY + perpY * startW);
  ctx.lineTo(baseX - perpX * startW, baseY - perpY * startW);
  ctx.lineTo(tipX  - perpX * endW,   tipY  - perpY * endW);
  ctx.lineTo(tipX  + perpX * endW,   tipY  + perpY * endW);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawTurbine(ctx, turbine, axis, flow, opts) {
  const p = turbinePos(turbine, axis);

  ctx.save();
  ctx.translate(p.x, p.y);

  // shadow / water disturbance ring (concentric — was offset before and made
  // both the rotor and the wake cone read as visually off-centre)
  ctx.beginPath();
  ctx.fillStyle = 'oklch(10% 0.01 220 / 0.45)';
  ctx.arc(0, 0, CFG.ROTOR_R * 1.35, 0, Math.PI * 2);
  ctx.fill();

  const warn = opts.invalid;
  const warnCol = getCSS('--warn');

  // selection / bound rings
  if (warn) {
    ctx.strokeStyle = warnCol;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(0, 0, CFG.ROTOR_R * 2.2, 0, Math.PI * 2);
    ctx.stroke();
    // dashed inner ring for emphasis
    ctx.setLineDash([3, 4]);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.arc(0, 0, CFG.ROTOR_R * 1.7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  } else if (opts.bound) {
    ctx.strokeStyle = getCSS('--beacon');
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, CFG.ROTOR_R * 1.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -CFG.ROTOR_R * 2.5);
    ctx.lineTo(-4, -CFG.ROTOR_R * 1.95);
    ctx.lineTo(4, -CFG.ROTOR_R * 1.95);
    ctx.closePath();
    ctx.fillStyle = getCSS('--beacon');
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (opts.selected) {
    ctx.strokeStyle = getCSS('--ink');
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(0, 0, CFG.ROTOR_R * 1.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // outer ring
  ctx.beginPath();
  ctx.strokeStyle = warn ? warnCol : 'oklch(70% 0.02 220 / 0.6)';
  ctx.lineWidth = warn ? 1.5 : 1;
  ctx.arc(0, 0, CFG.ROTOR_R, 0, Math.PI * 2);
  ctx.stroke();

  // blades
  const yaw = Math.atan2(-flow.y, -flow.x);
  ctx.rotate(yaw);
  ctx.rotate(turbine.blade);
  ctx.strokeStyle = warn ? warnCol : getCSS('--ink');
  ctx.globalAlpha = 0.95;
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) {
    ctx.rotate((Math.PI * 2) / 3);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(CFG.BLADE_LEN, 0);
    ctx.stroke();
  }
  // nacelle hub
  ctx.beginPath();
  ctx.fillStyle = getCSS('--bg-deep');
  ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = warn ? warnCol : getCSS('--ink');
  ctx.lineWidth = 1;
  ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawWindCompass(ctx, w, h, flow) {
  // tiny compass rose, bottom-left
  ctx.save();
  const cx = 60, cy = h - 60, r = 26;
  ctx.translate(cx, cy);
  ctx.strokeStyle = getCSS('--line');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
  ctx.globalAlpha = 0.3;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // wind direction arrow (where wind is flowing TO)
  const angle = Math.atan2(flow.y, flow.x);
  ctx.rotate(angle);
  ctx.strokeStyle = getCSS('--beacon');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-r + 4, 0);
  ctx.lineTo(r - 6, 0);
  ctx.stroke();
  ctx.fillStyle = getCSS('--beacon');
  ctx.beginPath();
  ctx.moveTo(r - 2, 0);
  ctx.lineTo(r - 9, -4);
  ctx.lineTo(r - 9, 4);
  ctx.closePath();
  ctx.fill();
  ctx.rotate(-angle);

  ctx.fillStyle = getCSS('--ink-dim');
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -r - 8);
  ctx.fillText('S', 0, r + 14);
  ctx.fillText('E', r + 10, 3);
  ctx.fillText('W', -r - 10, 3);
  ctx.restore();
}

function drawScaleBar(ctx, w, h) {
  ctx.save();
  const x0 = w - 130, y0 = h - 36;
  ctx.strokeStyle = getCSS('--line');
  ctx.fillStyle = getCSS('--ink-dim');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + 100, y0);
  ctx.moveTo(x0, y0 - 4);
  ctx.lineTo(x0, y0 + 4);
  ctx.moveTo(x0 + 100, y0 - 4);
  ctx.lineTo(x0 + 100, y0 + 4);
  ctx.moveTo(x0 + 50, y0 - 3);
  ctx.lineTo(x0 + 50, y0 + 3);
  ctx.stroke();
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('250 m', x0 + 50, y0 + 16);
  ctx.restore();
}

// CSS variable resolver (cached per frame)
let _cssCache = null;
function getCSS(name) {
  if (!_cssCache) _cssCache = getComputedStyle(document.documentElement);
  return _cssCache.getPropertyValue(name).trim();
}
function _resetCSSCache() { _cssCache = null; }

// ─────────────────────────────────────────────────────────────
// Public engine
// ─────────────────────────────────────────────────────────────
class SimEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.w = 0; this.h = 0;
    this.particles = new ParticleField();
    this.time = 0;
    this.searching = false;
    this.searchPhase = 0; // 0..1 progress
    this.searchStarted = 0;
    this.opts = {
      showParticles: true,
      showWake: true,
      showField: false,
    };
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  step(dt, state) {
    _resetCSSCache();
    this.time += dt;
    const { turbines, axis, windDeg, windSpeed } = state;
    const flow = flowVec(windDeg);

    // Update turbine power + blade rotation
    for (const t of turbines) {
      const vEff = windAtRotor(t, turbines, axis, flow, windSpeed);
      t.lastWind = vEff;
      t.power = turbinePower(vEff);
      t.blade += vEff * 0.45 * dt;
    }

    // Search animation: move each turbine along axis towards local optimum
    if (this.searching) {
      this.searchPhase += dt / 3.5;
      const range = CFG.MOVE_RANGE;
      const steps = 24;
      for (const t of turbines) {
        // sample candidate t-values around current
        let bestT = t.t;
        let bestScore = -Infinity;
        for (let i = -steps; i <= steps; i++) {
          const cand = (i / steps) * range;
          // tentatively move
          const oldT = t.t;
          t.t = cand;
          const v = windAtRotor(t, turbines, axis, flow, windSpeed);
          // tiny penalty for moving far from current
          const score = v - Math.abs(cand - oldT) * 0.0007;
          t.t = oldT;
          if (score > bestScore) { bestScore = score; bestT = cand; }
        }
        // ease towards bestT
        const ease = Math.min(1, dt * 1.6);
        t.t += (bestT - t.t) * ease;
      }
      if (this.searchPhase >= 1) {
        this.searching = false;
        this.searchPhase = 0;
      }
    }

    if (this.opts.showParticles) {
      this.particles.update(dt, this.w, this.h, flow, turbines, axis, windSpeed);
    }
  }
  render(state) {
    const { turbines, axis, windDeg, selectedId, boundId } = state;
    const flow = flowVec(windDeg);
    const ctx = this.ctx;
    const w = this.w, h = this.h;
    drawSea(ctx, w, h, this.time);

    // axis guides for each turbine
    for (let i = 0; i < turbines.length; i++) {
      const t = turbines[i];
      drawAxisGuide(ctx, t, axis, {
        selected: t.id === selectedId || t.id === boundId,
        invalid: !!t._invalid,
        index: i,
      });
    }

    // wakes below particles
    if (this.opts.showWake) {
      for (const t of turbines) drawWakeCone(ctx, t, axis, flow);
    }

    if (this.opts.showParticles) {
      this.particles.draw(ctx, flow);
    }

    // turbines on top
    for (const t of turbines) {
      drawTurbine(ctx, t, axis, flow, {
        bound: t.id === boundId,
        selected: t.id === selectedId,
        invalid: !!t._invalid,
      });
    }

    // wind compass + scale
    drawWindCompass(ctx, w, h, flow);
    drawScaleBar(ctx, w, h);

    // Search progress arc
    if (this.searching) {
      ctx.save();
      ctx.strokeStyle = getCSS('--beacon');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(w - 60, 40, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * this.searchPhase);
      ctx.stroke();
      ctx.fillStyle = getCSS('--beacon');
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText('OPTIMIZING', w - 84, 44);
      ctx.restore();
    }
  }

  // Mouse hit-test: returns turbine id under (x,y) or null.
  hit(x, y, turbines, axis) {
    for (let i = turbines.length - 1; i >= 0; i--) {
      const t = turbines[i];
      const p = turbinePos(t, axis);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= CFG.ROTOR_R + 8) return t.id;
    }
    return null;
  }
}

// Expose globals (Babel-script scope isolation workaround)
Object.assign(window, {
  SimEngine,
  CFG,
  flowVec,
  axisVec,
  turbinePos,
  makeTurbine,
  windAtRotor,
  turbinePower,
});
