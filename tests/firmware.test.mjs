// Firmware static checks + optional PlatformIO compile.
//
// The static checks always run and guard against regressions in the
// .cpp source / platformio.ini regardless of toolchain availability.
// The real compile is only attempted if `pio` or `arduino-cli` is on
// PATH; otherwise it is skipped (not failed) so CI on developer
// machines without ESP toolchain still goes green.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const FW_DIR    = resolve(ROOT, 'firmware/esp32');
const INO_PATH  = resolve(ROOT, 'firmware/arduino/FloatingFarm/FloatingFarm.ino');
const CPP_PATH  = resolve(FW_DIR, 'src/main.cpp');
const PIO_INI   = resolve(FW_DIR, 'platformio.ini');
const FW_SRC    = INO_PATH;

function commandAvailable(cmd) {
    try {
        const which = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${which} ${cmd}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('firmware: source files exist', () => {
    assert.ok(existsSync(INO_PATH), `missing ${INO_PATH}`);
    assert.ok(existsSync(CPP_PATH), `missing ${CPP_PATH}`);
    assert.ok(existsSync(PIO_INI),  `missing ${PIO_INI}`);
});

test('firmware: platformio.ini declares esp32dev env (no external libs)', async () => {
    const ini = await readFile(PIO_INI, 'utf8');
    assert.match(ini, /\[env:esp32dev\]/);
    assert.match(ini, /board\s*=\s*esp32dev/);
    assert.match(ini, /framework\s*=\s*arduino/);
    assert.match(ini, /monitor_speed\s*=\s*115200/);
    assert.doesNotMatch(ini, /AccelStepper/i, 'DC motors do not need AccelStepper');
});

test('firmware: main.cpp has balanced braces and parens', async () => {
    const src = await readFile(FW_SRC, 'utf8');
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
    const src = await readFile(FW_SRC, 'utf8');
    assert.match(src, /==\s*"H"/,         'missing H handler');
    assert.match(src, /startsWith\("M "\)/, 'missing M handler');
    assert.match(src, /startsWith\("J "\)/, 'missing J handler');
    assert.match(src, /==\s*"\?"/,        'missing ? handler');
    assert.match(src, /==\s*"S"/,         'missing S handler');
});

test('firmware: emits all expected response types', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    assert.match(src, /"READY"/, 'missing READY');
    assert.match(src, /"HOMED"/, 'missing HOMED');
    assert.match(src, /"POS "/,  'missing POS');
    assert.match(src, /"ERR "/,  'missing ERR');
    assert.match(src, /"LOG "/,  'missing LOG');
});

test('firmware: setup() assumes center on boot (no endstops)', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    const setupMatch = src.match(/void\s+setup\s*\(\s*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(setupMatch, 'no setup() block found');
    assert.match(setupMatch[0], /assumeCenter\s*\(\s*\)/, 'setup() should assume center');
});

test('firmware: serial baud is 115200', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    assert.match(src, /Serial\.begin\s*\(\s*115200\s*\)/);
});

test('firmware: defines L298N pins (EN + IN for A and B)', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    assert.match(src, /PIN_A_EN/,  'missing PIN_A_EN (ENA)');
    assert.match(src, /PIN_A_IN1/, 'missing PIN_A_IN1');
    assert.match(src, /PIN_A_IN2/, 'missing PIN_A_IN2');
    assert.match(src, /PIN_B_EN/,  'missing PIN_B_EN (ENB)');
    assert.match(src, /PIN_B_IN3/, 'missing PIN_B_IN3');
    assert.match(src, /PIN_B_IN4/, 'missing PIN_B_IN4');
});

test('firmware: defines four manual button pins', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    assert.match(src, /PIN_BTN_LEFT/,  'missing PIN_BTN_LEFT');
    assert.match(src, /PIN_BTN_RIGHT/, 'missing PIN_BTN_RIGHT');
    assert.match(src, /PIN_BTN_TENSE/, 'missing PIN_BTN_TENSE');
    assert.match(src, /PIN_BTN_LOOSE/, 'missing PIN_BTN_LOOSE');
});

test('firmware: drives two DC motors via L298N (PWM + direction)', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    assert.match(src, /driveMotor\s*\(/, 'missing driveMotor helper');
    assert.match(src, /analogWrite\s*\(/, 'should use PWM (analogWrite) on EN pins');
    assert.doesNotMatch(src, /AccelStepper/, 'DC motor firmware should not use AccelStepper');
});

test('firmware: uses dual POS response format', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    // The firmware should respond with "POS <pA> <pB>" (two values)
    assert.match(src, /"POS "/, 'missing POS response');
    assert.match(src, /g_posA[\s\S]*g_posB/, 'should report both motor positions');
});

test('firmware: polls manual buttons in loop', async () => {
    const src = await readFile(FW_SRC, 'utf8');
    assert.match(src, /pollButtons\s*\(\s*\)/, 'loop should poll buttons');
    assert.match(src, /INPUT_PULLUP/, 'buttons use internal pull-ups');
});

// ---------- Real compile, only if a toolchain is available ----------
test('firmware: PlatformIO compile', async (t) => {
    if (!commandAvailable('pio')) {
        t.skip('pio not on PATH — install PlatformIO to enable this test');
        return;
    }
    const res = spawnSync('pio', ['run'], { cwd: FW_DIR, encoding: 'utf8' });
    if (res.status !== 0) {
        console.error(res.stdout); console.error(res.stderr);
    }
    assert.equal(res.status, 0, 'pio run failed');
});

test('firmware: arduino-cli compile (fallback)', async (t) => {
    if (commandAvailable('pio')) {
        t.skip('PlatformIO test will cover compilation');
        return;
    }
    if (!commandAvailable('arduino-cli')) {
        t.skip('neither pio nor arduino-cli on PATH');
        return;
    }
    const res = spawnSync('arduino-cli',
        ['compile', '--fqbn', 'esp32:esp32:esp32', CPP_PATH],
        { encoding: 'utf8' });
    if (res.status !== 0) {
        console.error(res.stdout); console.error(res.stderr);
    }
    assert.equal(res.status, 0, 'arduino-cli compile failed');
});