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

`simulator.js` is now an ES module (`<script type="module">`) and imports `src/core.mjs`. Cache buster: `index.html` loads `simulator.js?v=14` — bump the `v=` query whenever JS changes.

### Tests

```bash
npm test          # node --test on all tests/**/*.test.mjs
```

Coverage: pure-logic unit tests (`tests/core.test.mjs`), serial protocol integration against a Node mock ESP32 (`tests/protocol.test.mjs`, spawns `firmware/mock/mock-esp32.mjs`), firmware static checks + optional PlatformIO compile (`tests/firmware.test.mjs` — compile step is skipped when `pio` / `arduino-cli` is not on PATH; this is *not* a failure), and structural wiring of the browser sim (`tests/sim-wiring.test.mjs`).

### Firmware

```bash
npm run firmware:build      # pio run -d firmware/esp32
npm run firmware:upload     # pio run -d firmware/esp32 -t upload
npm run firmware:monitor    # pio device monitor -b 115200
```

No linter.

## File Layout

- `index.html` — markup, DOM ids the JS depends on (canvas, controls, challenge modals, HUD, serial section).
- `simulator.js` — entire simulator, ES module wrapped in an IIFE. All mutable state lives in the `S` object. Imports `./src/core.mjs`.
- `src/core.mjs` — pure logic shared with Node tests: diagonal axis math (`projectToAxis`, `axisVec`), motor mapping (`mapTtoMotor`), serial protocol formatters (`formatMove`, `parseLine`, `makeLineBuffer`). No DOM, no canvas.
- `firmware/esp32/` — PlatformIO project (`platformio.ini` + `src/main.cpp`). Drives DRV8825 + NEMA17 + endstop. Speaks the same line-based protocol implemented in `core.mjs`.
- `firmware/mock/mock-esp32.mjs` — Node process that mimics the firmware over stdio for the protocol integration test.
- `tests/` — `node --test` suites.
- `docs/HARDWARE.md` — BOM, ESP32 pinout, wiring diagram, usage flow.
- `style.css` — UI styling, includes challenge overlay/modal styles and the serial control section.
- `README.md` — physics model derivation (Jensen/Park wake, wind field, power law, search algorithm). Read it before touching wake or search code.

README references `wall-optimizer.html` and a "wall with holes" feature — those are stale. Current build is free-mode only (no wall); turbines live anywhere in the tank.

## Architecture

Single render/update loop in `simulator.js`:

- `init()` → `setupUI()`, `initParticles()`, `spawnTurbine()`, `requestAnimationFrame(loop)`.
- `loop(now)` → `update(dt)` → `render()`. `dt` scaled by `ANIM_SPEED` (constant at top of file, line 14).
- All mutable state on `S` (turbines, particles, wind, search flag, challenge phase).
- All tuneables on `CFG` (line 17). Adjust here, not inline.

### Wind model (lines ~208–256)

`windAt(px,py,exclude)` = base × wallFactor × Π(1 − wake_i). `windAtRotor(cx,cy,exclude)` averages `windAt` over `ROTOR_SAMPLES = 9` points across the rotor diameter — use this, not `windAt`, when scoring turbine positions.

`wallFactor` currently returns 1 (wall removed); kept as a hook.

### Diagonal-axis constraint

Every turbine is constrained to slide along a single global diagonal (`S.diagAxis` ∈ `{ NE-SW, NW-SE }`) through its `homeX/homeY`. The user still places turbines anywhere by dragging — that updates `home`. The search algorithm and all refinement steps generate candidate positions **only along the axis**:

- `prepareScan` produces a 1D sweep of 40 points from `effectiveAxisRange(turb)` (clipped to `MOVE_RANGE` and tank bounds).
- `refining`, `globalRefine`, `continuousOptimize` only try `±axis * step`.
- `axisSnap` (which used to snap to horizontal/vertical) is bypassed because diagonal moves would be rotated off the axis line.

Toggle: button `#btn-toggle-axis` flips `S.diagAxis` between the two diagonals.

### Search algorithm (lines ~299–645)

Four phases per turbine, then global refinement, then continuous low-amplitude optimize. Scoring uses `candidateScore` which subtracts `SEARCH_PENALTY * distance`. Constants at lines 305–308.

Spacing enforced by `violatesSpacing` using `DOWNWIND_D_FACTOR` (3D) downwind and `PERP_D_FACTOR` (2D) perpendicular separation, projected onto the wind axis.

Movement range: each turbine has `homeX/homeY` and is restricted to a disc of radius `CFG.MOVE_RANGE` around it (`turbBounds`, `inRange`). In challenge mode, `CHALLENGE_MOVE_RANGE = 140` overrides.

### Challenge system (lines ~1059–1356)

State machine on `S.chal.phase`: `idle → user_turn → ai_turn → results`. Scenarios in `CHALLENGES` array (line 1103) use fractional canvas coords via `fracToCanvas`. Scoring = `efficiency% − (avgMove/CHALLENGE_MOVE_RANGE)*25` (cap −25 pts). Player solution captured on submit, then AI runs the same search algorithm from initial positions, then `showChallengeResults` compares.

### Rendering order (`render`, line 983)

Tank → wind field heatmap (if `S.showField`) → wake cones → particles → scan overlay → turbines → wind arrow → ghost turbines (AI preview).

### Input

`onDown/onMove/onUp` handle turbine dragging. During `user_turn` of a challenge, drop position is clamped to `findNearestValid` (respects bounds, spacing, range). Outside challenge, free placement updates the turbine's `homeX/homeY`. The diagonal axis constraint applies **during search only**, not while dragging.

### WebSerial / ESP32 bridge

Browser → ESP32 mirroring lives in the `SERIAL / WEBSERIAL` section of `simulator.js`:

- `connectSerial()` opens a port via `navigator.serial.requestPort()` at 115200 baud.
- `bindTurbine(idx)` selects which sim turbine the prototype follows. Re-callable at any time.
- `streamBoundTurbinePosition()` runs every frame inside `update(dt)`. It projects the bound turbine's `(x,y)` onto its diagonal axis, maps the signed `t` to `[0..1000]` per-mille with `mapTtoMotor`, and writes `M <p>\n` if (a) value changed and (b) at least 50 ms have passed since the last send (~20 Hz cap).
- `parseLine` from `core.mjs` decodes incoming `READY` / `HOMED` / `POS` / `ERR` / `LOG` lines.

Protocol details: see `docs/HARDWARE.md` §4.

## Conventions

- UI strings and most comments are Spanish — match that.
- IIFE wrap means no exports; reference symbols by line number in the single file.
- Don't add a build step, framework, or dependencies — keep it static-serve.
- Bump the `?v=N` cache buster in `index.html` after every `simulator.js` change.
