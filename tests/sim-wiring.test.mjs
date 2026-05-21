// Structural test for simulator.js — verifies that the browser-side
// glue actually wires up the diagonal-axis and WebSerial features
// implemented in src/core.mjs. We can't execute simulator.js in Node
// (it touches the DOM, canvas, navigator.serial) but we can assert
// that the relevant symbols and integrations are present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIM_PATH  = resolve(__dirname, '../simulator.js');
const HTML_PATH = resolve(__dirname, '../index.html');

let SIM = null, HTML = null;
test.before(async () => {
    SIM  = await readFile(SIM_PATH,  'utf8');
    HTML = await readFile(HTML_PATH, 'utf8');
});

test('simulator imports FFCore from src/core.mjs', () => {
    assert.match(SIM, /import \* as FFCore from ['"]\.\/src\/core\.mjs['"]/);
});

test('simulator stores diagonal axis in shared state S', () => {
    assert.match(SIM, /diagAxis:\s*FFCore\.AXIS_NE_SW/);
});

test('simulator uses projectToAxis and mapTtoMotor for serial streaming', () => {
    assert.match(SIM, /FFCore\.projectToAxis\(/);
    assert.match(SIM, /FFCore\.mapTtoMotor\(/);
});

test('simulator declares WebSerial connect / disconnect / bind functions', () => {
    assert.match(SIM, /function connectSerial\s*\(/);
    assert.match(SIM, /function disconnectSerial\s*\(/);
    assert.match(SIM, /function bindTurbine\s*\(/);
    assert.match(SIM, /function streamBoundTurbinePosition\s*\(/);
});

test('simulator uses FFCore.formatMove and parseLine for I/O', () => {
    assert.match(SIM, /FFCore\.formatMove\(/);
    assert.match(SIM, /FFCore\.parseLine\(/);
});

test('simulator constrains prepareScan to a 1D diagonal sweep', () => {
    // After our edits, prepareScan must NOT iterate a 2D ix/iy grid.
    const m = SIM.match(/function prepareScan[\s\S]*?\n\}/);
    assert.ok(m, 'prepareScan function not found');
    assert.doesNotMatch(m[0], /for\s*\(\s*let\s+ix\s*=\s*0;[\s\S]*?for\s*\(\s*let\s+iy\s*=\s*0;/,
        'prepareScan still contains a 2D grid loop — should be 1D along the axis');
    assert.match(m[0], /currentAxisVec\(\)/);
    assert.match(m[0], /effectiveAxisRange\(/);
});

test('simulator update() pumps the bound turbine position to serial', () => {
    // update() must invoke streamBoundTurbinePosition() so movement reaches the motor.
    const m = SIM.match(/function update\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    assert.ok(m, 'update() not found');
    assert.match(m[0], /streamBoundTurbinePosition\s*\(\s*\)/);
});

test('throttling: position is not sent more than once per 50 ms', () => {
    // Look for the explicit ~20 Hz throttle in streamBoundTurbinePosition.
    assert.match(SIM, /now\s*-\s*S\.serial\.lastSendT\s*<\s*50/);
});

// ----- HTML / UI wiring -----
test('index.html exposes serial controls expected by simulator.js', () => {
    for (const id of [
        'btn-serial-connect',
        'btn-serial-disconnect',
        'btn-serial-home',
        'serial-bind-select',
        'serial-status',
        'btn-toggle-axis',
    ]) {
        assert.ok(HTML.includes(`id="${id}"`), `index.html missing element id="${id}"`);
    }
});

test('index.html loads simulator.js as an ES module', () => {
    assert.match(HTML, /<script\s+type="module"\s+src="simulator\.js\?v=\d+"/);
});
