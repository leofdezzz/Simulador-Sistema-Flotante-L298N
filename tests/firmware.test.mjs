// Firmware static checks for firmware/arduino/FloatingFarm/FloatingFarm.ino
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT     = resolve(__dirname, '..');
const INO_PATH = resolve(ROOT, 'firmware/arduino/FloatingFarm/FloatingFarm.ino');
const SKETCH_DIR = resolve(ROOT, 'firmware/arduino/FloatingFarm');

function commandAvailable(cmd) {
    try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${which} ${cmd}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('firmware: FloatingFarm.ino exists', () => {
    assert.ok(existsSync(INO_PATH), `missing ${INO_PATH}`);
});

test('firmware: balanced braces and parens', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    let stripped = src
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");
    const open  = (stripped.match(/\{/g) || []).length;
    const close = (stripped.match(/\}/g) || []).length;
    const popen  = (stripped.match(/\(/g) || []).length;
    const pclose = (stripped.match(/\)/g) || []).length;
    assert.equal(open, close, `unbalanced braces: ${open} '{' vs ${close} '}'`);
    assert.equal(popen, pclose, `unbalanced parens: ${popen} '(' vs ${pclose} ')'`);
});

test('firmware: implements all protocol commands (H, M, J, ?, S)', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /==\s*"H"/,         'missing H handler');
    assert.match(src, /startsWith\("M "\)/, 'missing M handler');
    assert.match(src, /startsWith\("J "\)/, 'missing J handler');
    assert.match(src, /==\s*"\?"/,        'missing ? handler');
    assert.match(src, /==\s*"S"/,         'missing S handler');
});

test('firmware: emits all expected response types', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /"READY"/, 'missing READY');
    assert.match(src, /"HOMED"/, 'missing HOMED');
    assert.match(src, /"POS "/,  'missing POS');
    assert.match(src, /"ERR "/,  'missing ERR');
    assert.match(src, /"LOG "/,  'missing LOG');
});

test('firmware: setup() assumes center on boot (no endstops)', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    const setupMatch = src.match(/void\s+setup\s*\(\s*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(setupMatch, 'no setup() block found');
    assert.match(setupMatch[0], /assumeCenter\s*\(\s*\)/, 'setup() should assume center');
});

test('firmware: serial baud is 115200', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /Serial\.begin\s*\(\s*115200\s*\)/);
});

test('firmware: defines L298N IN pins for A and B (PWM on IN, no EN)', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /PIN_A_IN1/, 'missing PIN_A_IN1');
    assert.match(src, /PIN_A_IN2/, 'missing PIN_A_IN2');
    assert.match(src, /PIN_B_IN3/, 'missing PIN_B_IN3');
    assert.match(src, /PIN_B_IN4/, 'missing PIN_B_IN4');
    assert.doesNotMatch(src, /PIN_A_EN|PIN_B_EN/, 'this board has no ENA/ENB control');
});

test('firmware: defines four manual button pins', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /PIN_BTN_LEFT/,  'missing PIN_BTN_LEFT');
    assert.match(src, /PIN_BTN_RIGHT/, 'missing PIN_BTN_RIGHT');
    assert.match(src, /PIN_BTN_TENSE/, 'missing PIN_BTN_TENSE');
    assert.match(src, /PIN_BTN_LOOSE/, 'missing PIN_BTN_LOOSE');
});

test('firmware: drives two DC motors via L298N (PWM + direction)', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /driveMotor\s*\(/, 'missing driveMotor helper');
    assert.match(src, /analogWrite\s*\(/, 'should use PWM (analogWrite)');
    assert.doesNotMatch(src, /AccelStepper/, 'DC motor firmware should not use AccelStepper');
});

test('firmware: uses dual POS response format', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /"POS "/, 'missing POS response');
    assert.match(src, /g_posA[\s\S]*g_posB/, 'should report both motor positions');
});

test('firmware: polls manual buttons in loop', async () => {
    const src = await readFile(INO_PATH, 'utf8');
    assert.match(src, /pollButtons\s*\(\s*\)/, 'loop should poll buttons');
    assert.match(src, /INPUT_PULLUP/, 'buttons use internal pull-ups');
});

test('firmware: arduino-cli compile (optional)', async (t) => {
    if (!commandAvailable('arduino-cli')) {
        t.skip('arduino-cli not on PATH');
        return;
    }
    const res = spawnSync('arduino-cli',
        ['compile', '--fqbn', 'esp32:esp32:esp32', SKETCH_DIR],
        { encoding: 'utf8' });
    if (res.status !== 0) {
        console.error(res.stdout); console.error(res.stderr);
    }
    assert.equal(res.status, 0, 'arduino-cli compile failed');
});
