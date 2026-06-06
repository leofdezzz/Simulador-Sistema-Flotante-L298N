# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Run / Develop

Vanilla JS + Canvas, no runtime deps. Serve statically (must NOT use `file://` — `type="module"` and Web Serial need a real origin):

```bash
python -m http.server 3000
# or:
npm run serve
# open http://localhost:3000 in Chrome/Edge (Web Serial is Chromium-only)
```

Cache buster: `index.html` loads JS bundles — bump the `v=` query whenever JS changes.

### Tests

```bash
npm test          # node --test on all tests/**/*.test.mjs
```

Coverage: pure-logic unit tests (`tests/core.test.mjs`), serial protocol integration against a Node mock ESP32 (`tests/protocol.test.mjs`, spawns `firmware/mock/mock-esp32.mjs`), firmware static checks + optional PlatformIO compile (`tests/firmware.test.mjs` — compile step is skipped when `pio` / `arduino-cli` is not on PATH; this is *not* a failure).

### Firmware

```bash
npm run firmware:build      # pio run -d firmware/esp32
npm run firmware:upload     # pio run -d firmware/esp32 -t upload
npm run firmware:monitor    # pio device monitor -b 115200
```

No linter.

## File Layout

- `index.html` — markup, DOM ids the JS depends on (canvas, controls, HUD, serial section).
- `app.jsx` — React UI layer: state, controls, panels, PrototypePanel (dual motor UI).
- `sim.jsx` — Canvas rendering engine: particles, wakes, turbines, search animation. Exposes `SimEngine`, `CFG`, `axisVec`, `turbinePos`, `makeTurbine`, `windAtRotor`, `turbinePower` as globals.
- `src/core.mjs` — pure logic shared with Node tests: diagonal axis math (`projectToAxis`, `axisVec`), motor mapping (`mapTtoMotor`), serial protocol formatters (`formatMove`, `formatDualMove`, `formatSingleAsDual`, `parseLine`, `makeLineBuffer`). Protocol v2 (dual motor). No DOM, no canvas.
- `firmware/arduino/FloatingFarm/FloatingFarm.ino` — canonical Arduino IDE sketch. Drives 2× DC motors (JGB-37) via an L298N (PWM on EN + direction on IN pins). No endstops; assumes center at boot; 4 manual buttons. Open-loop time-based position estimate. Speaks serial protocol v2.
- `firmware/esp32/` — PlatformIO mirror (`platformio.ini` + `src/main.cpp`, kept in sync with the .ino). No external libs.
- `firmware/mock/mock-esp32.mjs` — Node process that mimics the dual-motor firmware over stdio for the protocol integration test.
- `tests/` — `node --test` suites.
- `docs/HARDWARE.md` — BOM, ESP32 pinout (L298N + JGB-37), wiring diagram, usage flow.
- `style.css` — UI styling.
- `tweaks-panel.jsx` — Developer tweaks panel for theme/customization.
- `README.md` — physics model derivation (Jensen/Park wake, wind field, power law, search algorithm).

## Architecture

Two-file React + Canvas architecture:

- `app.jsx` — React state management, UI, event handlers. Owns `turbines`, `windDeg`, `axis`, `serialStatus`, etc.
- `sim.jsx` — Pure canvas rendering engine. `SimEngine` class with `step(dt, state)` and `render(state)`. No React dependency.

### Dual-motor prototype system

The physical prototype uses **two DC gear motors (JGB-37)** driven by a single **L298N** dual H-bridge, in opposite corners of the tank. They work in coordinated pairs:

- **Motor A** (corner 1): position `pA ∈ [0..1000]`, 0 = retracted, 1000 = fully extended.
- **Motor B** (corner 2): position `pB ∈ [0..1000]`.
- To move along the diagonal: `pA` increases while `pB = 1000 - pA` decreases, and vice versa.
- DC motors have no inherent position; the firmware estimates position **open-loop by time** (`TRAVEL_MS`). Boot assumes center (500/500). `H` returns to center.

Protocol v2 commands:

| Command | Meaning |
|---------|---------|
| `M <pA> <pB>` | Move both motors to per-mille positions (0..1000 each) |
| `M <p>` | Legacy: motor A = p, motor B = 1000 - p |
| `J L\|R\|T\|D` | Jog left/right/tense/loose by one step |
| `H` | Go to center (500/500) |
| `?` | Query both positions → `POS <pA> <pB>` |
| `S` | Stop both motors |

`app.jsx` `PrototypePanel` computes `motorPosA` and `motorPosB = 1000 - motorPosA` from the bound turbine's `t` offset along the diagonal.

### Wind model

`windAtRotor(cx,cy,exclude)` averages `windAt` over `ROTOR_SAMPLES = 9` points across the rotor diameter — use this, not `windAt`, when scoring turbine positions.

### Diagonal-axis constraint

Every turbine is constrained to slide along a single global diagonal (`axis` ∈ `{ NE-SW, NW-SE }`) through its `homeX/homeY`. The user places turbines anywhere by dragging — that updates `home`. The search algorithm generates candidate positions **only along the axis**.

### ESP32 firmware pinout

| Function | GPIO | Notes |
|----------|------|-------|
| Motor A ENA | 13 | L298N PWM (speed) |
| Motor A IN1 | 25 | L298N direction |
| Motor A IN2 | 26 | L298N direction |
| Motor B ENB | 23 | L298N PWM (speed) |
| Motor B IN3 | 27 | L298N direction |
| Motor B IN4 | 14 | L298N direction |
| Botón izquierda | 32 | INPUT_PULLUP, a GND |
| Botón derecha | 33 | INPUT_PULLUP, a GND |
| Botón tensar | 18 | INPUT_PULLUP, a GND |
| Botón destensar | 19 | INPUT_PULLUP, a GND |
| LED | 2 | On-board |

## Conventions

- UI strings and most comments are Spanish — match that.
- Don't add a build step, framework, or dependencies — keep it static-serve.
- Bump the `?v=N` cache buster in `index.html` after every JS change.
- Protocol is v2 (dual motor). `POS <pA> <pB>` is the response format. `parseLine` in `core.mjs` handles both single-value `POS <p>` (backward compat) and dual `POS <pA> <pB>`.