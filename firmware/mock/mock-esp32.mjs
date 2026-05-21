#!/usr/bin/env node
// ============================================================
// mock-esp32.mjs
// A Node process that speaks the floating-farm serial protocol
// over stdio. Behaves like the real ESP32 firmware for tests
// (no motor, no GPIO — just protocol fidelity).
//
// Boot sequence: LOG → HOMED → READY
// Then accepts H / M <p> / ? / S commands.
// ============================================================

import readline from 'node:readline';

const ARGS = new Map();
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) ARGS.set(m[1], m[2]);
}

const BOOT_DELAY_MS  = Number(ARGS.get('boot-delay')  ?? 20);
const HOMING_TIME_MS = Number(ARGS.get('homing-time') ?? 30);

let homed = false;
let pos = -1;          // unknown until homed
let stopped = false;

function send(line) {
    process.stdout.write(line + '\n');
}

function bootHome() {
    send('LOG mock-esp32 booting');
    setTimeout(() => {
        send('LOG homing');
        setTimeout(() => {
            homed = true;
            pos = 0;
            stopped = false;
            send('HOMED');
            send('READY');
        }, HOMING_TIME_MS);
    }, BOOT_DELAY_MS);
}

function handle(line) {
    const l = line.trim();
    if (!l) return;
    if (l === 'H') {
        homed = false; pos = -1;
        send('LOG homing');
        setTimeout(() => {
            homed = true; pos = 0; stopped = false;
            send('HOMED');
        }, HOMING_TIME_MS);
        return;
    }
    if (l === '?') {
        send(`POS ${pos}`);
        return;
    }
    if (l === 'S') {
        stopped = true;
        send('LOG stopped');
        return;
    }
    if (l.startsWith('M ')) {
        if (!homed) { send('ERR not homed'); return; }
        const n = Number.parseInt(l.slice(2).trim(), 10);
        if (!Number.isFinite(n) || n < 0 || n > 1000) {
            send(`ERR bad pos: ${l.slice(2)}`);
            return;
        }
        stopped = false;
        pos = n;
        send(`POS ${pos}`);
        return;
    }
    send(`ERR unknown cmd: ${l}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', handle);
rl.on('close', () => process.exit(0));

bootHome();
