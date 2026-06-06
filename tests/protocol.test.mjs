// Integration test for the serial protocol (v2 — dual motor).
// Spawns firmware/mock/mock-esp32.mjs as a child process, drives it
// through the same protocol the real ESP32 implements, and asserts
// command/response round-trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    formatHome, formatMove, formatStatus, formatStop, formatJog,
    formatDualMove, formatSingleAsDual, MOTOR_CENTER,
    parseLine, makeLineBuffer,
} from '../src/core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PATH = resolve(__dirname, '../firmware/mock/mock-esp32.mjs');

// --- Helper: spawn a mock and provide a small async driver --------
function startMock(extraArgs = []) {
    const child = spawn(process.execPath, [MOCK_PATH, ...extraArgs], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lineBuf = makeLineBuffer();
    const pending = [];      // queued parsed messages
    const waiters = [];      // resolvers waiting for next line

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        for (const raw of lineBuf.push(chunk)) {
            const msg = parseLine(raw);
            if (waiters.length) waiters.shift()(msg);
            else pending.push(msg);
        }
    });

    function nextLine(timeoutMs = 1500) {
        if (pending.length) return Promise.resolve(pending.shift());
        return new Promise((resolveP, rejectP) => {
            const t = setTimeout(() => {
                const idx = waiters.indexOf(resolveP);
                if (idx >= 0) waiters.splice(idx, 1);
                rejectP(new Error('timeout waiting for line'));
            }, timeoutMs);
            waiters.push((msg) => { clearTimeout(t); resolveP(msg); });
        });
    }

    async function waitFor(type, timeoutMs = 1500) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const remaining = deadline - Date.now();
            const msg = await nextLine(remaining);
            if (msg.type === type) return msg;
            if (msg.type === 'error') {
                throw new Error(`got ERR while waiting for ${type}: ${msg.msg}`);
            }
        }
        throw new Error(`timed out waiting for ${type}`);
    }

    function send(line) {
        child.stdin.write(line);
    }

    function kill() {
        try { child.stdin.end(); } catch {}
        try { child.kill(); } catch {}
    }

    return { child, send, nextLine, waitFor, kill };
}

// =====================================================================
test('mock boots and emits HOMED then READY', async () => {
    const m = startMock();
    try {
        await m.waitFor('homed');
        await m.waitFor('ready');
    } finally { m.kill(); }
});

test('? query returns POS at center after boot', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatStatus());
        const msg = await m.waitFor('pos');
        assert.equal(msg.valueA, MOTOR_CENTER);
        assert.equal(msg.valueB, MOTOR_CENTER);
    } finally { m.kill(); }
});

test('M with single value (legacy): motor A = p, motor B = 1000 - p', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatMove(750));
        const msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 750);
        assert.equal(msg.valueB, 250);
    } finally { m.kill(); }
});

test('M with dual values sets both motors independently', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatDualMove(300, 700));
        const msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 300);
        assert.equal(msg.valueB, 700);
    } finally { m.kill(); }
});

test('formatSingleAsDual produces correct dual command', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatSingleAsDual(250));
        const msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 250);
        assert.equal(msg.valueB, 750);
    } finally { m.kill(); }
});

test('M clamps client-side via formatMove', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatMove(99999));
        const msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 1000);
        assert.equal(msg.valueB, 0);
    } finally { m.kill(); }
});

test('formatDualMove clamps client-side', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatDualMove(500, 99999));
        const msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 500);
        assert.equal(msg.valueB, 1000);
    } finally { m.kill(); }
});

test('firmware-side bad payload yields ERR (raw bypass)', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send('M 99999\n');
        const msg = await m.nextLine();
        assert.equal(msg.type, 'error');
    } finally { m.kill(); }
});

test('H recenters and re-emits HOMED', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatMove(800));
        await m.waitFor('pos');
        m.send(formatHome());
        await m.waitFor('homed');
        m.send(formatStatus());
        const status = await m.waitFor('pos');
        assert.equal(status.valueA, MOTOR_CENTER);
        assert.equal(status.valueB, MOTOR_CENTER);
    } finally { m.kill(); }
});

test('J jog commands nudge position', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatJog('R'));
        let msg = await m.waitFor('pos');
        assert.equal(msg.valueA, MOTOR_CENTER + 8);
        assert.equal(msg.valueB, MOTOR_CENTER - 8);
        m.send(formatJog('T'));
        msg = await m.waitFor('pos');
        assert.equal(msg.valueA, MOTOR_CENTER);
        assert.equal(msg.valueB, MOTOR_CENTER - 16);
    } finally { m.kill(); }
});

test('S stop is acknowledged via LOG', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatStop());
        const msg = await m.waitFor('log');
        assert.match(msg.msg, /stop/i);
    } finally { m.kill(); }
});

test('unknown command yields ERR', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send('ZZZ\n');
        const msg = await m.nextLine();
        assert.equal(msg.type, 'error');
    } finally { m.kill(); }
});

test('sequential dual moves all echo back in order', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        const targets = [[100, 900], [250, 750], [500, 500], [800, 200], [0, 1000]];
        for (const [a, b] of targets) {
            m.send(formatDualMove(a, b));
            const msg = await m.waitFor('pos');
            assert.equal(msg.valueA, a);
            assert.equal(msg.valueB, b);
        }
    } finally { m.kill(); }
});

test('mixed legacy and dual commands interleave correctly', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        // Legacy: M 600 → A=600, B=400
        m.send(formatMove(600));
        let msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 600);
        assert.equal(msg.valueB, 400);
        // Dual: M 200 800
        m.send(formatDualMove(200, 800));
        msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 200);
        assert.equal(msg.valueB, 800);
        // Legacy: M 0 → A=0, B=1000
        m.send(formatMove(0));
        msg = await m.waitFor('pos');
        assert.equal(msg.valueA, 0);
        assert.equal(msg.valueB, 1000);
    } finally { m.kill(); }
});

test('dual move with bad second value yields ERR', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send('M 500 abc\n');
        const msg = await m.nextLine();
        assert.equal(msg.type, 'error');
    } finally { m.kill(); }
});