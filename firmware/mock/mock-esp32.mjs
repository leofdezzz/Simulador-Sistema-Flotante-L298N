#!/usr/bin/env node
// ============================================================
// mock-esp32.mjs
// A Node process that speaks the floating-farm serial protocol
// over stdio. Emulates dual 28BYJ-48 motors (protocol v2).
//
// Boot: assumes center (500/500), no endstops.
// Commands: H / M / J L|R|T|D / ? / S
// ============================================================

import readline from 'node:readline';

const ARGS = new Map();
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) ARGS.set(m[1], m[2]);
}

const BOOT_DELAY_MS   = Number(ARGS.get('boot-delay')   ?? 20);
const CENTER_TIME_MS  = Number(ARGS.get('center-time') ?? 15);
const CENTER_POS      = 500;
const JOG_STEP        = 8;

let ready   = false;
let posA    = -1;
let posB    = -1;
let stopped = false;

function send(line) {
    process.stdout.write(line + '\n');
}

function clampPm(p) {
    return Math.max(0, Math.min(1000, p));
}

function bootCenter() {
    send('LOG mock-esp32 booting');
    setTimeout(() => {
        send('LOG assumed center');
        setTimeout(() => {
            ready = true;
            posA = CENTER_POS;
            posB = CENTER_POS;
            stopped = false;
            send('HOMED');
            send('READY');
        }, CENTER_TIME_MS);
    }, BOOT_DELAY_MS);
}

function jogDelta(dA, dB) {
    posA = clampPm(posA + dA);
    posB = clampPm(posB + dB);
}

function handleJog(dir) {
    switch (dir.toUpperCase()) {
        case 'L': jogDelta(-JOG_STEP,  JOG_STEP); break;
        case 'R': jogDelta( JOG_STEP, -JOG_STEP); break;
        case 'T': jogDelta(-JOG_STEP, -JOG_STEP); break;
        case 'D': jogDelta( JOG_STEP,  JOG_STEP); break;
        default: return false;
    }
    return true;
}

function handle(line) {
    const l = line.trim();
    if (!l) return;
    if (l === 'H') {
        send('LOG centering');
        setTimeout(() => {
            posA = CENTER_POS;
            posB = CENTER_POS;
            stopped = false;
            ready = true;
            send('HOMED');
            send(`POS ${posA} ${posB}`);
        }, CENTER_TIME_MS);
        return;
    }
    if (l === '?') {
        send(`POS ${posA} ${posB}`);
        return;
    }
    if (l === 'S') {
        stopped = true;
        send('LOG stopped');
        return;
    }
    if (l.startsWith('J ')) {
        if (!ready) { send('ERR not ready'); return; }
        const dir = l.slice(2).trim();
        if (dir.length !== 1 || !handleJog(dir)) {
            send(`ERR bad jog: ${l}`);
            return;
        }
        stopped = false;
        send(`POS ${posA} ${posB}`);
        return;
    }
    if (l.startsWith('M ')) {
        if (!ready) { send('ERR not ready'); return; }
        const payload = l.slice(2).trim();
        const parts = payload.split(/\s+/);
        if (parts.length === 2) {
            const nA = Number.parseInt(parts[0], 10);
            const nB = Number.parseInt(parts[1], 10);
            if (!Number.isFinite(nA) || !Number.isFinite(nB) ||
                nA < 0 || nA > 1000 || nB < 0 || nB > 1000) {
                send(`ERR bad pos: ${payload}`);
                return;
            }
            stopped = false;
            posA = nA;
            posB = nB;
            send(`POS ${posA} ${posB}`);
            return;
        }
        const n = Number.parseInt(payload, 10);
        if (!Number.isFinite(n) || n < 0 || n > 1000) {
            send(`ERR bad pos: ${payload}`);
            return;
        }
        stopped = false;
        posA = n;
        posB = 1000 - n;
        send(`POS ${posA} ${posB}`);
        return;
    }
    send(`ERR unknown cmd: ${l}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', handle);
rl.on('close', () => process.exit(0));

bootCenter();
