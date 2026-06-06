// Unit tests for src/core.mjs — no DOM, no hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AXIS_NE_SW, AXIS_NW_SE, AXES,
    axisVec, projectToAxis, diagonalScanPoints,
    mapTtoMotor, mapMotorToT,
    formatHome, formatStatus, formatStop, formatMove, formatJog, formatDualMove, formatSingleAsDual,
    MOTOR_CENTER,
    parseLine, makeLineBuffer,
    PROTOCOL_VERSION, MOTOR_MAX, MOTOR_MIN,
} from '../src/core.mjs';

const EPS = 1e-9;

// ===== axisVec =====
test('axisVec: NE-SW points up-right (+x, -y) and is unit length', () => {
    const v = axisVec(AXIS_NE_SW);
    assert.ok(Math.abs(v.dx - Math.SQRT1_2) < EPS);
    assert.ok(Math.abs(v.dy + Math.SQRT1_2) < EPS);
    assert.ok(Math.abs(Math.hypot(v.dx, v.dy) - 1) < EPS);
});

test('axisVec: NW-SE points down-right (+x, +y) and is unit length', () => {
    const v = axisVec(AXIS_NW_SE);
    assert.ok(Math.abs(v.dx - Math.SQRT1_2) < EPS);
    assert.ok(Math.abs(v.dy - Math.SQRT1_2) < EPS);
    assert.ok(Math.abs(Math.hypot(v.dx, v.dy) - 1) < EPS);
});

test('axisVec: unknown axis throws', () => {
    assert.throws(() => axisVec('BOGUS'));
});

test('AXES list contains both diagonals', () => {
    assert.deepEqual([...AXES].sort(), [AXIS_NE_SW, AXIS_NW_SE].sort());
});

// ===== projectToAxis =====
test('projectToAxis: home maps to home with t=0', () => {
    const p = projectToAxis(100, 100, 100, 100, AXIS_NE_SW);
    assert.ok(Math.abs(p.x - 100) < EPS);
    assert.ok(Math.abs(p.y - 100) < EPS);
    assert.ok(Math.abs(p.t) < EPS);
});

test('projectToAxis: perpendicular-only displacement collapses to home', () => {
    // For NE-SW axis (1,-1)/√2, the perpendicular is (1,1)/√2.
    // Move by (+10,+10) → dot with (1,-1)/√2 = 0 → t=0.
    const p = projectToAxis(0, 0, 10, 10, AXIS_NE_SW);
    assert.ok(Math.abs(p.t) < EPS);
    assert.ok(Math.abs(p.x) < EPS);
    assert.ok(Math.abs(p.y) < EPS);
});

test('projectToAxis: along-axis displacement preserves length, no perpendicular leak', () => {
    // Point at home + 5*axis on NW-SE
    const v = axisVec(AXIS_NW_SE);
    const px = 50 + 5 * v.dx, py = 50 + 5 * v.dy;
    const r = projectToAxis(50, 50, px, py, AXIS_NW_SE);
    assert.ok(Math.abs(r.t - 5) < EPS);
    assert.ok(Math.abs(r.x - px) < EPS);
    assert.ok(Math.abs(r.y - py) < EPS);
});

test('projectToAxis: clamps t to ±maxRange', () => {
    const r = projectToAxis(0, 0, 1000, -1000, AXIS_NE_SW, 100);
    // Raw t would be (1000*√1/2 + (-1000)*(-√1/2)) = 1000*√2 ≈ 1414, clamp to 100
    assert.ok(Math.abs(r.t - 100) < EPS);
    const v = axisVec(AXIS_NE_SW);
    assert.ok(Math.abs(r.x - 100 * v.dx) < EPS);
    assert.ok(Math.abs(r.y - 100 * v.dy) < EPS);
});

test('projectToAxis: negative direction also clamped', () => {
    const r = projectToAxis(0, 0, -1000, 1000, AXIS_NE_SW, 100);
    assert.ok(Math.abs(r.t + 100) < EPS);
});

test('projectToAxis: output is always exactly on the axis line', () => {
    // Pick a noisy point, project, verify perpendicular component to axis is 0.
    const axis = AXIS_NW_SE;
    const v = axisVec(axis);
    const perpX = -v.dy, perpY = v.dx; // perpendicular unit
    const home = { x: 200, y: 150 };
    const noisy = { x: 280, y: 90 };
    const p = projectToAxis(home.x, home.y, noisy.x, noisy.y, axis);
    const dx = p.x - home.x, dy = p.y - home.y;
    const perpDot = dx * perpX + dy * perpY;
    assert.ok(Math.abs(perpDot) < 1e-8, `expected on-axis, got perpDot=${perpDot}`);
});

// ===== diagonalScanPoints =====
test('diagonalScanPoints: n points span [-range,+range] evenly', () => {
    const pts = diagonalScanPoints(0, 0, AXIS_NE_SW, 100, 5);
    assert.equal(pts.length, 5);
    assert.ok(Math.abs(pts[0].t + 100) < EPS);
    assert.ok(Math.abs(pts[4].t - 100) < EPS);
    assert.ok(Math.abs(pts[2].t) < EPS);
});

test('diagonalScanPoints: all points lie on axis', () => {
    const pts = diagonalScanPoints(50, 50, AXIS_NW_SE, 80, 9);
    const v = axisVec(AXIS_NW_SE);
    const perpX = -v.dy, perpY = v.dx;
    for (const p of pts) {
        const dx = p.x - 50, dy = p.y - 50;
        const perpDot = dx * perpX + dy * perpY;
        assert.ok(Math.abs(perpDot) < 1e-8);
    }
});

test('diagonalScanPoints: n<2 throws', () => {
    assert.throws(() => diagonalScanPoints(0, 0, AXIS_NE_SW, 100, 1));
});

// ===== motor mapping =====
test('mapTtoMotor: t=0 → 500 (center)', () => {
    assert.equal(mapTtoMotor(0, 100), 500);
});

test('mapTtoMotor: t=-range → 0', () => {
    assert.equal(mapTtoMotor(-100, 100), 0);
});

test('mapTtoMotor: t=+range → 1000', () => {
    assert.equal(mapTtoMotor(100, 100), 1000);
});

test('mapTtoMotor: clamps out-of-range t', () => {
    assert.equal(mapTtoMotor(500, 100), 1000);
    assert.equal(mapTtoMotor(-500, 100), 0);
});

test('mapTtoMotor: range<=0 throws', () => {
    assert.throws(() => mapTtoMotor(0, 0));
    assert.throws(() => mapTtoMotor(0, -10));
});

test('mapMotorToT: round-trip with mapTtoMotor', () => {
    const range = 120;
    for (const t of [-120, -60, 0, 30, 60, 120]) {
        const motor = mapTtoMotor(t, range);
        const back  = mapMotorToT(motor, range);
        assert.ok(Math.abs(back - t) <= (2 * range) / 1000 + EPS,
            `t=${t}, motor=${motor}, back=${back}`);
    }
});

test('mapMotorToT: clamps motor input', () => {
    assert.ok(Math.abs(mapMotorToT(-50, 100) - (-100)) < EPS);
    assert.ok(Math.abs(mapMotorToT(9999, 100) - 100) < EPS);
});

// ===== protocol formatters =====
test('formatHome / formatStatus / formatStop end with newline', () => {
    assert.equal(formatHome(),   'H\n');
    assert.equal(formatStatus(), '?\n');
    assert.equal(formatStop(),   'S\n');
});

test('formatJog: L/R/T/D commands', () => {
    assert.equal(formatJog('L'), 'J L\n');
    assert.equal(formatJog('r'), 'J R\n');
    assert.equal(formatJog('T'), 'J T\n');
    assert.equal(formatJog('d'), 'J D\n');
    assert.throws(() => formatJog('X'));
});

test('formatMove: rounds and clamps', () => {
    assert.equal(formatMove(0),       'M 0\n');
    assert.equal(formatMove(500),     'M 500\n');
    assert.equal(formatMove(1000),    'M 1000\n');
    assert.equal(formatMove(1500),    'M 1000\n');
    assert.equal(formatMove(-50),     'M 0\n');
    assert.equal(formatMove(499.6),   'M 500\n');
});

test('formatMove: non-finite throws', () => {
    assert.throws(() => formatMove(NaN));
    assert.throws(() => formatMove(Infinity));
});

// ===== parseLine =====
test('parseLine: READY / HOMED', () => {
    assert.deepEqual(parseLine('READY'),  { type: 'ready' });
    assert.deepEqual(parseLine('HOMED'),  { type: 'homed' });
});

test('parseLine: trims surrounding whitespace and \\r', () => {
    assert.deepEqual(parseLine('  READY\r'), { type: 'ready' });
});

test('parseLine: POS with integer value', () => {
    assert.deepEqual(parseLine('POS 750'), { type: 'pos', value: 750 });
});

test('parseLine: POS with malformed payload', () => {
    const p = parseLine('POS abc');
    assert.equal(p.type, 'error');
});

test('parseLine: ERR and LOG', () => {
    assert.deepEqual(parseLine('ERR not homed'), { type: 'error', msg: 'not homed' });
    assert.deepEqual(parseLine('LOG starting'),  { type: 'log',   msg: 'starting' });
});

test('parseLine: empty is type=empty', () => {
    assert.deepEqual(parseLine(''),    { type: 'empty' });
    assert.deepEqual(parseLine('   '), { type: 'empty' });
});

test('parseLine: unknown returns raw', () => {
    const p = parseLine('XYZZY');
    assert.equal(p.type, 'unknown');
    assert.equal(p.raw, 'XYZZY');
});

// ===== makeLineBuffer =====
test('makeLineBuffer: yields whole lines and buffers partial', () => {
    const buf = makeLineBuffer();
    assert.deepEqual(buf.push('READ'), []);
    assert.deepEqual(buf.push('Y\nPO'), ['READY']);
    assert.deepEqual(buf.push('S 100\n'), ['POS 100']);
    assert.deepEqual(buf.push('A\nB\nC'), ['A', 'B']);
    assert.equal(buf.pending, 'C');
});

test('makeLineBuffer: flush returns leftover', () => {
    const buf = makeLineBuffer();
    buf.push('PARTIAL');
    assert.deepEqual(buf.flush(), ['PARTIAL']);
    assert.deepEqual(buf.flush(), []);
});

// ===== constants =====
test('protocol constants are sane', () => {
    assert.equal(MOTOR_MIN, 0);
    assert.equal(MOTOR_MAX, 1000);
    assert.equal(MOTOR_CENTER, 500);
    assert.equal(typeof PROTOCOL_VERSION, 'number');
    assert.equal(PROTOCOL_VERSION, 2);
});

// ===== formatDualMove =====
test('formatDualMove: basic dual command', () => {
    assert.equal(formatDualMove(500, 500), 'M 500 500\n');
});

test('formatDualMove: clamps and rounds', () => {
    assert.equal(formatDualMove(0, 1000), 'M 0 1000\n');
    assert.equal(formatDualMove(1000, 0), 'M 1000 0\n');
    assert.equal(formatDualMove(1500, -50), 'M 1000 0\n');
    assert.equal(formatDualMove(499.6, 600.4), 'M 500 600\n');
});

test('formatDualMove: non-finite throws', () => {
    assert.throws(() => formatDualMove(NaN, 500));
    assert.throws(() => formatDualMove(500, Infinity));
});

test('formatSingleAsDual: converts single to dual (p, 1000-p)', () => {
    assert.equal(formatSingleAsDual(0), 'M 0 1000\n');
    assert.equal(formatSingleAsDual(500), 'M 500 500\n');
    assert.equal(formatSingleAsDual(750), 'M 750 250\n');
    assert.equal(formatSingleAsDual(1000), 'M 1000 0\n');
});

// ===== parseLine: dual POS =====
test('parseLine: POS with two values returns valueA and valueB', () => {
    const p = parseLine('POS 750 250');
    assert.equal(p.type, 'pos');
    assert.equal(p.valueA, 750);
    assert.equal(p.valueB, 250);
});

test('parseLine: POS with single value still works (backward compat)', () => {
    const p = parseLine('POS 750');
    assert.equal(p.type, 'pos');
    assert.equal(p.value, 750);
    assert.equal(p.valueA, undefined);
    assert.equal(p.valueB, undefined);
});

test('parseLine: POS with two bad values yields error', () => {
    const p = parseLine('POS abc 250');
    assert.equal(p.type, 'error');
});
