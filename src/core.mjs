// ============================================================
// Floating Farm — core pure logic
// Shared by the browser simulator and the Node test suite.
// No DOM, no canvas, no globals. ES module.
// ============================================================

// --- Diagonal axes -------------------------------------------------
// Canvas convention: y grows downward. North = -y, South = +y.
// NE-SW: NE = (+x, -y), SW = (-x, +y) → unit vector (+1, -1)/√2
// NW-SE: NW = (-x, -y), SE = (+x, +y) → unit vector (+1, +1)/√2
export const AXIS_NE_SW = 'NE-SW';
export const AXIS_NW_SE = 'NW-SE';
export const AXES = [AXIS_NE_SW, AXIS_NW_SE];

const SQRT1_2 = Math.SQRT1_2;

export function axisVec(axis) {
    if (axis === AXIS_NE_SW) return { dx: SQRT1_2, dy: -SQRT1_2 };
    if (axis === AXIS_NW_SE) return { dx: SQRT1_2, dy:  SQRT1_2 };
    throw new Error(`unknown axis: ${axis}`);
}

// Project (x,y) onto the line through (homeX, homeY) along `axis`.
// Returns { x, y, t } where t is the signed scalar offset from home along
// the axis. If maxRange is finite, t is clamped to [-maxRange, +maxRange].
export function projectToAxis(homeX, homeY, x, y, axis, maxRange = Infinity) {
    const a = axisVec(axis);
    const dx = x - homeX, dy = y - homeY;
    let t = dx * a.dx + dy * a.dy;
    if (maxRange !== Infinity) {
        if (t >  maxRange) t =  maxRange;
        if (t < -maxRange) t = -maxRange;
    }
    return { x: homeX + t * a.dx, y: homeY + t * a.dy, t };
}

// Generate N evenly spaced points along the diagonal line, t in [-R, +R].
export function diagonalScanPoints(homeX, homeY, axis, range, n) {
    if (n < 2) throw new Error('n must be >= 2');
    const a = axisVec(axis);
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
        const t = -range + (2 * range) * i / (n - 1);
        pts[i] = { x: homeX + t * a.dx, y: homeY + t * a.dy, t };
    }
    return pts;
}

// --- Motor mapping -----------------------------------------------------
// Map signed t in [-range, +range] to integer motor position in [0..1000].
// 0 = far end of NEGATIVE side, 1000 = far end of POSITIVE side, 500 = home.
export function mapTtoMotor(t, range) {
    if (range <= 0) throw new Error('range must be > 0');
    const clamped = Math.max(-range, Math.min(range, t));
    return Math.round(((clamped + range) / (2 * range)) * 1000);
}

export function mapMotorToT(pos, range) {
    if (range <= 0) throw new Error('range must be > 0');
    const clamped = Math.max(0, Math.min(1000, pos));
    return (clamped / 1000) * (2 * range) - range;
}

// --- Serial protocol ---------------------------------------------------
// Sim → ESP32:
//   "H\n"            — move both motors to center (500/500 per-mille)
//   "M <pA> <pB>\n"  — move motor A to pA, motor B to pB (0..1000 each)
//   "M <p>\n"        — (legacy) move motor A to p, motor B to (1000 - p)
//   "J L|R|T|D\n"    — jog left/right/tense/loose (one step)
//   "?\n"            — query current positions
//   "S\n"            — stop / disable both motors
// ESP32 → Sim (one message per line, '\n' terminated):
//   "READY"           — boot complete (assumed center, no endstops)
//   "HOMED"           — centered (after H or boot)
//   "POS <pA> <pB>"   — current per-mille positions (motor A, motor B)
//   "ERR <msg>"       — error string
//   "LOG <msg>"       — informational log
export const PROTOCOL_VERSION = 2;
export const MOTOR_MAX = 1000;
export const MOTOR_MIN = 0;

export const MOTOR_CENTER = 500;

export function formatHome()   { return 'H\n'; }
export function formatStatus() { return '?\n'; }
export function formatStop()   { return 'S\n'; }

/** @param {'L'|'R'|'T'|'D'} dir left, right, tense (tensar), loose (destensar) */
export function formatJog(dir) {
    const d = String(dir).toUpperCase();
    if (!/^[LRTD]$/.test(d)) throw new Error('jog dir must be L, R, T, or D');
    return `J ${d}\n`;
}

export function formatMove(motorPos) {
    if (!Number.isFinite(motorPos)) throw new Error('motorPos must be finite');
    const p = Math.max(MOTOR_MIN, Math.min(MOTOR_MAX, Math.round(motorPos)));
    return `M ${p}\n`;
}

export function formatDualMove(motorA, motorB) {
    if (!Number.isFinite(motorA) || !Number.isFinite(motorB)) {
        throw new Error('motor positions must be finite');
    }
    const a = Math.max(MOTOR_MIN, Math.min(MOTOR_MAX, Math.round(motorA)));
    const b = Math.max(MOTOR_MIN, Math.min(MOTOR_MAX, Math.round(motorB)));
    return `M ${a} ${b}\n`;
}

export function formatSingleAsDual(p) {
    return formatDualMove(p, MOTOR_MAX - p);
}

// Parse one trimmed line into a typed object.
export function parseLine(line) {
    const l = String(line).trim();
    if (!l) return { type: 'empty' };
    if (l === 'READY')  return { type: 'ready' };
    if (l === 'HOMED')  return { type: 'homed' };
    if (l.startsWith('POS ')) {
        const payload = l.slice(4);
        const parts = payload.split(/\s+/);
        if (parts.length === 2) {
            const a = Number.parseInt(parts[0], 10);
            const b = Number.parseInt(parts[1], 10);
            if (Number.isFinite(a) && Number.isFinite(b)) {
                return { type: 'pos', valueA: a, valueB: b };
            }
            return { type: 'error', msg: `bad POS payload: ${l}` };
        }
        const n = Number.parseInt(payload, 10);
        if (Number.isFinite(n)) return { type: 'pos', value: n };
        return { type: 'error', msg: `bad POS payload: ${l}` };
    }
    if (l.startsWith('ERR ')) return { type: 'error', msg: l.slice(4) };
    if (l.startsWith('LOG ')) return { type: 'log',   msg: l.slice(4) };
    return { type: 'unknown', raw: l };
}

// Stateful chunk → lines splitter. Handles partial lines across reads.
export function makeLineBuffer() {
    let buf = '';
    return {
        push(chunk) {
            buf += String(chunk);
            const lines = buf.split('\n');
            buf = lines.pop();
            return lines;
        },
        flush() { const x = buf; buf = ''; return x ? [x] : []; },
        get pending() { return buf; },
    };
}
