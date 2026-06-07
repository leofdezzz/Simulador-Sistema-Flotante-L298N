/* Eolic Sea Park — control console */

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─────────────────────────────────────────────────────────────
// Tweakable defaults — host rewrites this block on save
// ─────────────────────────────────────────────────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "palette": "petrol",
  "accent": "amber",
  "showField": false,
  "showParticles": true,
  "showWake": true,
  "particleDensity": 1.0,
  "rightPanel": "telemetry"
}/*EDITMODE-END*/;

// Palette presets — applied by setting CSS vars on :root
const PALETTES = {
  petrol: {
    '--bg':        'oklch(18% 0.02 220)',
    '--bg-sea':    'oklch(22% 0.028 215)',
    '--bg-deep':   'oklch(15% 0.022 222)',
    '--surface':   'oklch(24% 0.022 220)',
    '--surface-2': 'oklch(28% 0.022 220)',
    '--line':      'oklch(36% 0.018 220)',
    '--line-soft': 'oklch(30% 0.018 220)',
    '--ink':       'oklch(96% 0.012 85)',
    '--ink-mid':   'oklch(78% 0.012 85)',
    '--ink-dim':   'oklch(60% 0.014 220)',
    '--ink-fade':  'oklch(48% 0.016 220)',
  },
  abyssal: {
    '--bg':        'oklch(14% 0.025 260)',
    '--bg-sea':    'oklch(18% 0.035 255)',
    '--bg-deep':   'oklch(11% 0.028 262)',
    '--surface':   'oklch(20% 0.025 258)',
    '--surface-2': 'oklch(24% 0.025 258)',
    '--line':      'oklch(32% 0.022 258)',
    '--line-soft': 'oklch(27% 0.020 258)',
    '--ink':       'oklch(96% 0.012 85)',
    '--ink-mid':   'oklch(78% 0.014 258)',
    '--ink-dim':   'oklch(58% 0.020 258)',
    '--ink-fade':  'oklch(46% 0.020 258)',
  },
  bone: {
    '--bg':        'oklch(95% 0.012 85)',
    '--bg-sea':    'oklch(91% 0.018 80)',
    '--bg-deep':   'oklch(97% 0.010 85)',
    '--surface':   'oklch(93% 0.014 85)',
    '--surface-2': 'oklch(89% 0.018 80)',
    '--line':      'oklch(78% 0.022 80)',
    '--line-soft': 'oklch(84% 0.018 80)',
    '--ink':       'oklch(22% 0.022 220)',
    '--ink-mid':   'oklch(38% 0.022 220)',
    '--ink-dim':   'oklch(50% 0.020 80)',
    '--ink-fade':  'oklch(64% 0.018 80)',
  },
};
const ACCENTS = {
  amber:    { '--beacon': 'oklch(80% 0.13 75)',  '--energy': 'oklch(78% 0.13 200)', '--energy-d': 'oklch(58% 0.13 200)' },
  coral:    { '--beacon': 'oklch(74% 0.16 30)',  '--energy': 'oklch(78% 0.13 200)', '--energy-d': 'oklch(58% 0.13 200)' },
  citron:   { '--beacon': 'oklch(86% 0.16 110)', '--energy': 'oklch(78% 0.13 200)', '--energy-d': 'oklch(58% 0.13 200)' },
  iris:     { '--beacon': 'oklch(74% 0.14 290)', '--energy': 'oklch(82% 0.10 160)', '--energy-d': 'oklch(60% 0.10 160)' },
};

const WIND_DIRS = [
  { code: 'N',  deg:   0, key: 'n'  },
  { code: 'NE', deg:  45, key: 'ne' },
  { code: 'E',  deg:  90, key: 'e'  },
  { code: 'SE', deg: 135, key: 'se' },
  { code: 'S',  deg: 180, key: 's'  },
  { code: 'SW', deg: 225, key: 'sw' },
  { code: 'W',  deg: 270, key: 'w'  },
  { code: 'NW', deg: 315, key: 'nw' },
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function applyTheme(palette, accent) {
  const pal = PALETTES[palette] || PALETTES.petrol;
  const acc = ACCENTS[accent] || ACCENTS.amber;
  const root = document.documentElement;
  Object.entries({ ...pal, ...acc }).forEach(([k, v]) => root.style.setProperty(k, v));
}

function fmtPower(w) {
  if (!isFinite(w)) return '— W';
  if (w >= 1000) return (w / 1000).toFixed(2) + ' kW';
  return w.toFixed(0) + ' W';
}
function fmtAxisPercent(t) {
  const r = (t / window.CFG.MOVE_RANGE) * 100;
  const sign = r >= 0 ? '+' : '−';
  return `${sign}${Math.abs(r).toFixed(0)}%`;
}

// Seed turbines — keep them clear of the floating cards in the corners.
function seedTurbines(w, h) {
  const spotsFrac = [
    { fx: 0.18, fy: 0.30 },
    { fx: 0.40, fy: 0.50 },
    { fx: 0.22, fy: 0.72 },
    { fx: 0.48, fy: 0.30 },
  ];
  const margin = 130;
  return spotsFrac.map((s, i) =>
    window.makeTurbine(
      i + 1,
      Math.max(margin, Math.min(w - margin, s.fx * w)),
      Math.max(margin, Math.min(h - margin, s.fy * h))
    )
  );
}

// ─────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────
function TopBar({ totalPower, totalCap, turbines, windDeg, windSpeed, clock }) {
  const eff = totalCap > 0 ? (totalPower / totalCap) * 100 : 0;
  const dir = WIND_DIRS.find(d => d.deg === windDeg) || WIND_DIRS[0];
  return (
    <div className="topbar">
      <div className="brand">
        <div className="brand-mark"><span></span></div>
        <div className="brand-info">
          <div className="brand-name">Eolic Sea Park</div>
          <div className="brand-sub">Operations · MV-04</div>
        </div>
      </div>
      <div className="topbar-stats">
        <div className="ts-cell">
          <div className="ts-lbl">Output</div>
          <div className="ts-val">{(totalPower / 1000).toFixed(2)}<span className="unit">kW</span></div>
        </div>
        <div className="ts-cell">
          <div className="ts-lbl">Efficiency</div>
          <div className="ts-val">{eff.toFixed(0)}<span className="unit">%</span></div>
        </div>
        <div className="ts-cell">
          <div className="ts-lbl">Wind</div>
          <div className="ts-val">
            <span className="arrow" style={{ transform: `rotate(${windDeg + 180}deg)` }}>↑</span>
            {dir.code} · {windSpeed.toFixed(1)}<span className="unit">m/s</span>
          </div>
        </div>
        <div className="ts-cell">
          <div className="ts-lbl">Fleet</div>
          <div className="ts-val">{turbines.length}<span className="unit">units</span></div>
        </div>
        <div className="ts-cell">
          <div className="ts-lbl">Sea state</div>
          <div className="ts-val">{windSpeed < 4 ? 'Calm' : windSpeed < 8 ? 'Moderate' : windSpeed < 12 ? 'Rough' : 'High'}</div>
        </div>
      </div>
      <div className="topbar-right">
        <span className="live-dot"></span>
        <span>LIVE · {clock}</span>
      </div>
    </div>
  );
}

function Compass({ windDeg, onChange }) {
  // Position 8 buttons around a circle. Radius ~76px from center of 180px box.
  const R_OUTER = 76;
  return (
    <div className="compass">
      <div className="compass-ring"></div>
      <div className="compass-ring inner"></div>
      <div className="compass-needle" style={{ transform: `translate(-50%, -50%) rotate(${windDeg + 180}deg)` }}></div>
      <div className="compass-hub"></div>
      {WIND_DIRS.map(d => {
        const a = (d.deg - 90) * Math.PI / 180;
        const x = 90 + Math.cos(a) * R_OUTER - 15;
        const y = 90 + Math.sin(a) * R_OUTER - 15;
        const active = d.deg === windDeg;
        return (
          <button
            key={d.code}
            className={`compass-btn${active ? ' active' : ''}`}
            style={{ left: x, top: y }}
            onClick={() => onChange(d.deg)}
            title={`Wind from ${d.code}`}
          >{d.code}</button>
        );
      })}
    </div>
  );
}

function WindPanel({ windDeg, setWindDeg, windSpeed, setWindSpeed }) {
  return (
    <section className="panel">
      <div className="panel-h">
        <div className="panel-idx">§01 — WIND</div>
        <div className="panel-title">Régimen de viento</div>
      </div>
      <Compass windDeg={windDeg} onChange={setWindDeg} />
      <div className="speed-row">
        <div className="lbl">Velocidad</div>
        <div className="val">{windSpeed.toFixed(1)}<span className="u">m/s</span></div>
      </div>
      <input
        className="slider"
        type="range" min="1" max="15" step="0.5"
        value={windSpeed}
        onChange={e => setWindSpeed(parseFloat(e.target.value))}
      />
      <div className="scale-marks">
        <span>01</span><span>04</span><span>08</span><span>12</span><span>15</span>
      </div>
    </section>
  );
}

function AxisIcon({ axis }) {
  // NE-SW: line from bottom-left to top-right
  // NW-SE: line from top-left to bottom-right
  return (
    <svg width="20" height="20" viewBox="0 0 20 20">
      {axis === 'NE-SW' ? (
        <line x1="3" y1="17" x2="17" y2="3" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        <line x1="3" y1="3" x2="17" y2="17" stroke="currentColor" strokeWidth="1.5" />
      )}
      <circle cx="10" cy="10" r="2" fill="currentColor" />
    </svg>
  );
}

function ParkPanel({
  turbines, axis, setAxis, selectedId, setSelectedId, boundId,
  addTurbine, removeTurbine, startSearch, resetTurbines, searching,
}) {
  return (
    <section className="panel">
      <div className="panel-h">
        <div className="panel-idx">§02 — FLEET</div>
        <div className="panel-title">Parque · {turbines.length} unidades</div>
      </div>

      <div className="axis-row">
        <button
          className={`axis-btn${axis === 'NE-SW' ? ' active' : ''}`}
          onClick={() => setAxis('NE-SW')}
        >
          <AxisIcon axis="NE-SW" />NE — SW
        </button>
        <button
          className={`axis-btn${axis === 'NW-SE' ? ' active' : ''}`}
          onClick={() => setAxis('NW-SE')}
        >
          <AxisIcon axis="NW-SE" />NW — SE
        </button>
      </div>

      <div className="tlist">
        {turbines.length === 0 && (
          <div style={{ padding: '12px 10px', color: 'var(--ink-fade)', fontSize: 11.5, fontStyle: 'italic', background: 'var(--bg-deep)' }}>
            No turbines deployed. Click + to add.
          </div>
        )}
        {turbines.map((t, i) => (
          <div
            key={t.id}
            className={`trow${selectedId === t.id ? ' selected' : ''}${boundId === t.id ? ' bound' : ''}`}
            onClick={() => setSelectedId(t.id)}
          >
            <div className="tnum">{String(i + 1).padStart(2, '0')}</div>
            <div className="tname">
              T-{String(t.id).padStart(2, '0')}
              <span className="tsub">{window.fmtAxisPercent ? '' : ''}{((t.t / window.CFG.MOVE_RANGE) * 100).toFixed(0)}%</span>
            </div>
            <div className="tpw">{t.power.toFixed(0)}W</div>
            <button
              className="trm"
              onClick={(e) => { e.stopPropagation(); removeTurbine(t.id); }}
              title="Remove"
            >×</button>
          </div>
        ))}
      </div>

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={addTurbine}>+ Añadir</button>
        <button className="btn" onClick={resetTurbines}>↺ Reset</button>
      </div>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn primary" onClick={startSearch} disabled={searching || turbines.length === 0}>
          {searching ? 'Optimizando…' : '▶ Buscar óptimo'}
        </button>
      </div>
    </section>
  );
}

function PrototypePanel({
  turbines, boundId, setBoundId,
  serialStatus, onConnect, onDisconnect, onSerialSend, axis,
}) {
  const bound = turbines.find(t => t.id === boundId);
  // Dual motor: Motor A follows per-mille position directly,
  // Motor B = 1000 - motorPosA (opposite corner pays out cable).
  const motorPosA = bound ? Math.round(((bound.t / window.CFG.MOVE_RANGE) * 500) + 500) : null;
  const motorPosB = motorPosA !== null ? 1000 - motorPosA : null;
  const motorPctA = motorPosA !== null ? motorPosA / 10 : 0;
  const motorPctB = motorPosB !== null ? motorPosB / 10 : 0;

  const flashTracks = () => {
    for (const sel of ['.motor-pos-a', '.motor-pos-b']) {
      const el = document.querySelector(sel);
      if (el) {
        el.animate(
          [{ filter: 'brightness(1)' }, { filter: 'brightness(2.5)' }, { filter: 'brightness(1)' }],
          { duration: 480 }
        );
      }
    }
  };

  const sendCenter = () => {
    onSerialSend('H\n');
    flashTracks();
  };

  const sendJog = (dir) => {
    onSerialSend(`J ${dir}\n`);
    flashTracks();
  };

  const statusTxt = {
    disconnected: 'Sin conectar',
    connecting:   'Conectando…',
    online:       `ESP32 · 115200 baud`,
    error:        'Error de enlace',
  }[serialStatus];

  return (
    <section className="panel">
      <div className="panel-h">
        <div className="panel-idx">§03 — RIG</div>
        <div className="panel-title">Prototipo físico</div>
      </div>

      <div className="serial-card">
        <div className="serial-head">
          <div style={{ fontSize: 11, letterSpacing: '0.15em', color: 'var(--ink-dim)', textTransform: 'uppercase' }}>
            Web Serial · L298N · JGB-37 × 2
          </div>
          <div className={`serial-status ${serialStatus}`}>
            <span className="sdot"></span>
            <span>{statusTxt}</span>
          </div>
        </div>

        <div className="btn-row">
          {serialStatus !== 'online' ? (
            <button className="btn primary" onClick={onConnect} disabled={serialStatus === 'connecting'}>
              {serialStatus === 'connecting' ? 'Conectando…' : 'Conectar'}
            </button>
          ) : (
            <button className="btn" onClick={onDisconnect}>Desconectar</button>
          )}
          <button className="btn" onClick={sendCenter} disabled={serialStatus !== 'online'} title="Centro 500/500">Centro</button>
        </div>

        <div className="btn-row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={() => sendJog('L')} disabled={serialStatus !== 'online'} title="Hacia esquina A">← Izq</button>
          <button className="btn" onClick={() => sendJog('R')} disabled={serialStatus !== 'online'} title="Hacia esquina B">Der →</button>
          <button className="btn" onClick={() => sendJog('T')} disabled={serialStatus !== 'online'} title="Ambos recogen cable">Tensar</button>
          <button className="btn" onClick={() => sendJog('D')} disabled={serialStatus !== 'online'} title="Ambos sueltan cable">Destensar</button>
        </div>

        <div className="serial-bind">
          <span className="lbl">Vínculo</span>
          <select
            value={boundId === null ? -1 : boundId}
            onChange={e => setBoundId(parseInt(e.target.value, 10) === -1 ? null : parseInt(e.target.value, 10))}
          >
            <option value={-1}>— ninguno —</option>
            {turbines.map((t, i) => (
              <option key={t.id} value={t.id}>T-{String(t.id).padStart(2, '0')} (slot {i + 1})</option>
            ))}
          </select>
        </div>

        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--ink-fade)', marginBottom: 2, textTransform: 'uppercase' }}>Motor A — esquina 1</div>
          <div className="motor-track">
            <div className="scale"></div>
            <div className="motor-pos motor-pos-a" style={{ left: `calc(${motorPctA}% - 1.5px)`, opacity: bound ? 1 : 0 }}></div>
          </div>
          <div className="motor-readout">
            <span>M 0</span>
            <span className="mono">{bound ? `M ${String(motorPosA).padStart(4, '0')}` : '—'}</span>
            <span>M 1000</span>
          </div>

          <div style={{ fontSize: 10, letterSpacing: '0.1em', color: 'var(--ink-fade)', marginBottom: 2, marginTop: 10, textTransform: 'uppercase' }}>Motor B — esquina 2</div>
          <div className="motor-track">
            <div className="scale"></div>
            <div className="motor-pos motor-pos-b" style={{ left: `calc(${motorPctB}% - 1.5px)`, opacity: bound ? 1 : 0 }}></div>
          </div>
          <div className="motor-readout">
            <span>M 0</span>
            <span className="mono">{bound ? `M ${String(motorPosB).padStart(4, '0')}` : '—'}</span>
            <span>M 1000</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ViewPanel({ showWake, showParticles, showField, setShowWake, setShowParticles, setShowField }) {
  const rows = [
    { id: 'wake',  label: 'Conos de estela',  on: showWake,      set: setShowWake },
    { id: 'parts', label: 'Partículas de viento', on: showParticles, set: setShowParticles },
    { id: 'field', label: 'Mapa de velocidad', on: showField,     set: setShowField },
  ];
  return (
    <section className="panel">
      <div className="panel-h">
        <div className="panel-idx">§04 — VIEW</div>
        <div className="panel-title">Visualización</div>
      </div>
      <div className="toggle-list">
        {rows.map(r => (
          <div
            key={r.id}
            className={`toggle-row${r.on ? ' on' : ''}`}
            onClick={() => r.set(!r.on)}
          >
            <span>{r.label}</span>
            <div className="toggle-switch"></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ParkCard({ totalPower, capacity, history, turbines }) {
  // sparkline
  const W = 240, H = 36;
  const max = Math.max(50, ...history);
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1 || 1)) * W;
    const y = H - (v / max) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const eff = capacity > 0 ? (totalPower / capacity) * 100 : 0;
  const active = turbines.filter(t => t.power > 5).length;

  return (
    <div className="park-card">
      <h4>Producción del parque</h4>
      <div className="big">{(totalPower / 1000).toFixed(2)}<span className="u">kW</span></div>
      <div className="sub">
        <span>{active}/{turbines.length} activas</span>
        <span style={{ float: 'right' }} className="delta">↗ {eff.toFixed(0)}%</span>
      </div>
      <div className="park-bar"><div style={{ width: `${Math.min(100, eff)}%` }}></div></div>
      <div className="park-spark">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <line x1="0" y1={H * 0.5} x2={W} y2={H * 0.5} className="grid-line" />
          {pts && (
            <>
              <polyline
                points={`0,${H} ${pts} ${W},${H}`}
                fill="oklch(78% 0.13 200 / 0.15)"
                stroke="none"
              />
              <polyline
                points={pts}
                fill="none"
                stroke="oklch(78% 0.13 200)"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

function TelemetryCard({ turbine, axis, windDeg, boundId }) {
  if (!turbine) {
    return (
      <div className="telem">
        <div className="telem-head">
          <div className="telem-title">Telemetría</div>
          <div className="telem-id">SELECCIONA UNA TURBINA</div>
        </div>
        <div className="telem-empty">
          Pulsa sobre cualquier aerogenerador del mapa para inspeccionarlo.
        </div>
      </div>
    );
  }
  const p = window.turbinePos(turbine, axis);
  const tPct = (turbine.t / window.CFG.MOVE_RANGE) * 100;
  const offsetM = Math.abs(turbine.t * 1.5).toFixed(0); // fake conversion to meters
  return (
    <div className="telem">
      <div className="telem-head">
        <div className="telem-title">
          T-{String(turbine.id).padStart(2, '0')}
          {boundId === turbine.id && (
            <span style={{
              fontFamily: "'IBM Plex Mono'", fontSize: 10, color: 'var(--beacon)',
              marginLeft: 10, letterSpacing: '0.18em', verticalAlign: 'middle'
            }}>● PROTOTIPO</span>
          )}
        </div>
        <div className="telem-id">{p.x.toFixed(0)} · {p.y.toFixed(0)}</div>
      </div>
      <div className="telem-grid">
        <div className="telem-cell"><div className="l">Output</div><div className="v">{turbine.power.toFixed(0)}<span className="u">W</span></div></div>
        <div className="telem-cell"><div className="l">Viento efectivo</div><div className="v">{turbine.lastWind.toFixed(1)}<span className="u">m/s</span></div></div>
        <div className="telem-cell"><div className="l">Posición eje</div><div className="v">{tPct >= 0 ? '+' : '−'}{Math.abs(tPct).toFixed(0)}<span className="u">%</span></div></div>
        <div className="telem-cell"><div className="l">Offset</div><div className="v">{offsetM}<span className="u">m</span></div></div>
      </div>
      <div className="telem-axis">
        <div className="l">Recorrido sobre eje {axis}</div>
        <div className="axis-bar">
          <div className="home"></div>
          <div className="marker" style={{ left: `${50 + tPct / 2}%` }}></div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main app
// ─────────────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const { TweaksPanel, TweakSection, TweakRadio, TweakSelect, TweakToggle } = window;

  // Apply theme on tweaks change
  useEffect(() => { applyTheme(t.palette, t.accent); }, [t.palette, t.accent]);

  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const engineRef = useRef(null);

  // Sim state
  const [turbines, setTurbines] = useState([]);
  const turbinesRef = useRef(turbines);
  useEffect(() => { turbinesRef.current = turbines; }, [turbines]);

  const [windDeg, setWindDeg] = useState(270); // wind from west
  const [windSpeed, setWindSpeed] = useState(7);
  const [axis, setAxis] = useState('NE-SW');
  const [selectedId, setSelectedId] = useState(null);
  const [boundId, setBoundId] = useState(null);
  const [serialStatus, setSerialStatus] = useState('disconnected');
  const serialRef = useRef({ port: null, writer: null, readerTask: null, abort: null });

  const sendSerial = useCallback(async (cmd) => {
    const w = serialRef.current.writer;
    if (!w) return;
    try {
      await w.write(new TextEncoder().encode(cmd));
    } catch {
      setSerialStatus('error');
    }
  }, []);

  const disconnectSerial = useCallback(async () => {
    const s = serialRef.current;
    if (s.abort) s.abort.abort();
    if (s.readerTask) {
      try { await s.readerTask; } catch { /* closed */ }
    }
    if (s.writer) {
      try { await s.writer.close(); } catch { /* already closed */ }
    }
    if (s.port) {
      try { await s.port.close(); } catch { /* already closed */ }
    }
    serialRef.current = { port: null, writer: null, readerTask: null, abort: null };
    setSerialStatus('disconnected');
  }, []);

  const connectSerial = useCallback(async () => {
    if (serialStatus === 'online' || serialStatus === 'connecting') return;
    if (!navigator.serial) {
      setSerialStatus('error');
      return;
    }
    setSerialStatus('connecting');
    try {
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200 });
      const writer = port.writable.getWriter();
      const abort = new AbortController();
      serialRef.current = { port, writer, readerTask: null, abort };

      const readerTask = (async () => {
        const reader = port.readable.getReader();
        let buf = '';
        try {
          while (!abort.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += new TextDecoder().decode(value);
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              const t = line.trim();
              if (t === 'READY' || t === 'HOMED') setSerialStatus('online');
            }
          }
        } finally {
          try { reader.releaseLock(); } catch { /* noop */ }
        }
      })();
      serialRef.current.readerTask = readerTask;
      setSerialStatus('online');
    } catch {
      await disconnectSerial();
    }
  }, [serialStatus, disconnectSerial]);

  useEffect(() => () => { disconnectSerial(); }, [disconnectSerial]);

  const [searching, setSearching] = useState(false);
  const [history, setHistory] = useState([]);
  const [, force] = useState(0);
  const [clock, setClock] = useState('');

  // Initialise turbines once stage size is known
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const initial = seedTurbines(rect.width, rect.height);
    setTurbines(initial);
    setSelectedId(initial[0].id);
    setBoundId(initial[0].id);
  }, []);

  // Engine setup
  useEffect(() => {
    if (!canvasRef.current) return;
    engineRef.current = new window.SimEngine(canvasRef.current);
    return () => {
      // engine cleanup if needed
    };
  }, []);

  // Sync view options into engine.
  // Particles only render on cardinal winds — diagonal flow creates
  // visual collisions with the diagonal turbine axes so we hide them.
  useEffect(() => {
    if (!engineRef.current) return;
    const isCardinal = windDeg % 90 === 0;
    engineRef.current.opts.showParticles = t.showParticles && isCardinal;
    engineRef.current.opts.showWake = t.showWake;
    engineRef.current.opts.showField = t.showField;
  }, [t.showParticles, t.showWake, t.showField, windDeg]);

  // RAF loop
  useEffect(() => {
    let raf, last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const eng = engineRef.current;
      if (eng) {
        eng.step(dt, {
          turbines: turbinesRef.current,
          axis, windDeg, windSpeed,
        });
        eng.render({
          turbines: turbinesRef.current,
          axis, windDeg,
          selectedId, boundId,
        });
      }
      // Force re-render at ~20Hz for telemetry/UI refresh
      force(x => (x + 1) % 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [axis, windDeg, windSpeed, selectedId, boundId]);

  // Searching sync
  useEffect(() => {
    if (!engineRef.current) return;
    engineRef.current.searching = searching;
    if (searching) {
      engineRef.current.searchPhase = 0;
      engineRef.current.searchStarted = performance.now();
      // auto-stop after a few seconds
      const id = setTimeout(() => setSearching(false), 3700);
      return () => clearTimeout(id);
    }
  }, [searching]);

  // History sample (~5Hz)
  useEffect(() => {
    const id = setInterval(() => {
      const total = turbinesRef.current.reduce((s, x) => s + x.power, 0);
      setHistory(h => {
        const next = [...h, total];
        if (next.length > 60) next.shift();
        return next;
      });
    }, 220);
    return () => clearInterval(id);
  }, []);

  // Clock
  useEffect(() => {
    const upd = () => {
      const d = new Date();
      setClock(d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    };
    upd();
    const id = setInterval(upd, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Canvas interactions: select + free drag (search constrains to axis)
  const dragRef = useRef(null);
  const onCanvasDown = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const eng = engineRef.current;
    if (!eng) return;
    const id = eng.hit(x, y, turbinesRef.current, axis);
    if (id !== null) {
      const turb = turbinesRef.current.find(t => t.id === id);
      const p = window.turbinePos(turb, axis);
      setSelectedId(id);
      dragRef.current = { id, offsetX: x - p.x, offsetY: y - p.y };
    }
  };
  const onCanvasMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left - drag.offsetX;
    const y = e.clientY - rect.top - drag.offsetY;
    const dragId = drag.id;
    setTurbines(arr => arr.map(turb => {
      if (turb.id !== dragId) return turb;
      return { ...turb, homeX: x, homeY: y, t: 0 };
    }));
  };
  const onCanvasUp = () => {
    dragRef.current = null;
  };

  // ── Turbine actions
  const addTurbine = () => {
    const rect = stageRef.current.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    setTurbines(arr => {
      const id = (arr.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1;
      const hx = 160 + Math.random() * (w - 320);
      const hy = 130 + Math.random() * (h - 260);
      return [...arr, window.makeTurbine(id, hx, hy)];
    });
  };
  const removeTurbine = (id) => {
    setTurbines(arr => arr.filter(t => t.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (boundId === id) setBoundId(null);
  };
  const resetTurbines = () => {
    setTurbines(arr => arr.map(t => ({ ...t, t: 0 })));
  };
  const startSearch = () => setSearching(true);

  // ── Derived
  const totalPower = turbines.reduce((s, x) => s + x.power, 0);
  const capacity = turbines.length * window.turbinePower(windSpeed);
  const selected = turbines.find(t => t.id === selectedId);

  return (
    <div className="shell">
      <TopBar
        totalPower={totalPower}
        totalCap={capacity}
        turbines={turbines}
        windDeg={windDeg}
        windSpeed={windSpeed}
        clock={clock}
      />

      <aside className="side">
        <WindPanel
          windDeg={windDeg} setWindDeg={setWindDeg}
          windSpeed={windSpeed} setWindSpeed={setWindSpeed}
        />
        <ParkPanel
          turbines={turbines}
          axis={axis} setAxis={setAxis}
          selectedId={selectedId} setSelectedId={setSelectedId}
          boundId={boundId}
          addTurbine={addTurbine}
          removeTurbine={removeTurbine}
          startSearch={startSearch}
          resetTurbines={resetTurbines}
          searching={searching}
        />
        <PrototypePanel
          turbines={turbines}
          boundId={boundId} setBoundId={setBoundId}
          serialStatus={serialStatus}
          onConnect={connectSerial}
          onDisconnect={disconnectSerial}
          onSerialSend={sendSerial}
          axis={axis}
        />
        <ViewPanel
          showWake={t.showWake} setShowWake={(v) => setTweak('showWake', v)}
          showParticles={t.showParticles} setShowParticles={(v) => setTweak('showParticles', v)}
          showField={t.showField} setShowField={(v) => setTweak('showField', v)}
        />
      </aside>

      <main className="stage" ref={stageRef}>
        <canvas
          id="sea"
          ref={canvasRef}
          onMouseDown={onCanvasDown}
          onMouseMove={onCanvasMove}
          onMouseUp={onCanvasUp}
          onMouseLeave={onCanvasUp}
        ></canvas>
        <div className="stage-hud-tl">
          <div className="hud-tag">Eje · <b>{axis}</b></div>
          <div className="hud-tag">Mar · <b>Trafalgar 36.18°N</b></div>
          <div className="hud-tag">Modelo · <b>Jensen/Park k=0.08</b></div>
        </div>
        <ParkCard
          totalPower={totalPower}
          capacity={capacity}
          history={history}
          turbines={turbines}
        />
        <TelemetryCard turbine={selected} axis={axis} windDeg={windDeg} boundId={boundId} />

      </main>

      <footer className="foot">
        <div className="foot-l">
          <span>OPS-CONSOLE v2.4</span>
          <span>BUILD 2026.05.21</span>
        </div>
        <div className="foot-r">
          <span>WAKE MODEL · JENSEN/PARK</span>
          <span>POWER LAW · P ∝ v³</span>
          <span>LATENCY 4ms</span>
        </div>
      </footer>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Aspecto">
          <TweakRadio
            label="Paleta"
            value={t.palette}
            onChange={(v) => setTweak('palette', v)}
            options={[
              { value: 'petrol', label: 'Petrol' },
              { value: 'abyssal', label: 'Abyssal' },
              { value: 'bone', label: 'Bone' },
            ]}
          />
          <TweakSelect
            label="Acento"
            value={t.accent}
            onChange={(v) => setTweak('accent', v)}
            options={[
              { value: 'amber', label: 'Amber baliza' },
              { value: 'coral', label: 'Coral señal' },
              { value: 'citron', label: 'Citron faro' },
              { value: 'iris', label: 'Iris profundo' },
            ]}
          />
        </TweakSection>
        <TweakSection label="Capas del mar">
          <TweakToggle label="Conos de estela" value={t.showWake} onChange={(v) => setTweak('showWake', v)} />
          <TweakToggle label="Partículas de viento" value={t.showParticles} onChange={(v) => setTweak('showParticles', v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
