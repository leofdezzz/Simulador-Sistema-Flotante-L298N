// ============================================================
// Floating Farm Simulator
// Based on the Floating Farm project (Raspberry Pi Pico)
// Wall is a physical barrier — turbines live on the downwind
// side and must find holes to capture wind.
// ============================================================
import * as FFCore from './src/core.mjs';
(() => {
"use strict";

// ── VELOCIDAD DE ANIMACIÓN ──────────────────────────────
// Ajusta este valor para controlar la velocidad general de
// todas las animaciones de búsqueda.
// 1.0 = velocidad base, 2.0 = doble, 0.5 = mitad, etc.
const ANIM_SPEED = 1.0;
// ────────────────────────────────────────────────────────

const CFG = {
    TANK_PAD: 40,
    TURBINE_R: 18,
    BLADE_LEN: 16,
    WALL_THICK: 6,
    WALL_MARGIN: 45,
    PARTICLE_N: 400,
    WAKE_K: 0.08,
    WAKE_A: 0.33,
    SEARCH_SPEED: 3.0,
    SCAN_GRID: 22,
    MOVE_RANGE: 120,       // Radio máximo de movimiento desde posición inicial
    TRAIL_FADE_TIME: 2.0,  // Segundos que tarda el trail en desaparecer
    DOWNWIND_D_FACTOR: 3,  // Separación mínima downwind en múltiplos de D
    PERP_D_FACTOR: 2,      // Separación mínima perpendicular en múltiplos de D
    // Modo libre: turbinas más grandes
    FREE_TURBINE_R: 32,
    FREE_BLADE_LEN: 28,
    COL_WATER_A: "#081e38",
    COL_WATER_B: "#0c2d50",
    COL_WALL: "#6a7a9a",
    COL_HOLE: "#4af0a0",
    COL_BLADE: ["#5ecfff","#ff8c5e","#c084fc","#facc15","#f472b6","#34d399","#fb7185","#38bdf8"],
};

// Config helpers
function turbR()    { return CFG.FREE_TURBINE_R; }
function bladeLen() { return CFG.FREE_BLADE_LEN; }

// Wind vectors: where the wind FLOWS toward (away from the source)
// Button arrows show where wind COMES FROM, vector is the opposite
const WIND_DIRS = [
    { dx: 1, dy: 0 },   // 0: ←  from left,         flows right
    { dx:-1, dy: 0 },   // 1: →  from right,        flows left
    { dx: 0, dy: 1 },   // 2: ↑  from top,          flows down
    { dx: 0, dy:-1 },   // 3: ↓  from bottom,       flows up
    { dx:-1, dy: 1 },   // 4: ↗  from top-right,    flows bottom-left
    { dx: 1, dy:-1 },   // 5: ↙  from bottom-left,  flows top-right
    { dx: 1, dy: 1 },   // 6: ↖  from top-left,     flows bottom-right
    { dx:-1, dy:-1 },   // 7: ↘  from bottom-right,  flows top-left
];
WIND_DIRS.forEach(d => { const m = Math.hypot(d.dx,d.dy); if(m>1){d.dx/=m;d.dy/=m;} });

// ===================== STATE =====================
const S = {
    windDir: 0,  windSpeed: 5,
    turbines: [],  particles: [],
    searching: false,
    showWake: true,  showWind: true,  showField: false,
    t: 0,
    tank: {x:0,y:0,w:0,h:0},
    dragTurbine: null,
    diagAxis: FFCore.AXIS_NE_SW,  // eje diagonal en que se mueven todas las turbinas
    serial: {
        port: null, writer: null, reader: null,
        connected: false,
        boundTurbIdx: -1,
        lastSentMotor: null,
        lastSendT: 0,
        lastStatus: 'Sin conectar',
        incoming: FFCore.makeLineBuffer(),
    },
    chal: {
        phase: 'idle',
        scenario: null,
        baselinePower: 0, baselineEff: 0, baselineScore: 0,
        initialPositions: [],
        userPower: 0, userEff: 0, userMove: 0, userScore: 0,
        aiPower:   0, aiEff:   0, aiMove:   0, aiScore:   0,
    },
};

const cvs = document.getElementById("sim-canvas");
const cx  = cvs.getContext("2d");
let W=0, H=0;

function resize() {
    const c = document.getElementById("canvas-container");
    W = c.clientWidth; H = c.clientHeight;
    cvs.width = W; cvs.height = H;
    S.tank = { x:CFG.TANK_PAD, y:CFG.TANK_PAD, w:W-2*CFG.TANK_PAD, h:H-2*CFG.TANK_PAD };
}

// ===================== HELPERS =====================
function inTank(x,y) {
    const t=S.tank; return x>=t.x&&x<=t.x+t.w&&y>=t.y&&y<=t.y+t.h;
}
function clamp(v,lo,hi) { return Math.max(lo,Math.min(hi,v)); }
function dist(ax,ay,bx,by) { return Math.hypot(bx-ax,by-ay); }

// Movement bounds for a turbine (respecting home + range)
function turbBounds(turb) {
    const base = globalBounds();
    if (!turb || !turb.homeX) return base;
    const r = CFG.MOVE_RANGE;
    return {
        x0: Math.max(base.x0, turb.homeX - r),
        x1: Math.min(base.x1, turb.homeX + r),
        y0: Math.max(base.y0, turb.homeY - r),
        y1: Math.min(base.y1, turb.homeY + r),
    };
}

// Check if point is within a turbine's movement range
function inRange(turb, px, py) {
    if (!turb || !turb.homeX) return true;
    return dist(px, py, turb.homeX, turb.homeY) <= CFG.MOVE_RANGE;
}

// ── Diagonal axis helpers ──
function currentAxisVec() { return FFCore.axisVec(S.diagAxis); }

// Scalar t = projection of (turb.x, turb.y) onto axis through home.
function turbT(turb) {
    if (turb.homeX === undefined) return 0;
    const a = currentAxisVec();
    return (turb.x - turb.homeX) * a.dx + (turb.y - turb.homeY) * a.dy;
}

// Maximum t (in both directions) such that the resulting point stays
// inside globalBounds AND within MOVE_RANGE of home.
function effectiveAxisRange(turb) {
    const a = currentAxisVec();
    const b = globalBounds();
    const hx = turb.homeX, hy = turb.homeY;
    // For each side, solve homeX + t*ax in [b.x0, b.x1] etc. → t bounds
    function clipDir(sign) {
        const dx = sign * a.dx, dy = sign * a.dy;
        let tMax = CFG.MOVE_RANGE;
        if (dx > 0) tMax = Math.min(tMax, (b.x1 - hx) / dx);
        if (dx < 0) tMax = Math.min(tMax, (b.x0 - hx) / dx);
        if (dy > 0) tMax = Math.min(tMax, (b.y1 - hy) / dy);
        if (dy < 0) tMax = Math.min(tMax, (b.y0 - hy) / dy);
        return Math.max(0, tMax);
    }
    return { tPos: clipDir(+1), tNeg: clipDir(-1) };
}

// Map (any) (x,y) onto the turbine's diagonal line through home, clamped to MOVE_RANGE.
function projectTurb(turb, x, y) {
    if (turb.homeX === undefined) return { x, y, t: 0 };
    return FFCore.projectToAxis(turb.homeX, turb.homeY, x, y, S.diagAxis, CFG.MOVE_RANGE);
}

// Global bounds: todo el tanque
function globalBounds() {
    const t = S.tank, m = turbR() + 8;
    return { x0: t.x+m, x1: t.x+t.w-m, y0: t.y+m, y1: t.y+t.h-m };
}


function isDownwind(px, py) {
    const b = globalBounds();
    return px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1;
}

function isValidPos(turb, px, py) {
    return isDownwind(px, py) && inRange(turb, px, py);
}

// Encuentra la posición válida más cercana a (px, py) para la turbina turbIdx
function findNearestValid(turbIdx, px, py) {
    const turb = S.turbines[turbIdx];
    const inChallenge = S.chal.phase === 'user_turn';
    const b = globalBounds();

    function isValid(x, y) {
        if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return false;
        if (inChallenge && turb.homeX !== undefined) {
            if (dist(x, y, turb.homeX, turb.homeY) > CFG.MOVE_RANGE) return false;
        }
        for (let j = 0; j < S.turbines.length; j++) {
            if (j === turbIdx) continue;
            if (violatesSpacing(S.turbines[j].x, S.turbines[j].y, x, y)) return false;
        }
        return true;
    }

    if (isValid(px, py)) return { x: px, y: py };

    const ANGLES = 64;
    const STEP = 5;
    const MAX_R = 900;
    for (let r = STEP; r <= MAX_R; r += STEP) {
        for (let a = 0; a < ANGLES; a++) {
            const ang = (a / ANGLES) * Math.PI * 2;
            const tx = px + Math.cos(ang) * r;
            const ty = py + Math.sin(ang) * r;
            if (isValid(tx, ty)) return { x: tx, y: ty };
        }
    }

    // Fallback: home position
    if (inChallenge && turb.homeX !== undefined) return { x: turb.homeX, y: turb.homeY };
    return { x: b.x0 + (b.x1 - b.x0) / 2, y: b.y0 + (b.y1 - b.y0) / 2 };
}

// Corrige todas las violaciones de spacing entre turbinas, iterando hasta resolverlas
function resolveSpacingViolations() {
    for (let pass = 0; pass < S.turbines.length * 2; pass++) {
        let anyFixed = false;
        for (let i = 0; i < S.turbines.length; i++) {
            if (!spacingOk(i, S.turbines[i].x, S.turbines[i].y)) {
                const nearest = findNearestValid(i, S.turbines[i].x, S.turbines[i].y);
                S.turbines[i].x = nearest.x;
                S.turbines[i].y = nearest.y;
                anyFixed = true;
            }
        }
        if (!anyFixed) break;
    }
}

/**
 * Retorna true si colocar una turbina en (px,py) viola la distancia mínima
 * con una turbina existente en (ox,oy), usando restricción elíptica
 * alineada con la dirección del viento.
 *
 * Zona prohibida: (ds/downwindMin)² + (dp/perpMin)² < 1
 *   ds = componente en dirección del viento (signed)
 *   dp = componente perpendicular al viento
 *   downwindMin = 9 × D  (D = 2 × turbR() = 36px → 324px)
 *   perpMin     = 6 × D  (216px)
 */
function violatesSpacing(ox, oy, px, py) {
    const w = WIND_DIRS[S.windDir];
    const D = 2 * turbR();
    const downwindMin = CFG.DOWNWIND_D_FACTOR * D;
    const perpMin     = CFG.PERP_D_FACTOR     * D;
    const dx = px - ox;
    const dy = py - oy;
    const ds = dx * w.dx + dy * w.dy;    // proyección en dirección del viento
    const dp = -dx * w.dy + dy * w.dx;   // proyección perpendicular
    return (ds / downwindMin) ** 2 + (dp / perpMin) ** 2 < 1;
}

// ===================== WIND MODEL =====================
function wallFactor(px, py) {
    return 1.0;
}

function wakeDef(turb, px, py) {
    const w = WIND_DIRS[S.windDir];
    const dx = px-turb.x, dy = py-turb.y;
    const ds = dx*w.dx + dy*w.dy;
    if (ds <= 5) return 0;
    const perp = Math.abs(-dx*w.dy + dy*w.dx);
    const tr = turbR();
    const R = tr + CFG.WAKE_K * ds;
    if (perp >= R) return 0;
    const deficit = 2*CFG.WAKE_A / ((1 + CFG.WAKE_K*ds/tr)**2);
    const rr = perp/R;
    // Perfil "top-hat" con bordes suaves: mantiene déficit fuerte
    // hasta ~70% del radio, luego cae suavemente. Más realista que
    // Gaussiano puro y hace que los bordes del rotor noten la estela.
    return deficit * Math.max(0, 1 - rr*rr);
}

function windAt(px, py, exclude) {
    let v = S.windSpeed * wallFactor(px, py);
    for (const t of S.turbines) {
        if (t === exclude) continue;
        v *= (1 - wakeDef(t, px, py));
    }
    return Math.max(0, v);
}

// Rotor-averaged wind: samples across the rotor disk perpendicular to wind.
// This makes turbines feel the wake as soon as the rotor edge enters it.
const ROTOR_SAMPLES = 9; // points across the rotor diameter (más muestras = mejor detección de solapamiento parcial)
function windAtRotor(cx2, cy2, exclude) {
    const w = WIND_DIRS[S.windDir];
    const tr = turbR();
    // Perpendicular direction to wind
    const px = -w.dy, py = w.dx;
    let total = 0;
    for (let i = 0; i < ROTOR_SAMPLES; i++) {
        const frac = (i / (ROTOR_SAMPLES - 1)) * 2 - 1; // -1 to +1
        const sx = cx2 + px * tr * frac;
        const sy = cy2 + py * tr * frac;
        total += windAt(sx, sy, exclude);
    }
    return total / ROTOR_SAMPLES;
}

function windToVoltage(v) {
    const n = v/15;
    return Math.min(100, n*n*n * 300);
}

// Potencia por turbina (W). Referencia: 15 MW a 12 m/s (offshore flotante)
function windToPower(v) {
    if (v < 3) return 0;
    const rated = 15e6, ratedV = 12;
    const n = v / ratedV;
    return Math.min(rated, rated * n * n * n);
}

function formatPower(w) {
    if (w >= 1e9) return (w/1e9).toFixed(2) + ' GW';
    if (w >= 1e6) return (w/1e6).toFixed(2) + ' MW';
    if (w >= 1e3) return (w/1e3).toFixed(1) + ' kW';
    return w.toFixed(0) + ' W';
}

function updatePowerPanel() {
    if (!S.turbines.length) {
        document.getElementById('power-total').textContent = '— W';
        document.getElementById('power-per-turbine').textContent = '';
        return;
    }
    let total = 0;
    for (const t of S.turbines) {
        const ws = windAtRotor(t.x, t.y, t);
        total += windToPower(ws);
    }
    const avg = total / S.turbines.length;
    document.getElementById('power-total').textContent = formatPower(total);
    document.getElementById('power-per-turbine').textContent = `${formatPower(avg)} / turbina`;
    const tsP = document.getElementById('ts-power');
    if (tsP) tsP.textContent = formatPower(total);
    // Barra de progreso: max teórico = n turbinas × 15 MW
    const maxTotal = S.turbines.length * 15e6;
    const pct = Math.min(100, (total / maxTotal) * 100);
    document.getElementById('power-bar-fill').style.width = pct + '%';
    const fill = document.getElementById('power-bar-fill');
    fill.style.background = pct > 70 ? '#4af06a' : pct > 35 ? '#f0da4a' : '#f08a4a';
}

// ===================== SEARCH ALGORITHM =====================
// Busca la mejor posición colectiva con movimiento mínimo.
// - Penaliza la distancia de desplazamiento en el escaneo inicial
// - Bonifica (levemente) movimientos en un solo eje
// - Las turbinas ya bien posicionadas no se mueven

const SEARCH_PENALTY = 0.004;  // coste por píxel de movimiento (en unidades m/s)
const AXIS_BONUS     = 0.04;   // pequeño bonus de desempate para movimiento de eje único
const AXIS_RATIO     = 0.25;   // ratio para snap de eje: si componente menor < 25% del mayor → eje único
const MIN_SCAN_SCORE = 0;      // siempre moverse si hay mejora neta (score > 0)

/**
 * Aplica snap de eje: si un componente del movimiento es < AXIS_RATIO del otro,
 * lo elimina para forzar movimiento de eje único.
 */
function axisSnap(fromX, fromY, toX, toY) {
    const adx = Math.abs(toX - fromX), ady = Math.abs(toY - fromY);
    let tx = toX, ty = toY;
    if (adx > 0 && ady / adx < AXIS_RATIO) ty = fromY;  // movimiento mayormente horizontal
    if (ady > 0 && adx / ady < AXIS_RATIO) tx = fromX;  // movimiento mayormente vertical
    return { tx, ty };
}

/**
 * Puntúa una posición candidata en la fase de ESCANEO.
 * Retorna: mejora_viento - penalización_distancia [+ pequeño_bonus_eje]
 * Solo se usa en prepareScan/scan. Refine y global usan windGain directo.
 */
function candidateScore(turb, px, py, currentWind) {
    const newWind = windAtRotor(px, py, turb);
    const d = Math.hypot(px - turb.x, py - turb.y);
    let score = (newWind - currentWind) - SEARCH_PENALTY * d;
    // Bonus solo si el movimiento es VERDADERAMENTE de un eje
    // (el componente menor es < 15% del mayor → casi puro X o Y)
    const adx = Math.abs(px - turb.x), ady = Math.abs(py - turb.y);
    if (Math.min(adx, ady) / Math.max(adx, ady, 1) < 0.15) score += AXIS_BONUS;
    return score;
}

/** Comprueba que (px,py) no viola el spacing con ninguna otra turbina */
function spacingOk(excludeIdx, px, py) {
    for (let j = 0; j < S.turbines.length; j++) {
        if (j === excludeIdx) continue;
        if (violatesSpacing(S.turbines[j].x, S.turbines[j].y, px, py)) return false;
    }
    return true;
}

/** Viento total recibido por todo el parque (suma de windAtRotor de cada turbina) */
function farmTotalWind() {
    let total = 0;
    for (const t of S.turbines) total += windAtRotor(t.x, t.y, t);
    return total;
}

/**
 * Calcula el viento total del parque si la turbina[idx] estuviera en (nx, ny).
 * Mueve la turbina temporalmente para que sus efectos de estela en los demás
 * se recalculen correctamente, luego restaura la posición original.
 */
function farmTotalWindIfMoved(idx, nx, ny) {
    const turb = S.turbines[idx];
    const ox = turb.x, oy = turb.y;
    turb.x = nx; turb.y = ny;
    const total = farmTotalWind();
    turb.x = ox; turb.y = oy;
    return total;
}

function startSearch() {
    if (!S.turbines.length) return;
    S.searching = true;
    S.globalRefine = false;
    S.finalAnimation = false;
    S.globalRefineN = 0;
    setStatus("Escaneando...");
    for (const t of S.turbines) {
        t.origX = t.x; t.origY = t.y;   // guardar posición original para animación final
        t.phase = 'waiting'; t.trail = []; t.scanPts = null;
    }
    activateNext(0);
}

function activateNext(startIdx) {
    for (let i = startIdx; i < S.turbines.length; i++) {
        if (S.turbines[i].phase === 'waiting') {
            const t = S.turbines[i];
            t.phase = 'scanning';
            t.scanIdx = 0;
            t.trailAlpha = 1; t.trailFadeStart = 0;
            prepareScan(t);
            setStatus(`Turbina ${i+1}: escaneando...`);
            return;
        }
    }
}

function prepareScan(turb) {
    // Diagonal-axis scan: sample N points along the diagonal line through
    // (homeX, homeY), clipped to MOVE_RANGE and tank bounds.
    const a = currentAxisVec();
    const r = effectiveAxisRange(turb);
    const N = 40;
    turb.scanPts = [];
    for (let i = 0; i < N; i++) {
        // span from -tNeg to +tPos
        const frac = i / (N - 1);
        const t = -r.tNeg + (r.tPos + r.tNeg) * frac;
        const px = turb.homeX + t * a.dx;
        const py = turb.homeY + t * a.dy;
        turb.scanPts.push({ x: px, y: py });
    }
    // Baseline: quedarse en el sitio actual (score = 0)
    turb.currentWind = windAtRotor(turb.x, turb.y, turb);
    turb.bestScan = { x: turb.x, y: turb.y, score: 0 };
}

function updateSearch(dt) {
    if (!S.searching) return;

    // ── Animación final: todos se mueven a la vez desde origen a posición óptima ──
    if (S.finalAnimation) {
        let allArrived = true;
        for (const t of S.turbines) {
            const dx = t.finalX - t.x, dy = t.finalY - t.y;
            const d = Math.hypot(dx, dy);
            if (d < 2) {
                t.x = t.finalX; t.y = t.finalY;
            } else {
                allArrived = false;
                const spd = Math.min(CFG.SEARCH_SPEED * ANIM_SPEED * dt, d);
                t.x += (dx/d)*spd; t.y += (dy/d)*spd;
                t.trail.push({x:t.x, y:t.y});
                if (t.trail.length > 600) t.trail.shift();
            }
        }
        if (allArrived) {
            S.finalAnimation = false;
            S.searching = false;
            for (const t of S.turbines) t.trailFadeStart = S.t;
            setStatus("Posición óptima");
            if (S.chal.phase === 'ai_running') {
                S.chal.aiPower = 0;
                for (const t of S.turbines) S.chal.aiPower += windToPower(windAtRotor(t.x, t.y, t));
                S.chal.aiEff   = calcEfficiency(S.turbines);
                S.chal.aiMove  = calcAvgMovement(S.turbines, S.chal.initialPositions);
                S.chal.aiScore = calcScore(S.turbines, S.chal.initialPositions);
                S.chal.phase = 'done';
                document.getElementById("ai-banner").classList.add("hidden");
                showChallengeResults();
            }
        }
        return;
    }

    // ── Refinamiento global SECUENCIAL (cálculo silencioso, sin animar) ──
    if (S.globalRefine) {
        const i = S.globalRefineIdx;
        const turb = S.turbines[i];

        // Snap instantáneo al objetivo calculado (sin animación)
        if (turb.globalTarget) {
            turb.x = turb.globalTarget.x; turb.y = turb.globalTarget.y;
            turb.globalTarget = null;
        }

        // Escaneo 1D a lo largo del eje diagonal (objetivo: parque total)
        const ax = currentAxisVec();
        const rng = effectiveAxisRange(turb);
        const GSCAN = 30;
        const baseTotal = farmTotalWind();

        let bestNet = baseTotal + 0.001;
        let bestX = turb.x, bestY = turb.y;

        for (let k = 0; k < GSCAN; k++) {
            const frac = k / (GSCAN - 1);
            const t = -rng.tNeg + (rng.tPos + rng.tNeg) * frac;
            const px = turb.homeX + t * ax.dx;
            const py = turb.homeY + t * ax.dy;
            if (!isValidPos(turb, px, py) || !spacingOk(i, px, py)) continue;
            const d = Math.hypot(px - turb.x, py - turb.y);
            if (d < 4) continue;
            const net = farmTotalWindIfMoved(i, px, py) - SEARCH_PENALTY * d;
            if (net > bestNet) { bestNet = net; bestX = px; bestY = py; }
        }

        if (bestX !== turb.x || bestY !== turb.y) {
            // Diagonal-only: skip axisSnap (which would push off-axis)
            if (spacingOk(i, bestX, bestY)) {
                turb.globalTarget = { x: bestX, y: bestY };
                S.globalRefineAnyMoved = true;
            }
        }

        // Pasar a la siguiente turbina
        S.globalRefineIdx++;
        if (S.globalRefineIdx >= S.turbines.length) {
            if (S.globalRefineAnyMoved && S.globalRefineN < 8) {
                S.globalRefineN++;
                S.globalRefineIdx = 0;
                S.globalRefineAnyMoved = false;
            } else {
                // Cálculo terminado → corregir violaciones de spacing antes de animar
                resolveSpacingViolations();
                S.globalRefine = false;
                S.finalAnimation = true;
                for (const t of S.turbines) {
                    t.finalX = t.x; t.finalY = t.y;
                    t.x = t.origX;  t.y = t.origY;
                    t.trail = [];
                }
                setStatus("Moviéndose a posición óptima...");
            }
        }
        return;
    }

    // ── Búsqueda individual secuencial (cálculo silencioso) ──
    const ti = S.turbines.findIndex(t => t.phase !== 'waiting' && t.phase !== 'done');
    if (ti < 0) {
        if (S.turbines.every(t => t.phase === 'done')) {
            if (S.turbines.length > 1) {
                S.globalRefine = true;
                S.globalRefineN = 0;
                S.globalRefineIdx = 0;
                S.globalRefineAnyMoved = false;
                for (const t of S.turbines) t.globalTarget = null;
                setStatus("Calculando óptimo global...");
            } else {
                // Una sola turbina: animación final directa
                resolveSpacingViolations();
                S.finalAnimation = true;
                const t = S.turbines[0];
                t.finalX = t.x; t.finalY = t.y;
                t.x = t.origX;  t.y = t.origY;
                t.trail = [];
                setStatus("Moviéndose a posición óptima...");
            }
        }
        return;
    }
    const turb = S.turbines[ti];

    // ── Escaneo ──
    if (turb.phase === 'scanning') {
        const batch = Math.round(48 * ANIM_SPEED);  // más rápido: cálculo silencioso
        for (let b = 0; b < batch && turb.scanIdx < turb.scanPts.length; b++) {
            const sp = turb.scanPts[turb.scanIdx];
            if (isValidPos(turb, sp.x, sp.y)) {
                let ok = true;
                for (let j = 0; j < S.turbines.length; j++) {
                    if (j === ti) continue;
                    if (violatesSpacing(S.turbines[j].x, S.turbines[j].y, sp.x, sp.y)) { ok=false; break; }
                }
                if (ok) {
                    const sc = candidateScore(turb, sp.x, sp.y, turb.currentWind);
                    if (sc > turb.bestScan.score) {
                        turb.bestScan = { x: sp.x, y: sp.y, score: sc };
                    }
                }
            }
            turb.scanIdx++;
        }
        if (turb.scanIdx >= turb.scanPts.length) {
            if (turb.bestScan.score <= MIN_SCAN_SCORE) {
                turb.phase = 'done';
                activateNext(ti+1);
            } else {
                // Diagonal-only: bestScan already lies on the axis line; do not snap.
                turb.targetX = turb.bestScan.x;
                turb.targetY = turb.bestScan.y;
                turb.phase = 'moving';
            }
        }
    }
    // ── Snap instantáneo al objetivo (sin animar) ──
    else if (turb.phase === 'moving') {
        turb.x = turb.targetX; turb.y = turb.targetY;
        turb.phase = 'refining'; turb.refineN = 0;
    }
    // ── Micro-ajuste 1D a lo largo del eje diagonal ──
    else if (turb.phase === 'refining') {
        if (turb.refineTarget) {
            turb.x = turb.refineTarget.x; turb.y = turb.refineTarget.y;
            turb.refineTarget = null;
        } else {
            const step = 4;
            const ax = currentAxisVec();
            const curWind = windAtRotor(turb.x, turb.y, turb);
            let bestGain = 0.05, bdx = 0, bdy = 0;
            for (const s of [+1, -1]) {
                const dx = s * ax.dx * step, dy = s * ax.dy * step;
                const nx = turb.x + dx, ny = turb.y + dy;
                if (!isValidPos(turb, nx, ny)) continue;
                // Stay within MOVE_RANGE of home along the axis
                const p = projectTurb(turb, nx, ny);
                if (Math.hypot(p.x - nx, p.y - ny) > 0.5) continue;
                let ok = true;
                for (let j = 0; j < S.turbines.length; j++) {
                    if (j === ti) continue;
                    if (violatesSpacing(S.turbines[j].x, S.turbines[j].y, nx, ny)) { ok=false; break; }
                }
                if (!ok) continue;
                const gain = windAtRotor(nx, ny, turb) - curWind;
                if (gain > bestGain) { bestGain = gain; bdx = dx; bdy = dy; }
            }
            if (bdx || bdy) {
                turb.refineTarget = { x: turb.x + bdx, y: turb.y + bdy };
            }
            turb.refineN++;
            if (turb.refineN > 12 || (!bdx && !bdy)) {
                turb.phase = 'done';
                activateNext(ti+1);
            }
        }
    }
}

function continuousOptimize() {
    if (S.searching) return;
    const ax = currentAxisVec();
    for (let i = 0; i < S.turbines.length; i++) {
        const turb = S.turbines[i];
        if (turb.phase !== 'done') continue;
        const step = 3;
        const curWind = windAtRotor(turb.x, turb.y, turb);
        let bdx = 0, bdy = 0, bestGain = 0.05;
        for (const s of [+1, -1]) {
            const nx = turb.x + s * ax.dx * step;
            const ny = turb.y + s * ax.dy * step;
            if (!isValidPos(turb, nx, ny) || !spacingOk(i, nx, ny)) continue;
            // Stay within MOVE_RANGE of home
            const dx = nx - turb.homeX, dy = ny - turb.homeY;
            const tNew = dx * ax.dx + dy * ax.dy;
            if (Math.abs(tNew) > CFG.MOVE_RANGE) continue;
            const gain = windAtRotor(nx, ny, turb) - curWind;
            if (gain > bestGain) { bestGain = gain; bdx = s * ax.dx * 0.4; bdy = s * ax.dy * 0.4; }
        }
        if (bdx || bdy) {
            turb.x += bdx; turb.y += bdy;
            turb.trail.push({x:turb.x, y:turb.y});
            if (turb.trail.length > 600) turb.trail.shift();
        }
    }
}

// ===================== PARTICLES =====================
function spawnParticle(scatter) {
    const t=S.tank, w=WIND_DIRS[S.windDir];
    let x,y;
    if (scatter) { x=t.x+Math.random()*t.w; y=t.y+Math.random()*t.h; }
    else {
        if (Math.abs(w.dx) >= Math.abs(w.dy)) {
            x = w.dx>0 ? t.x-4 : t.x+t.w+4;
            y = t.y+Math.random()*t.h;
        } else {
            x = t.x+Math.random()*t.w;
            y = w.dy>0 ? t.y-4 : t.y+t.h+4;
        }
        if (Math.abs(w.dx)>0.1 && Math.abs(w.dy)>0.1 && Math.random()>0.5) {
            x = t.x+Math.random()*t.w;
            y = w.dy>0 ? t.y-4 : t.y+t.h+4;
        }
    }
    return { x, y, spd:0.3+Math.random()*0.7, life:1, sz:1+Math.random()*1.5 };
}

function initParticles() {
    S.particles = [];
    for (let i=0;i<CFG.PARTICLE_N;i++) S.particles.push(spawnParticle(true));
}

function updateParticles(dt) {
    const t=S.tank, w=WIND_DIRS[S.windDir];
    for (let i=0; i<S.particles.length; i++) {
        const p=S.particles[i];
        const v = windAt(p.x, p.y) * 0.5;
        p.x += w.dx*v*p.spd*dt;
        p.y += w.dy*v*p.spd*dt;
        p.life -= 0.002*dt;
        if (p.life<=0 || p.x<t.x-20 || p.x>t.x+t.w+20 || p.y<t.y-20 || p.y>t.y+t.h+20) {
            S.particles[i] = spawnParticle(false);
        }
    }
}

// ===================== RENDERING =====================
function drawTank() {
    const t=S.tank;
    const g = cx.createRadialGradient(t.x+t.w/2,t.y+t.h/2,0, t.x+t.w/2,t.y+t.h/2,Math.max(t.w,t.h)*0.7);
    g.addColorStop(0, CFG.COL_WATER_B); g.addColorStop(1, CFG.COL_WATER_A);
    cx.fillStyle = g; cx.fillRect(t.x,t.y,t.w,t.h);
    // Ripples
    cx.save(); cx.globalAlpha=0.035; cx.strokeStyle="#4a9af0"; cx.lineWidth=0.8;
    for (let i=0;i<10;i++) {
        const rx=t.x+t.w*((i*0.17+S.t*0.02)%1);
        const ry=t.y+t.h*((i*0.23+S.t*0.015)%1);
        const r=12+Math.sin(S.t*0.4+i*1.1)*8;
        cx.beginPath(); cx.arc(rx,ry,r,0,Math.PI*2); cx.stroke();
    }
    cx.restore();
    // Labels
    cx.strokeStyle="#2a4a6a"; cx.lineWidth=2; cx.strokeRect(t.x,t.y,t.w,t.h);
    cx.fillStyle="#2a4a6a"; cx.font="11px Segoe UI";
    cx.fillText("Tanque de agua", t.x+6, t.y+14);
}


function drawWindField() {
    if (!S.showField) return;
    const t=S.tank, w=WIND_DIRS[S.windDir];
    const step=28;
    for (let x=t.x+step/2;x<t.x+t.w;x+=step) {
        for (let y=t.y+step/2;y<t.y+t.h;y+=step) {
            const v = windAt(x,y);
            const int = clamp(v/S.windSpeed, 0, 1);
            cx.save(); cx.globalAlpha=0.2*int+0.05;
            const len=10*int;
            const ang=Math.atan2(w.dy,w.dx);
            cx.beginPath();
            cx.moveTo(x-w.dx*len*0.3,y-w.dy*len*0.3);
            cx.lineTo(x+w.dx*len,y+w.dy*len);
            cx.strokeStyle = int>0.35 ? "#4af0a0" : "#f06a4a";
            cx.lineWidth=1;cx.stroke();
            const ax=x+w.dx*len, ay=y+w.dy*len;
            cx.beginPath();cx.moveTo(ax,ay);
            cx.lineTo(ax-Math.cos(ang-0.5)*4,ay-Math.sin(ang-0.5)*4);
            cx.moveTo(ax,ay);
            cx.lineTo(ax-Math.cos(ang+0.5)*4,ay-Math.sin(ang+0.5)*4);
            cx.stroke(); cx.restore();
        }
    }
}

function drawParticles() {
    if (!S.showWind) return;
    for (const p of S.particles) {
        if (!inTank(p.x,p.y)) continue;
        const v=windAt(p.x,p.y);
        const int=clamp(v/S.windSpeed,0,1);
        cx.beginPath();
        cx.arc(p.x,p.y,p.sz*(0.3+int*0.7),0,Math.PI*2);
        cx.fillStyle=`rgba(120,200,255,${p.life*int*0.5})`;
        cx.fill();
    }
}

function drawWake() {
    if (!S.showWake) return;
    const w=WIND_DIRS[S.windDir], px=-w.dy, py=w.dx;
    for (const turb of S.turbines) {
        const cl=400, r0=turbR(), r1=r0+CFG.WAKE_K*cl;
        cx.beginPath();
        cx.moveTo(turb.x+px*r0, turb.y+py*r0);
        cx.lineTo(turb.x+w.dx*cl+px*r1, turb.y+w.dy*cl+py*r1);
        cx.lineTo(turb.x+w.dx*cl-px*r1, turb.y+w.dy*cl-py*r1);
        cx.lineTo(turb.x-px*r0, turb.y-py*r0);
        cx.closePath();
        const g=cx.createLinearGradient(turb.x,turb.y, turb.x+w.dx*cl,turb.y+w.dy*cl);
        g.addColorStop(0,"rgba(255,70,50,0.12)");
        g.addColorStop(0.4,"rgba(255,100,50,0.06)");
        g.addColorStop(1,"rgba(255,140,50,0.01)");
        cx.fillStyle=g; cx.fill();
        cx.setLineDash([4,6]); cx.strokeStyle="rgba(255,80,50,0.1)"; cx.lineWidth=1;
        cx.beginPath();
        cx.moveTo(turb.x+px*r0,turb.y+py*r0);
        cx.lineTo(turb.x+w.dx*cl+px*r1,turb.y+w.dy*cl+py*r1);
        cx.moveTo(turb.x-px*r0,turb.y-py*r0);
        cx.lineTo(turb.x+w.dx*cl-px*r1,turb.y+w.dy*cl-py*r1);
        cx.stroke(); cx.setLineDash([]);
    }
}

function drawScanOverlay() {
    for (const turb of S.turbines) {
        if (!turb.scanPts || turb.phase === 'waiting' || turb.phase === null) continue;
        // Show scan points (persist during scanning AND moving phases)
        const showAll = turb.phase === 'scanning' || turb.phase === 'moving';
        if (!showAll && turb.phase !== 'refining') continue;
        const maxShow = turb.phase === 'scanning' ? turb.scanIdx : turb.scanPts.length;
        for (let i=0; i<maxShow; i++) {
            const sp=turb.scanPts[i];
            if (sp.v<0) continue;
            const int=clamp(sp.v/S.windSpeed,0,1);
            const r = 2 + int * 2;
            cx.beginPath(); cx.arc(sp.x, sp.y, r, 0, Math.PI*2);
            // Color: green=good wind, red=no wind
            const g = Math.round(100 + 155*int);
            const rb = Math.round(100*(1-int));
            cx.fillStyle = `rgba(${rb},${g},${rb+60},${0.1+int*0.4})`;
            cx.fill();
        }
        // Pulsing best-position marker
        if (turb.bestScan && turb.bestScan.score > 0) {
            const pulse = 6 + 3*Math.sin(S.t*4);
            cx.save(); cx.shadowColor="#4af0a0"; cx.shadowBlur=15;
            cx.beginPath(); cx.arc(turb.bestScan.x, turb.bestScan.y, pulse, 0, Math.PI*2);
            cx.strokeStyle="#4af0a0"; cx.lineWidth=2; cx.stroke();
            cx.restore();
            // Cross-hair
            cx.strokeStyle="rgba(74,240,160,0.5)"; cx.lineWidth=1;
            cx.beginPath();
            cx.moveTo(turb.bestScan.x-10, turb.bestScan.y);
            cx.lineTo(turb.bestScan.x+10, turb.bestScan.y);
            cx.moveTo(turb.bestScan.x, turb.bestScan.y-10);
            cx.lineTo(turb.bestScan.x, turb.bestScan.y+10);
            cx.stroke();
        }
        // Scanning beam effect: line from turbine to current scan point
        if (turb.phase === 'scanning' && turb.scanIdx < turb.scanPts.length) {
            const sp = turb.scanPts[Math.min(turb.scanIdx, turb.scanPts.length-1)];
            cx.save(); cx.globalAlpha=0.3;
            cx.setLineDash([3,5]);
            cx.beginPath(); cx.moveTo(turb.x, turb.y); cx.lineTo(sp.x, sp.y);
            cx.strokeStyle="#4af0a0"; cx.lineWidth=1; cx.stroke();
            cx.setLineDash([]);
            cx.restore();
        }
    }
}

function drawGhostTurbineAt(x, y, idx, label) {
    const col = CFG.COL_BLADE[idx % CFG.COL_BLADE.length];
    const tr = turbR(), bl = bladeLen();
    const angle = (S.t * 0.3 + idx * 1.2);  // giro lento
    cx.save();
    cx.globalAlpha = 0.20 + 0.08 * Math.sin(S.t * 2.5 + idx);
    cx.beginPath(); cx.arc(x, y, tr + 5, 0, Math.PI * 2);
    cx.fillStyle = "rgba(60,90,140,0.25)"; cx.fill();
    cx.strokeStyle = "#3a5a8a"; cx.lineWidth = 1.5;
    cx.setLineDash([5, 5]); cx.stroke(); cx.setLineDash([]);
    for (let i = 0; i < 3; i++) {
        const a = angle + i * Math.PI * 2 / 3;
        cx.beginPath(); cx.moveTo(x, y);
        cx.lineTo(x + Math.cos(a) * bl, y + Math.sin(a) * bl);
        cx.strokeStyle = col; cx.lineWidth = 2.5; cx.lineCap = "round"; cx.stroke();
    }
    cx.fillStyle = "#4a7aaa"; cx.font = "bold 9px Segoe UI"; cx.textAlign = "center";
    cx.fillText(label, x, y - tr - 10);
    cx.restore();
}

function drawTurbine(turb, idx) {
    const {x,y,bladeAngle}=turb;
    const col=CFG.COL_BLADE[idx%CFG.COL_BLADE.length];
    const tr = turbR(), bl = bladeLen();
    // Movement range circle
    if (turb.homeX !== undefined) {
        cx.save();
        cx.beginPath(); cx.arc(turb.homeX, turb.homeY, CFG.MOVE_RANGE, 0, Math.PI*2);
        cx.setLineDash([6,6]);
        cx.strokeStyle = `rgba(${hexToRgb(col)},0.2)`;
        cx.lineWidth = 1; cx.stroke();
        cx.setLineDash([]);
        // Home position small marker
        cx.beginPath(); cx.arc(turb.homeX, turb.homeY, 3, 0, Math.PI*2);
        cx.fillStyle = `rgba(${hexToRgb(col)},0.3)`; cx.fill();
        cx.restore();
    }
    // Trail
    if (turb.trail && turb.trail.length>1) {
        let alpha = 0.3;
        if (turb.trailFadeStart > 0) {
            const elapsed = S.t - turb.trailFadeStart;
            const fade = 1 - elapsed / CFG.TRAIL_FADE_TIME;
            if (fade <= 0) { turb.trail = []; }
            else alpha = 0.3 * fade;
        }
        if (turb.trail.length > 1) {
            cx.save(); cx.globalAlpha=alpha; cx.strokeStyle=col; cx.lineWidth=1.5;
            cx.beginPath(); cx.moveTo(turb.trail[0].x, turb.trail[0].y);
            for (let i=1;i<turb.trail.length;i++) cx.lineTo(turb.trail[i].x, turb.trail[i].y);
            cx.stroke(); cx.restore();
        }
    }
    // Platform
    cx.beginPath();cx.arc(x,y,tr+5,0,Math.PI*2);
    cx.fillStyle="rgba(30,50,80,0.45)";cx.fill();
    cx.strokeStyle="rgba(80,120,160,0.3)";cx.lineWidth=1;cx.stroke();
    // Search glow
    if (turb.phase==='moving'||turb.phase==='refining'||turb.phase==='scanning') {
        const gl=0.3+0.2*Math.sin(S.t*4);
        cx.beginPath();cx.arc(x,y,tr+10+Math.sin(S.t*3)*3,0,Math.PI*2);
        cx.strokeStyle=`rgba(74,240,160,${gl})`;cx.lineWidth=2;cx.stroke();
    }
    // Posición prohibida al arrastrar
    if (turb._dragBlocked) {
        cx.save();
        cx.beginPath();cx.arc(x,y,tr+12,0,Math.PI*2);
        cx.strokeStyle="rgba(255,60,60,0.85)";cx.lineWidth=2;
        cx.setLineDash([4,4]);cx.stroke();cx.setLineDash([]);
        cx.restore();
    }
    // Turbina en posición inválida (parpadeo rojo al intentar terminar)
    if (turb._invalid) {
        const blink = Math.abs(Math.sin(S.t * 8));
        cx.save();
        cx.globalAlpha = 0.3 + 0.7 * blink;
        cx.beginPath(); cx.arc(x, y, tr + 14, 0, Math.PI * 2);
        cx.fillStyle = "rgba(255,40,40,0.25)"; cx.fill();
        cx.beginPath(); cx.arc(x, y, tr + 14, 0, Math.PI * 2);
        cx.strokeStyle = `rgba(255,60,60,${0.6 + 0.4 * blink})`;
        cx.lineWidth = 3; cx.stroke();
        cx.restore();
    }
    // Moving: dashed line to target
    if (turb.phase==='moving' && turb.targetX !== undefined) {
        cx.save(); cx.setLineDash([6,4]); cx.globalAlpha=0.4;
        cx.beginPath(); cx.moveTo(x,y); cx.lineTo(turb.targetX, turb.targetY);
        cx.strokeStyle=col; cx.lineWidth=1.5; cx.stroke();
        cx.setLineDash([]); cx.restore();
        cx.beginPath(); cx.arc(turb.targetX, turb.targetY, 4+Math.sin(S.t*5)*2, 0, Math.PI*2);
        cx.strokeStyle=col; cx.lineWidth=1.5; cx.stroke();
    }
    // Hub
    cx.beginPath();cx.arc(x,y,7,0,Math.PI*2);
    cx.fillStyle="#c0c8d8";cx.fill();cx.strokeStyle="#8090a8";cx.lineWidth=1.5;cx.stroke();
    // Blades
    for (let i=0;i<3;i++) {
        const a=bladeAngle+i*Math.PI*2/3;
        const bx=x+Math.cos(a)*bl, by=y+Math.sin(a)*bl;
        cx.beginPath();cx.moveTo(x,y);cx.lineTo(bx,by);
        cx.strokeStyle=col;cx.lineWidth=4;cx.lineCap="round";cx.stroke();
        cx.beginPath();cx.arc(bx,by,3,0,Math.PI*2);cx.fillStyle=col;cx.fill();
    }
    // Voltage bar
    const bw=36,bh=4,bx2=x-bw/2,by2=y+tr+10;
    cx.fillStyle="rgba(0,0,0,0.5)";cx.fillRect(bx2,by2,bw,bh);
    const vp=clamp(turb.voltage/100,0,1);
    cx.fillStyle=vp>0.5?"#4af06a":vp>0.2?"#f0da4a":"#f04a4a";
    cx.fillRect(bx2,by2,bw*vp,bh);
    cx.strokeStyle="rgba(80,120,160,0.4)";cx.lineWidth=0.5;cx.strokeRect(bx2,by2,bw,bh);
    // Text
    cx.fillStyle="#b0c0d8";cx.font="10px Segoe UI";cx.textAlign="center";
    cx.fillText(`${turb.voltage.toFixed(1)}V`,x,by2+14);
    cx.fillStyle=col;cx.font="bold 9px Segoe UI";
    cx.fillText(`T${idx+1}`,x,y-tr-8);
    cx.textAlign="left";
}

// Helper to convert hex color to rgb components
function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `${r},${g},${b}`;
}

function drawWindArrow() {
    const t=S.tank, w=WIND_DIRS[S.windDir];
    const margin=20, al=22;
    const ax=t.x+t.w-margin-al, ay=t.y+margin+al+6;
    cx.save();cx.globalAlpha=0.65;
    cx.beginPath();
    cx.moveTo(ax-w.dx*al,ay-w.dy*al);cx.lineTo(ax+w.dx*al,ay+w.dy*al);
    cx.strokeStyle="#4a9af0";cx.lineWidth=3;cx.stroke();
    const tx=ax+w.dx*al, ty=ay+w.dy*al;
    const ang=Math.atan2(w.dy,w.dx);
    cx.beginPath();cx.moveTo(tx,ty);
    cx.lineTo(tx-Math.cos(ang-0.4)*9,ty-Math.sin(ang-0.4)*9);
    cx.lineTo(tx-Math.cos(ang+0.4)*9,ty-Math.sin(ang+0.4)*9);
    cx.closePath();cx.fillStyle="#4a9af0";cx.fill();
    cx.fillStyle="#6a9ad0";cx.font="11px Segoe UI";cx.textAlign="center";
    cx.fillText("Viento",ax,ay-al-6);
    cx.fillText(`${S.windSpeed.toFixed(1)} m/s`,ax,ay+al+16);
    cx.textAlign="left";cx.restore();
}

// ===================== UPDATE + RENDER =====================
function update(dt) {
    S.t += dt*0.016;
    updateParticles(dt);
    updateSearch(dt);
    continuousOptimize();
    // Topbar clock (~1 Hz)
    const nowSec = Math.floor(Date.now() / 1000);
    if ((S._lastClockSec||0) !== nowSec) {
        S._lastClockSec = nowSec;
        const d = new Date();
        const clk = document.getElementById('ts-clock');
        if (clk) clk.textContent = d.toLocaleTimeString('es', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
        const tsTurb = document.getElementById('ts-turbines');
        if (tsTurb) tsTurb.textContent = S.turbines.length;
    }
    for (const t of S.turbines) {
        const ws = windAtRotor(t.x,t.y,t);
        t.voltage = windToVoltage(ws);
        t.bladeSpeed = ws*0.06;
        t.bladeAngle = (t.bladeAngle||0) + t.bladeSpeed*dt;
    }
    streamBoundTurbinePosition();
}

// ===================== SERIAL / WEBSERIAL =====================
// ESP32 prototype mirroring. Uses Web Serial API (Chrome/Edge over
// localhost or HTTPS). Streams the bound turbine's diagonal-axis
// position (normalised 0..1000) to the physical hardware.
function setSerialStatus(txt) {
    S.serial.lastStatus = txt;
    const el = document.getElementById('serial-status');
    if (el) el.textContent = txt;
}

async function connectSerial() {
    if (!('serial' in navigator)) {
        setSerialStatus('Web Serial no soportado (usa Chrome/Edge)');
        return;
    }
    if (S.serial.connected) return;
    try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        S.serial.port    = port;
        S.serial.writer  = port.writable.getWriter();
        S.serial.connected = true;
        setSerialStatus('Conectado');
        readSerialLoop().catch(() => {});
    } catch (err) {
        setSerialStatus('Error: ' + (err && err.message || err));
    }
}

async function disconnectSerial() {
    S.serial.connected = false;
    try { await S.serial.writer?.close(); } catch {}
    try { S.serial.writer?.releaseLock(); } catch {}
    try { await S.serial.reader?.cancel(); } catch {}
    try { await S.serial.port?.close(); } catch {}
    S.serial.writer = null; S.serial.reader = null; S.serial.port = null;
    S.serial.lastSentMotor = null;
    setSerialStatus('Desconectado');
    refreshSerialUI();
}

async function readSerialLoop() {
    const port = S.serial.port;
    if (!port || !port.readable) return;
    const reader = port.readable.getReader();
    S.serial.reader = reader;
    const decoder = new TextDecoder();
    try {
        while (S.serial.connected) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const raw of S.serial.incoming.push(text)) {
                handleSerialMessage(FFCore.parseLine(raw));
            }
        }
    } catch {} finally {
        try { reader.releaseLock(); } catch {}
    }
}

function handleSerialMessage(msg) {
    switch (msg.type) {
        case 'ready':  setSerialStatus('Listo');           break;
        case 'homed':  setSerialStatus('Calibrado (home)'); break;
        case 'pos':    setSerialStatus('POS ' + msg.value); break;
        case 'error':  setSerialStatus('ERR ' + msg.msg);   break;
        case 'log':    /* silently */                       break;
    }
}

async function serialWrite(line) {
    if (!S.serial.connected || !S.serial.writer) return;
    try {
        await S.serial.writer.write(new TextEncoder().encode(line));
    } catch (err) {
        setSerialStatus('Tx error: ' + (err && err.message || err));
    }
}

function bindTurbine(idx) {
    S.serial.boundTurbIdx  = (Number.isInteger(idx) ? idx : -1);
    S.serial.lastSentMotor = null;
    refreshSerialUI();
}

function streamBoundTurbinePosition() {
    if (!S.serial.connected) return;
    const idx = S.serial.boundTurbIdx;
    if (idx < 0 || idx >= S.turbines.length) return;
    const turb = S.turbines[idx];
    if (turb.homeX === undefined) return;
    const proj  = FFCore.projectToAxis(turb.homeX, turb.homeY, turb.x, turb.y,
                                       S.diagAxis, CFG.MOVE_RANGE);
    const motor = FFCore.mapTtoMotor(proj.t, CFG.MOVE_RANGE);
    const now = performance.now();
    if (motor === S.serial.lastSentMotor) return;
    if (now - S.serial.lastSendT < 50) return;       // throttle ~20 Hz
    S.serial.lastSentMotor = motor;
    S.serial.lastSendT     = now;
    serialWrite(FFCore.formatMove(motor));
    const mpos = document.getElementById('motor-pos-indicator');
    if (mpos) mpos.style.left = (motor / 10).toFixed(1) + '%';
}

function refreshSerialUI() {
    const sel = document.getElementById('serial-bind-select');
    if (sel) {
        sel.innerHTML = '<option value="-1">— ninguna —</option>' +
            S.turbines.map((_, i) =>
                `<option value="${i}" ${i===S.serial.boundTurbIdx?'selected':''}>Turbina ${i+1}</option>`
            ).join('');
    }
    const cBtn = document.getElementById('btn-serial-connect');
    const dBtn = document.getElementById('btn-serial-disconnect');
    const hBtn = document.getElementById('btn-serial-home');
    if (cBtn) cBtn.disabled = S.serial.connected;
    if (dBtn) dBtn.disabled = !S.serial.connected;
    if (hBtn) hBtn.disabled = !S.serial.connected;
}

function render() {
    cx.clearRect(0,0,W,H);
    cx.fillStyle="#060a14";cx.fillRect(0,0,W,H);
    drawTank();
    drawWindField();

    // Durante el cálculo silencioso (antes de la animación final), mantener las
    // turbinas visualmente en su posición original para evitar parpadeos.
    const computing = S.searching && !S.finalAnimation;
    let savedPos = null;
    if (computing) {
        savedPos = S.turbines.map(t => ({ x: t.x, y: t.y }));
        for (const t of S.turbines) {
            if (t.origX !== undefined) { t.x = t.origX; t.y = t.origY; }
        }
    }

    drawWake();
    drawScanOverlay();
    drawParticles();
    // Ghost turbines: posiciones iniciales del reto durante la animación de la IA
    if (S.finalAnimation && S.chal.phase === 'ai_running' && S.chal.initialPositions.length) {
        for (let i=0; i<S.chal.initialPositions.length; i++) {
            drawGhostTurbineAt(S.chal.initialPositions[i].x, S.chal.initialPositions[i].y, i, "Inicio");
        }
    }
    for (let i=0;i<S.turbines.length;i++) drawTurbine(S.turbines[i],i);
    drawWindArrow();

    // Restaurar posiciones computadas
    if (computing && savedPos) {
        for (let i=0; i<S.turbines.length; i++) {
            S.turbines[i].x = savedPos[i].x;
            S.turbines[i].y = savedPos[i].y;
        }
    }

    document.getElementById("info-turbines").textContent = S.turbines.length;
    updatePowerPanel();
    updateTurbineList();
    updateChallengeLive();
}

let lastT = performance.now();
function loop(now) {
    const dt = Math.min((now-lastT)/16.67, 3);
    lastT = now;
    update(dt); render();
    requestAnimationFrame(loop);
}

// ===================== UI =====================
function setStatus(txt) { document.getElementById("info-status").textContent=txt; }

function spawnTurbine() {
    const b = globalBounds();
    // Try to find a position that doesn't overlap existing turbines
    let px, py, attempts = 0;
    do {
        px = b.x0 + Math.random()*(b.x1-b.x0);
        py = b.y0 + Math.random()*(b.y1-b.y0);
        attempts++;
    } while (attempts < 50 && S.turbines.some(t => violatesSpacing(t.x,t.y,px,py)));
    const turb = {
        x: px, y: py,
        homeX: px, homeY: py,  // Home position for range constraint
        bladeAngle: Math.random()*Math.PI*2,
        bladeSpeed:0, voltage:0,
        phase:null, trail:[], scanPts:null,
        trailAlpha: 0, trailFadeStart: 0,
        id: Date.now()+Math.random(),
    };
    S.turbines.push(turb);
    updateTurbineList();
}

// ===================== CHALLENGE SYSTEM =====================

// Rango de movimiento fijo para desafíos — igual para jugador e IA
const CHALLENGE_MOVE_RANGE = 140;

/**
 * Eficiencia de potencia pura: actual / teórica máxima sin estelas (0-100%).
 */
function calcEfficiency(turbineList) {
    const maxPerTurb = windToPower(S.windSpeed);
    const theorMax   = turbineList.length * maxPerTurb;
    if (theorMax === 0) return 0;
    let actual = 0;
    for (const t of turbineList) actual += windToPower(windAtRotor(t.x, t.y, t));
    return actual / theorMax * 100;
}

/**
 * Movimiento medio por turbina respecto a las posiciones iniciales del reto (px).
 */
function calcAvgMovement(turbineList, initialPositions) {
    if (!initialPositions || !initialPositions.length) return 0;
    let total = 0;
    for (let i = 0; i < turbineList.length; i++) {
        const ip = initialPositions[i];
        total += Math.hypot(turbineList[i].x - ip.x, turbineList[i].y - ip.y);
    }
    return total / turbineList.length;
}

/**
 * Puntuación combinada del desafío (0-100):
 *   potencia_eff% - penalización_movimiento
 *
 * Penalización máxima: 25 puntos si cada turbina usa todo su rango permitido.
 * Esto premia llegar al mejor resultado con el mínimo movimiento.
 */
function calcScore(turbineList, initialPositions) {
    const powerEff  = calcEfficiency(turbineList);
    const avgMove   = calcAvgMovement(turbineList, initialPositions);
    const movePenalty = (avgMove / CHALLENGE_MOVE_RANGE) * 25; // máx −25 puntos
    return Math.max(0, powerEff - movePenalty);
}

const CHALLENGES = [
    {
        name: "Cadena de Estela",
        emoji: "💨",
        difficulty: 1,
        diffLabel: "Fácil",
        desc: "4 turbinas alineadas con el viento de izquierda. Cada una bloquea a la siguiente con su estela.",
        windDir: 0, windSpeed: 8,
        // fracciones del interior del tanque [xf, yf]
        pos: [[0.14,0.50],[0.26,0.50],[0.38,0.50],[0.50,0.50]],
    },
    {
        name: "El Racimo",
        emoji: "🌀",
        difficulty: 2,
        diffLabel: "Medio",
        desc: "5 turbinas apiñadas en el centro con viento bajando desde arriba. Sepáralas para aprovechar el espacio.",
        windDir: 2, windSpeed: 7,
        pos: [[0.50,0.40],[0.57,0.47],[0.43,0.47],[0.54,0.55],[0.46,0.55]],
    },
    {
        name: "La Trampa Diagonal",
        emoji: "⚡",
        difficulty: 3,
        diffLabel: "Difícil",
        desc: "6 turbinas en diagonal con viento en diagonal. Parece correcto, pero todas se tapan entre sí.",
        windDir: 6, windSpeed: 9,
        pos: [[0.15,0.15],[0.25,0.25],[0.35,0.35],[0.45,0.45],[0.55,0.55],[0.65,0.65]],
    },
    {
        name: "Gran Parque Flotante",
        emoji: "🌊",
        difficulty: 4,
        diffLabel: "Experto",
        desc: "8 turbinas en cuadrícula compacta con viento lateral. El mayor parque que habrás tenido que optimizar.",
        windDir: 1, windSpeed: 10,
        pos: [[0.65,0.22],[0.65,0.42],[0.65,0.62],[0.65,0.78],[0.45,0.22],[0.45,0.42],[0.45,0.62],[0.45,0.78]],
    },
];

/** Convierte fracción de tanque a coordenada de canvas */
function fracToCanvas(xf, yf) {
    const t = S.tank;
    return { x: t.x + xf * t.w, y: t.y + yf * t.h };
}

/** Muestra el selector de desafíos */
function openChallengeSelector() {
    if (S.searching) return;
    const list = document.getElementById("chal-list");
    list.innerHTML = CHALLENGES.map((c, i) => `
        <div class="chal-card" data-idx="${i}">
            <div class="chal-emoji">${c.emoji}</div>
            <div class="chal-info">
                <div class="chal-name">${c.name}</div>
                <div class="chal-desc">${c.desc}</div>
                <div class="chal-meta">
                    <span class="chal-turbs">🌀 ${c.pos.length} turbinas</span>
                    <span class="chal-diff diff-${c.difficulty}">${c.diffLabel}</span>
                </div>
            </div>
            <button class="chal-play-btn" data-idx="${i}">Jugar ▶</button>
        </div>
    `).join("");
    document.getElementById("chal-selector").classList.remove("hidden");
}

/** Carga un escenario de desafío */
function loadChallenge(idx) {
    const sc = CHALLENGES[idx];
    document.getElementById("chal-selector").classList.add("hidden");

    // Configurar viento
    S.windDir = sc.windDir;
    S.windSpeed = sc.windSpeed;
    document.getElementById("wind-speed-val").textContent = sc.windSpeed.toFixed(1);
    document.getElementById("wind-speed").value = sc.windSpeed;
    document.querySelectorAll(".wind-btn").forEach(b => b.classList.remove("active"));
    document.querySelector(`.wind-btn[data-dir="${sc.windDir}"]`).classList.add("active");
    initParticles();

    // Colocar turbinas en posiciones iniciales (malas)
    S.turbines = [];
    S.searching = false;
    for (const [xf, yf] of sc.pos) {
        const {x, y} = fracToCanvas(xf, yf);
        S.turbines.push({
            x, y, homeX: x, homeY: y,
            bladeAngle: Math.random() * Math.PI * 2,
            bladeSpeed: 0, voltage: 0,
            phase: null, trail: [], scanPts: null,
            trailAlpha: 0, trailFadeStart: 0,
            id: Date.now() + Math.random(),
        });
    }

    // Rango fijo para el desafío — igual para jugador e IA
    CFG.MOVE_RANGE = CHALLENGE_MOVE_RANGE;
    document.getElementById("move-range-val").textContent = CFG.MOVE_RANGE;
    document.getElementById("move-range").value = Math.min(CFG.MOVE_RANGE, 300);

    // Calcular métricas base (posición inicial mala, movimiento=0)
    S.chal.baselinePower = 0;
    for (const t of S.turbines) S.chal.baselinePower += windToPower(windAtRotor(t.x, t.y, t));
    S.chal.baselineEff   = calcEfficiency(S.turbines);
    S.chal.baselineScore = S.chal.baselineEff; // sin movimiento → sin penalización

    // Guardar posiciones iniciales para los ghosts
    S.chal.initialPositions = S.turbines.map(t => ({x: t.x, y: t.y}));
    S.chal.scenario = sc;
    S.chal.phase = 'user_turn';

    // UI
    document.getElementById("challenge-hud").classList.remove("hidden");
    document.getElementById("hud-title").textContent = sc.emoji + " " + sc.name;
    document.getElementById("hud-desc").textContent = `Rango: ±${CHALLENGE_MOVE_RANGE}px por turbina (igual que la IA). Muévelas para mejorar la eficiencia.`;
    document.getElementById("btn-challenge").classList.add("hidden");
    document.getElementById("btn-submit-challenge").classList.remove("hidden");
    document.getElementById("challenge-live").classList.remove("hidden");
    document.getElementById("live-baseline").textContent = S.chal.baselineEff.toFixed(1) + "%";
    updateTurbineList();
    setStatus("Desafío: turno del jugador");

    // Colapsar el HUD después de 3 s para no molestar
    const hud = document.getElementById("challenge-hud");
    hud.classList.remove("collapsed");
    clearTimeout(S._hudCollapseTimer);
    S._hudCollapseTimer = setTimeout(() => hud.classList.add("collapsed"), 3000);
}

/** El jugador pulsa "¡He terminado!" */
function submitChallenge() {
    if (S.chal.phase !== 'user_turn') return;

    // Validar que ninguna turbina esté en posición inválida (zona roja)
    let anyInvalid = false;
    for (let i = 0; i < S.turbines.length; i++) {
        const invalid = !spacingOk(i, S.turbines[i].x, S.turbines[i].y);
        S.turbines[i]._invalid = invalid;
        if (invalid) anyInvalid = true;
    }
    if (anyInvalid) {
        const hud = document.getElementById("challenge-hud");
        hud.classList.remove("collapsed");
        document.getElementById("hud-desc").textContent =
            "¡Hay turbinas en zona prohibida! Muévelas antes de terminar.";
        clearTimeout(S._invalidWarningTimer);
        S._invalidWarningTimer = setTimeout(() => {
            if (S.chal.phase === 'user_turn') {
                document.getElementById("hud-desc").textContent =
                    `Rango: ±${CHALLENGE_MOVE_RANGE}px por turbina (igual que la IA). Muévelas para mejorar la eficiencia.`;
                hud.classList.add("collapsed");
            }
        }, 3000);
        return;
    }

    // Guardar métricas del jugador
    S.chal.userPower = 0;
    for (const t of S.turbines) S.chal.userPower += windToPower(windAtRotor(t.x, t.y, t));
    S.chal.userEff   = calcEfficiency(S.turbines);
    S.chal.userMove  = calcAvgMovement(S.turbines, S.chal.initialPositions);
    S.chal.userScore = calcScore(S.turbines, S.chal.initialPositions);

    // Resetear turbinas a posiciones iniciales del reto para que la IA parta del mismo punto
    for (let i = 0; i < S.turbines.length; i++) {
        const ip = S.chal.initialPositions[i];
        S.turbines[i].x = ip.x; S.turbines[i].y = ip.y;
        S.turbines[i].homeX = ip.x; S.turbines[i].homeY = ip.y;
        S.turbines[i].phase = null; S.turbines[i].trail = [];
        S.turbines[i]._invalid = false;
    }

    S.chal.phase = 'ai_running';
    document.getElementById("challenge-hud").classList.add("hidden");
    document.getElementById("ai-banner").classList.remove("hidden");
    document.getElementById("ai-banner-txt").textContent = "🤖 Calculando posición óptima…";
    document.getElementById("btn-submit-challenge").classList.add("hidden");
    document.getElementById("challenge-live").classList.add("hidden");
    setStatus("IA calculando...");
    startSearch();
}

function showChallengeResults() {
    const { baselineScore, baselineEff, baselinePower,
            userScore,    userEff,    userPower,    userMove,
            aiScore,      aiEff,      aiPower,      aiMove } = S.chal;
    const sc = S.chal.scenario;

    document.getElementById("result-trophy").textContent = sc.emoji;
    document.getElementById("result-title").textContent  = sc.name;

    // Barras basadas en PUNTUACIÓN (métrica principal: eficiencia - penalización movimiento)
    const maxScore = Math.max(baselineScore, userScore, aiScore, 1);
    setTimeout(() => {
        document.getElementById("bar-baseline").style.width = (baselineScore / maxScore * 100) + "%";
        document.getElementById("bar-player").style.width   = (userScore     / maxScore * 100) + "%";
        document.getElementById("bar-ai").style.width       = (aiScore       / maxScore * 100) + "%";
    }, 150);

    // Valor principal: puntuación combinada
    document.getElementById("val-baseline").textContent = baselineScore.toFixed(1) + " pts";
    document.getElementById("val-player").textContent   = userScore.toFixed(1)     + " pts";
    document.getElementById("val-ai").textContent       = aiScore.toFixed(1)       + " pts";

    // Secundario: eficiencia % y movimiento medio
    const fmtDelta = (eff, move) => `Ef: ${eff.toFixed(1)}%  ·  Mov: ${move.toFixed(0)}px`;
    document.getElementById("delta-baseline").textContent = fmtDelta(baselineEff, 0);
    document.getElementById("delta-player").textContent   = fmtDelta(userEff, userMove);
    document.getElementById("delta-ai").textContent       = fmtDelta(aiEff,  aiMove);
    document.getElementById("delta-player").style.color   = userScore > baselineScore ? "#4af06a" : userScore < baselineScore ? "#f06a4a" : "#8a9abc";
    document.getElementById("delta-ai").style.color       = "#4af06a";

    // Diferencia IA vs jugador en puntuación
    const beaten  = userScore >= aiScore;
    const diffPts = Math.abs(aiScore - userScore);

    const labelEl  = document.getElementById("delta-label");
    const improvEl = document.getElementById("improvement-val");
    labelEl.textContent = beaten
        ? "¡Superaste a la IA por"
        : "La IA te supera en puntuación por";
    improvEl.classList.toggle("negative", beaten);

    // Contador animado
    const t0 = performance.now();
    (function countUp(now) {
        const p    = Math.min((now - t0) / 1500, 1);
        const ease = 1 - Math.pow(1 - p, 3);
        improvEl.textContent = "+" + (diffPts * ease).toFixed(1) + " pts";
        if (p < 1) requestAnimationFrame(countUp);
    })(t0);

    // Nota basada en qué % de la puntuación de la IA logró el jugador
    const relScore = aiScore > 0 ? (userScore / aiScore * 100) : 0;
    let grade, gradeColor, msg;
    if (beaten)            { grade="🦅 LEYENDA"; gradeColor="#facc15"; msg="¡Increíble! Superaste al algoritmo con las mismas condiciones."; }
    else if (relScore>=97) { grade="💎 PERFECTO"; gradeColor="#a78bfa"; msg="Prácticamente igual al óptimo. El sistema apenas te supera."; }
    else if (relScore>=90) { grade="⭐ EXPERTO";  gradeColor="#4af06a"; msg="¡Excelente intuición! Muy cerca del óptimo."; }
    else if (relScore>=78) { grade="✅ BUENO";    gradeColor="#4af0a0"; msg="Buena colocación. Queda margen de mejora."; }
    else if (relScore>=60) { grade="📈 REGULAR";  gradeColor="#f0da4a"; msg="El sistema encontró una disposición más eficiente."; }
    else if (relScore>=35) { grade="⚙️ NOVATO";   gradeColor="#f0a04a"; msg="El sistema mejoró bastante la eficiencia del parque."; }
    else                   { grade="💨 APRENDIZ"; gradeColor="#f06a4a"; msg="El sistema encontró una posición mucho más eficiente."; }

    const gradeEl = document.getElementById("challenge-grade");
    gradeEl.textContent = grade;
    gradeEl.style.color = gradeColor;
    gradeEl.style.textShadow = `0 0 28px ${gradeColor}99`;
    document.getElementById("grade-message").textContent = msg;

    document.getElementById("challenge-overlay").classList.remove("hidden");
    document.getElementById("btn-challenge").classList.remove("hidden");
    S.chal.phase = 'done';
}

function setupUI() {
    // Wind buttons
    document.querySelectorAll(".wind-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            S.windDir = parseInt(btn.dataset.dir);
            document.querySelectorAll(".wind-btn").forEach(b=>b.classList.remove("active"));
            btn.classList.add("active");
            const tsDir = document.getElementById("ts-wind-dir");
            if (tsDir) tsDir.textContent = btn.textContent.trim();
            initParticles();
            if (S.turbines.some(t=>t.phase==='done')) startSearch();
        });
    });

    document.getElementById("wind-speed").addEventListener("input", e => {
        S.windSpeed = parseFloat(e.target.value);
        document.getElementById("wind-speed-val").textContent = S.windSpeed.toFixed(1);
        const tsWS = document.getElementById("ts-wind-speed");
        if (tsWS) tsWS.textContent = S.windSpeed.toFixed(1);
    });

    // Movement range slider
    document.getElementById("move-range").addEventListener("input", e => {
        CFG.MOVE_RANGE = parseInt(e.target.value);
        document.getElementById("move-range-val").textContent = CFG.MOVE_RANGE;
    });

    document.getElementById("btn-add-turbine").addEventListener("click", spawnTurbine);
    document.getElementById("btn-remove-turbine").addEventListener("click", () => {
        if (S.turbines.length) {
            const lastIdx = S.turbines.length - 1;
            if (S.serial.boundTurbIdx === lastIdx) bindTurbine(-1);
            S.turbines.pop();
            updateTurbineList();
        }
    });

    document.getElementById("btn-start-search").addEventListener("click", startSearch);

    // Challenge system
    document.getElementById("btn-challenge").addEventListener("click", openChallengeSelector);
    document.getElementById("btn-chal-cancel").addEventListener("click", () => {
        document.getElementById("chal-selector").classList.add("hidden");
    });
    document.getElementById("chal-list").addEventListener("click", e => {
        const btn = e.target.closest("[data-idx]");
        if (btn) loadChallenge(parseInt(btn.dataset.idx));
    });
    document.getElementById("btn-submit-challenge").addEventListener("click", submitChallenge);
    document.getElementById("btn-close-challenge").addEventListener("click", () => {
        document.getElementById("challenge-overlay").classList.add("hidden");
        // Resetear MOVE_RANGE al valor del slider
        CFG.MOVE_RANGE = parseInt(document.getElementById("move-range").value);
    });
    document.getElementById("btn-reset").addEventListener("click", () => {
        S.searching=false;
        for (const t of S.turbines) {
            // Return to home position
            t.x = t.homeX; t.y = t.homeY;
            t.phase=null; t.trail=[];
        }
        setStatus("Esperando");
    });

    document.getElementById("chk-show-wake").addEventListener("change",e=>{S.showWake=e.target.checked;});
    document.getElementById("chk-show-wind").addEventListener("change",e=>{S.showWind=e.target.checked;});
    document.getElementById("chk-show-field").addEventListener("change",e=>{S.showField=e.target.checked;});

    // ── Eje diagonal (NE-SW / NW-SE) ──
    const axisBtn = document.getElementById("btn-toggle-axis");
    if (axisBtn) {
        const updateAxisLabel = () => {
            axisBtn.textContent = "⟋ Eje: " + S.diagAxis;
            const fa = document.getElementById('foot-axis');
            if (fa) fa.textContent = "Eje " + S.diagAxis;
        };
        updateAxisLabel();
        axisBtn.addEventListener("click", () => {
            S.diagAxis = (S.diagAxis === FFCore.AXIS_NE_SW)
                ? FFCore.AXIS_NW_SE : FFCore.AXIS_NE_SW;
            updateAxisLabel();
        });
    }

    // ── Prototipo físico (Web Serial) ──
    document.getElementById("btn-serial-connect")?.addEventListener("click", connectSerial);
    document.getElementById("btn-serial-disconnect")?.addEventListener("click", disconnectSerial);
    document.getElementById("btn-serial-home")?.addEventListener("click",
        () => serialWrite(FFCore.formatHome()));
    document.getElementById("serial-bind-select")?.addEventListener("change", e => {
        bindTurbine(parseInt(e.target.value, 10));
    });
    setSerialStatus(S.serial.lastStatus);
    refreshSerialUI();

    cvs.addEventListener("mousedown", onDown);
    cvs.addEventListener("mousemove", onMove);
    cvs.addEventListener("mouseup", onUp);
    cvs.addEventListener("mouseleave", onUp);

    document.querySelector('.wind-btn[data-dir="0"]').classList.add("active");
}

function canvasXY(e) {
    const r=cvs.getBoundingClientRect();
    return { mx:e.clientX-r.left, my:e.clientY-r.top };
}


function onDown(e) {
    const {mx,my}=canvasXY(e);
    if (!S.searching) {
        for (let i=0;i<S.turbines.length;i++) {
            if (dist(mx,my,S.turbines[i].x,S.turbines[i].y)<turbR()+8) {
                S.dragTurbine=i; cvs.style.cursor="grabbing"; return;
            }
        }
    }
}

function onMove(e) {
    const {mx,my}=canvasXY(e), t=S.tank;
    if (S.dragTurbine!==null) {
        const turb = S.turbines[S.dragTurbine];
        // En desafío: respetar turbBounds (homeX/homeY fijos ± MOVE_RANGE)
        // Fuera de desafío: usar globalBounds y actualizar home
        const inChallenge = S.chal.phase === 'user_turn';
        const b = inChallenge ? turbBounds(turb) : globalBounds();
        let cx2 = clamp(mx, b.x0, b.x1);
        let cy2 = clamp(my, b.y0, b.y1);
        // Restringir al círculo (no al cuadrado) cuando hay rango de movimiento
        if (inChallenge && turb.homeX !== undefined) {
            const d = dist(cx2, cy2, turb.homeX, turb.homeY);
            if (d > CFG.MOVE_RANGE) {
                const ang = Math.atan2(cy2 - turb.homeY, cx2 - turb.homeX);
                cx2 = turb.homeX + Math.cos(ang) * CFG.MOVE_RANGE;
                cy2 = turb.homeY + Math.sin(ang) * CFG.MOVE_RANGE;
            }
        }
        let blocked = false;
        for (let j=0; j<S.turbines.length; j++) {
            if (j===S.dragTurbine) continue;
            if (violatesSpacing(S.turbines[j].x, S.turbines[j].y, cx2, cy2)) {
                blocked=true; break;
            }
        }
        // Siempre mover la turbina al cursor (dentro de límites/círculo)
        turb.x = cx2; turb.y = cy2;
        turb.phase=null; turb.trail=[];
        if (!blocked) {
            if (!inChallenge) { turb.homeX = cx2; turb.homeY = cy2; }
            turb._dragBlocked = false;
            turb._invalid = false;
        } else {
            turb._dragBlocked = true;
        }
        return;
    }
    // Cursor
    let cur="crosshair";
    if (cur==="crosshair" && !S.searching) {
        for (const tb of S.turbines) {
            if (dist(mx,my,tb.x,tb.y)<turbR()+8) { cur="grab"; break; }
        }
    }
    cvs.style.cursor=cur;
    // Tooltip
    const tip=document.getElementById("canvas-tooltip");
    let found=false;
    for (let i=0;i<S.turbines.length;i++) {
        const tb=S.turbines[i];
        if (dist(mx,my,tb.x,tb.y)<turbR()+8) {
            const ws=windAtRotor(tb.x,tb.y,tb);
            tip.classList.remove("hidden");
            tip.style.left=(mx+15)+"px"; tip.style.top=(my-30)+"px";
            tip.innerHTML=`<b>Turbina ${i+1}</b><br>Voltaje: ${tb.voltage.toFixed(1)}V<br>Viento: ${ws.toFixed(1)} m/s`;
            found=true; break;
        }
    }
    if (!found) tip.classList.add("hidden");
}

function onUp() {
    if (S.dragTurbine!==null) {
        const turb = S.turbines[S.dragTurbine];
        if (turb) {
            if (turb._dragBlocked) {
                // Mover al punto válido más cercano con mínimo desplazamiento
                const nearest = findNearestValid(S.dragTurbine, turb.x, turb.y);
                turb.x = nearest.x;
                turb.y = nearest.y;
                const inChallenge = S.chal.phase === 'user_turn';
                if (!inChallenge) { turb.homeX = nearest.x; turb.homeY = nearest.y; }
            }
            turb._dragBlocked = false;
        }
        S.dragTurbine=null; cvs.style.cursor="crosshair";
    }
}

function updateChallengeLive() {
    if (S.chal.phase !== 'user_turn') return;
    const curScore = calcScore(S.turbines, S.chal.initialPositions);
    const diff     = curScore - S.chal.baselineScore;
    const el = document.getElementById("live-improvement");
    el.textContent = (diff >= 0 ? "+" : "") + diff.toFixed(1) + " pts (" + curScore.toFixed(1) + " pts)";
    el.style.color = diff > 3 ? "#4af06a" : diff > 0 ? "#f0da4a" : "#f06a4a";
}

function updateTurbineList() {
    document.getElementById("turbine-list").innerHTML = S.turbines.map((t,i) => {
        const col=CFG.COL_BLADE[i%CFG.COL_BLADE.length];
        const phaseLabel = t.phase==='scanning'?' [scan]':t.phase==='moving'?' [mov]':t.phase==='refining'?' [ref]':'';
        const boundMark  = (S.serial.boundTurbIdx === i) ? ' 🔗' : '';
        return `<div class="list-item"><span style="color:${col}">● T${i+1}${phaseLabel}${boundMark}</span><span class="voltage">${(t.voltage||0).toFixed(1)}V</span></div>`;
    }).join("");
    refreshSerialUI();
}

// ===================== INIT =====================
function init() {
    resize();
    window.addEventListener("resize", resize);
    setupUI();
    initParticles();
    spawnTurbine();
    requestAnimationFrame(loop);
}
init();
})();
