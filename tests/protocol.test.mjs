// Integration test for the serial protocol.
// Spawns firmware/mock/mock-esp32.mjs as a child process, drives it
// through the same protocol the real ESP32 implements, and asserts
// command/response round-trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
    formatHome, formatMove, formatStatus, formatStop,
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
            // skip 'log' and other intermediate types
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

test('? query returns POS 0 after boot home', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatStatus());
        const msg = await m.waitFor('pos');
        assert.equal(msg.value, 0);
    } finally { m.kill(); }
});

test('M moves and echoes POS with the requested per-mille', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatMove(750));
        const msg = await m.waitFor('pos');
        assert.equal(msg.value, 750);
    } finally { m.kill(); }
});

test('M clamps the requested position client-side via formatMove', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatMove(99999));      // clamps to 1000 in the formatter
        const msg = await m.waitFor('pos');
        assert.equal(msg.value, 1000);
    } finally { m.kill(); }
});

test('firmware-side bad payload yields ERR (raw bypass)', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send('M 99999\n');             // raw, bypassing formatMove
        const msg = await m.nextLine();
        assert.equal(msg.type, 'error');
    } finally { m.kill(); }
});

test('H re-homes and re-emits HOMED', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        m.send(formatMove(500));
        await m.waitFor('pos');
        m.send(formatHome());
        await m.waitFor('homed');
        m.send(formatStatus());
        const status = await m.waitFor('pos');
        assert.equal(status.value, 0);
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

test('multiple sequential moves all echo back in order', async () => {
    const m = startMock();
    try {
        await m.waitFor('ready');
        const targets = [100, 250, 400, 600, 850, 0];
        for (const p of targets) {
            m.send(formatMove(p));
            const msg = await m.waitFor('pos');
            assert.equal(msg.value, p);
        }
    } finally { m.kill(); }
});
