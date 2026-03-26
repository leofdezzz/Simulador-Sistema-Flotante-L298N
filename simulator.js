// ============================================================
// Floating Farm Simulator
// Based on the Floating Farm project (Raspberry Pi Pico)
// Wall is a physical barrier — turbines live on the downwind
// side and must find holes to capture wind.
// ============================================================
(() => {
"use strict";

// ── VELOCIDAD DE ANIMACIÓN ──────────────────────────────
// Ajusta este valor para controlar la velocidad general de
// todas las animaciones de búsqueda.
// 1.0 = velocidad base, 2.0 = doble, 0.5 = mitad, etc.
const ANIM_SPEED = 1.0;
// ────────────────────────────────────────────────────────

const CFG = {
    TANK_PAD: 40,
    TURBINE_R: 18,
    BLADE_LEN: 16,
    WALL_THICK: 6,
    WALL_MARGIN: 45,
    PARTICLE_N: 400,
    WAKE_K: 0.08,
    WAKE_A: 0.33,
    SEARCH_SPEED: 3.0,
    SCAN_GRID: 22,
    MIN_TURB_DIST: 55,
    MOVE_RANGE: 120,       // Radio máximo de movimiento desde posición inicial
    TRAIL_FADE_TIME: 2.0,  // Segundos que tarda el trail en desaparecer
    // Free mode overrides
    FREE_TURBINE_R: 28,
    FREE_BLADE_LEN: 24,
    FREE_MIN_TURB_DIST: 85,
    COL_WATER_A: "#081e38",
    COL_WATER_B: "#0c2d50",
    COL_WALL: "#6a7a9a",
    COL_HOLE: "#4af0a0",
    COL_BLADE: ["#5ecfff","#ff8c5e","#c084fc","#facc15","#f472b6","#34d399","#fb7185","#38bdf8"],
};

// Effective config values (change with mode)
function turbR()      { return S.mode === 'free' ? CFG.FREE_TURBINE_R : CFG.TURBINE_R; }
function bladeLen()   { return S.mode === 'free' ? CFG.FREE_BLADE_LEN : CFG.BLADE_LEN; }
function minTurbDist(){ return S.mode === 'free' ? CFG.FREE_MIN_TURB_DIST : CFG.MIN_TURB_DIST; }

// Wind vectors: where the wind FLOWS toward (away from the source)
// Button arrows show where wind COMES FROM, vector is the opposite
const WIND_DIRS = [
    { dx: 1, dy: 0 },   // 0: ←  from left,         flows right
    { dx:-1, dy: 0 },   // 1: →  from right,        flows left
    { dx: 0, dy: 1 },   // 2: ↑  from top,          flows down
    { dx: 0, dy:-1 },   // 3: ↓  from bottom,       flows up
    { dx:-1, dy: 1 },   // 4: ↗  from top-right,    flows bottom-left
    { dx: 1, dy:-1 },   // 5: ↙  from bottom-left,  flows top-right
    { dx: 1, dy: 1 },   // 6: ↖  from top-left,     flows bottom-right
    { dx:-1, dy:-1 },   // 7: ↘  from bottom-right,  flows top-left
];
WIND_DIRS.forEach(d => { const m = Math.hypot(d.dx,d.dy); if(m>1){d.dx/=m;d.dy/=m;} });

// ===================== STATE =====================
const S = {
    windDir: 0,  windSpeed: 5,  wallPct: 50,
    wallOrient: 'vertical',  // 'vertical' | 'horizontal'
    mode: 'wall',  // 'wall' | 'free'
    holes: [{ pct: 50, size: 80 }],  // pct = position along the wall (y% for vertical, x% for horizontal)
    turbines: [],  particles: [],
    searching: false,
    showWake: true,  showWind: true,  showField: false,
    t: 0,
    tank: {x:0,y:0,w:0,h:0},
    dragHole: null,  dragTurbine: null,
};

const cvs = document.getElementById("sim-canvas");
const cx  = cvs.getContext("2d");
let W=0, H=0;

function resize() {
    const c = document.getElementById("canvas-container");
    W = c.clientWidth; H = c.clientHeight;
    cvs.width = W; cvs.height = H;
    S.tank = { x:CFG.TANK_PAD, y:CFG.TANK_PAD, w:W-2*CFG.TANK_PAD, h:H-2*CFG.TANK_PAD };
}

// ===================== HELPERS =====================
function inTank(x,y) {
    const t=S.tank; return x>=t.x&&x<=t.x+t.w&&y>=t.y&&y<=t.y+t.h;
}
function clamp(v,lo,hi) { return Math.max(lo,Math.min(hi,v)); }
function isVert() { return S.wallOrient === 'vertical'; }

// Wall position on its perpendicular axis
function wallCoord() {
    const t = S.tank;
    return isVert()
        ? t.x + t.w * S.wallPct / 100   // X position for vertical wall
        : t.y + t.h * S.wallPct / 100;   // Y position for horizontal wall
}

// Hole positions in canvas coords
function holePos() {
    const t = S.tank, wc = wallCoord();
    if (isVert()) {
        return S.holes.map(h => ({ x: wc, y: t.y + t.h * h.pct/100, hs: h.size/2 }));
    } else {
        return S.holes.map(h => ({ x: t.x + t.w * h.pct/100, y: wc, hs: h.size/2 }));
    }
}
function dist(ax,ay,bx,by) { return Math.hypot(bx-ax,by-ay); }

// Movement bounds for a turbine (respecting home + range)
function turbBounds(turb) {
    const base = globalBounds();
    if (!turb || !turb.homeX) return base;
    const r = CFG.MOVE_RANGE;
    return {
        x0: Math.max(base.x0, turb.homeX - r),
        x1: Math.min(base.x1, turb.homeX + r),
        y0: Math.max(base.y0, turb.homeY - r),
        y1: Math.min(base.y1, turb.homeY + r),
    };
}

// Check if point is within a turbine's movement range
function inRange(turb, px, py) {
    if (!turb || !turb.homeX) return true;
    return dist(px, py, turb.homeX, turb.homeY) <= CFG.MOVE_RANGE;
}

// Global bounds (full zone where turbines can exist)
function globalBounds() {
    const t = S.tank, m = turbR() + 8;
    if (S.mode === 'free') {
        return { x0: t.x+m, x1: t.x+t.w-m, y0: t.y+m, y1: t.y+t.h-m };
    }
    return downwindBounds();
}

// Downwind region: the side of the wall where wind goes TO
function downwindBounds() {
    const t=S.tank, w=WIND_DIRS[S.windDir], wc=wallCoord(), m=turbR()+8;
    const wm = CFG.WALL_MARGIN; // min distance from wall
    if (isVert()) {
        if (w.dx > 0.01) return { x0: wc+wm, x1: t.x+t.w-m, y0:t.y+m, y1:t.y+t.h-m };
        if (w.dx < -0.01) return { x0: t.x+m, x1: wc-wm, y0:t.y+m, y1:t.y+t.h-m };
        return { x0:t.x+m, x1:t.x+t.w-m, y0:t.y+m, y1:t.y+t.h-m };
    } else {
        if (w.dy > 0.01) return { x0:t.x+m, x1:t.x+t.w-m, y0: wc+wm, y1: t.y+t.h-m };
        if (w.dy < -0.01) return { x0:t.x+m, x1:t.x+t.w-m, y0: t.y+m, y1: wc-wm };
        return { x0:t.x+m, x1:t.x+t.w-m, y0:t.y+m, y1:t.y+t.h-m };
    }
}

function isDownwind(px, py) {
    const b = globalBounds();
    return px >= b.x0 && px <= b.x1 && py >= b.y0 && py <= b.y1;
}

function isValidPos(turb, px, py) {
    return isDownwind(px, py) && inRange(turb, px, py);
}

// ===================== WIND MODEL =====================
function wallFactor(px, py) {
    if (S.mode === 'free') return 1.0;
    const w = WIND_DIRS[S.windDir], wc = wallCoord();

    if (isVert()) {
        // Vertical wall blocks along x axis
        if (Math.abs(w.dx) < 0.01) return 1.0;
        const isDown = (w.dx > 0 && px > wc) || (w.dx < 0 && px < wc);
        if (!isDown) return 1.0;

        const dw = Math.abs(px - wc);
        const holes = holePos();
        let best = 0;
        for (const h of holes) {
            const yAtWall = py - (w.dy / Math.max(0.1, Math.abs(w.dx))) * dw;
            const dyH = Math.abs(yAtWall - h.y);
            const spread = h.hs + dw * 0.30;
            if (dyH < spread) {
                const ratio = dyH / spread;
                const f = Math.exp(-3 * ratio * ratio);
                const dd = 1 / (1 + dw * 0.0008);
                best = Math.max(best, f * dd);
            }
        }
        return best;
    } else {
        // Horizontal wall blocks along y axis
        if (Math.abs(w.dy) < 0.01) return 1.0;
        const isDown = (w.dy > 0 && py > wc) || (w.dy < 0 && py < wc);
        if (!isDown) return 1.0;

        const dw = Math.abs(py - wc);
        const holes = holePos();
        let best = 0;
        for (const h of holes) {
            const xAtWall = px - (w.dx / Math.max(0.1, Math.abs(w.dy))) * dw;
            const dxH = Math.abs(xAtWall - h.x);
            const spread = h.hs + dw * 0.30;
            if (dxH < spread) {
                const ratio = dxH / spread;
                const f = Math.exp(-3 * ratio * ratio);
                const dd = 1 / (1 + dw * 0.0008);
                best = Math.max(best, f * dd);
            }
        }
        return best;
    }
}

function wakeDef(turb, px, py) {
    const w = WIND_DIRS[S.windDir];
    const dx = px-turb.x, dy = py-turb.y;
    const ds = dx*w.dx + dy*w.dy;
    if (ds <= 5) return 0;
    const perp = Math.abs(-dx*w.dy + dy*w.dx);
    const tr = turbR();
    const R = tr + CFG.WAKE_K * ds;
    if (perp >= R) return 0;
    const deficit = 2*CFG.WAKE_A / ((1 + CFG.WAKE_K*ds/tr)**2);
    const rr = perp/R;
    return deficit * Math.exp(-2*rr*rr);
}

function windAt(px, py, exclude) {
    let v = S.windSpeed * wallFactor(px, py);
    for (const t of S.turbines) {
        if (t === exclude) continue;
        v *= (1 - wakeDef(t, px, py));
    }
    return Math.max(0, v);
}

function windToVoltage(v) {
    const n = v/15;
    return Math.min(100, n*n*n * 300);
}

// ===================== SEARCH ALGORITHM =====================
// Sequential: turbines take turns. Each scans the downwind zone,
// picks the best spot (avoiding others' wakes + min distance),
// then animates moving there with gradient refinement.

function startSearch() {
    if (!S.turbines.length) return;
    S.searching = true;
    S.globalRefine = false;
    S.globalRefineN = 0;
    setStatus("Escaneando...");
    for (const t of S.turbines) {
        t.phase = 'waiting'; t.trail = []; t.scanPts = null;
    }
    activateNext(0);
}

function activateNext(startIdx) {
    for (let i = startIdx; i < S.turbines.length; i++) {
        if (S.turbines[i].phase === 'waiting') {
            const t = S.turbines[i];
            t.phase = 'scanning';
            t.scanIdx = 0;
            t.trailAlpha = 1; t.trailFadeStart = 0;
            prepareScan(t);
            setStatus(`Turbina ${i+1}: escaneando...`);
            return;
        }
    }
}

function prepareScan(turb) {
    const b = turbBounds(turb);
    const nx = CFG.SCAN_GRID;
    const ny = Math.round(CFG.SCAN_GRID * ((b.y1-b.y0) / Math.max(1, b.x1-b.x0)));
    turb.scanPts = [];
    const clampedNy = Math.max(ny, 4);
    const clampedNx = Math.max(nx, 4);
    for (let ix = 0; ix < clampedNx; ix++) {
        for (let iy = 0; iy < clampedNy; iy++) {
            const px = b.x0 + (b.x1-b.x0)*ix/(clampedNx-1);
            const py = b.y0 + (b.y1-b.y0)*iy/(clampedNy-1);
            // Only include points within the circular range
            if (inRange(turb, px, py)) {
                turb.scanPts.push({ x: px, y: py, v: -1 });
            }
        }
    }
    turb.bestScan = { x: turb.x, y: turb.y, v: -1 };
}

function updateSearch(dt) {
    if (!S.searching) return;

    // Global refinement phase: all turbines optimize simultaneously
    if (S.globalRefine) {
        // Check if any turbine is still animating toward its global refine target
        let anyAnimating = false;
        for (let i=0; i<S.turbines.length; i++) {
            const turb = S.turbines[i];
            if (turb.globalTarget) {
                anyAnimating = true;
                const dx = turb.globalTarget.x - turb.x, dy = turb.globalTarget.y - turb.y;
                const d = Math.hypot(dx, dy);
                if (d < 2) {
                    turb.x = turb.globalTarget.x; turb.y = turb.globalTarget.y;
                    turb.globalTarget = null;
                } else {
                    const spd = Math.min(CFG.SEARCH_SPEED * ANIM_SPEED * dt, d);
                    turb.x += (dx/d)*spd; turb.y += (dy/d)*spd;
                }
                turb.trail.push({x:turb.x, y:turb.y});
                if (turb.trail.length > 600) turb.trail.shift();
            }
        }
        if (!anyAnimating) {
            // Find next targets for all turbines
            S.globalRefineN++;
            let anyMoved = false;
            for (let i=0; i<S.turbines.length; i++) {
                const turb = S.turbines[i];
                const step = 6;
                const cur = windAt(turb.x, turb.y, turb);
                let bx=0, by=0, bv=cur;
                for (let a=0; a<12; a++) {
                    const ang = a/12*Math.PI*2;
                    const nx = turb.x + Math.cos(ang)*step;
                    const ny = turb.y + Math.sin(ang)*step;
                    if (!isValidPos(turb, nx, ny)) continue;
                    let ok = true;
                    for (let j=0; j<S.turbines.length; j++) {
                        if (j===i) continue;
                        if (dist(nx,ny,S.turbines[j].x,S.turbines[j].y)<minTurbDist()) { ok=false; break; }
                    }
                    if (!ok) continue;
                    const v = windAt(nx, ny, turb);
                    if (v > bv+0.01) { bv=v; bx=Math.cos(ang)*step*0.8; by=Math.sin(ang)*step*0.8; }
                }
                if (bx||by) {
                    turb.globalTarget = { x: turb.x + bx, y: turb.y + by };
                    anyMoved = true;
                }
            }
            if (S.globalRefineN > 30 || !anyMoved) {
                S.globalRefine = false;
                S.searching = false;
                for (const t of S.turbines) t.trailFadeStart = S.t;
                setStatus("Posición óptima");
            }
        }
        return;
    }

    const ti = S.turbines.findIndex(t => t.phase !== 'waiting' && t.phase !== 'done');
    if (ti < 0) {
        // All individual searches done → start global refinement
        if (S.turbines.every(t => t.phase === 'done')) {
            if (S.turbines.length > 1) {
                S.globalRefine = true;
                S.globalRefineN = 0;
                setStatus("Optimización global...");
            } else {
                S.searching = false;
                setStatus("Posición óptima");
            }
        }
        return;
    }
    const turb = S.turbines[ti];

    if (turb.phase === 'scanning') {
        // Process several points per frame (fast but still animated)
        const batch = Math.round(24 * ANIM_SPEED);
        for (let b = 0; b < batch && turb.scanIdx < turb.scanPts.length; b++) {
            const sp = turb.scanPts[turb.scanIdx];
            // Min distance check to placed turbines
            let ok = true;
            for (let j = 0; j < S.turbines.length; j++) {
                if (j === ti) continue;
                const ot = S.turbines[j];
                if (ot.phase === 'done' || ot.phase === 'refining') {
                    if (dist(sp.x,sp.y,ot.x,ot.y) < minTurbDist()) { ok=false; break; }
                }
            }
            if (ok) {
                sp.v = windAt(sp.x, sp.y, turb);
                if (sp.v > turb.bestScan.v) {
                    turb.bestScan = { x:sp.x, y:sp.y, v:sp.v };
                }
            }
            turb.scanIdx++;
        }
        if (turb.scanIdx >= turb.scanPts.length) {
            turb.targetX = turb.bestScan.x;
            turb.targetY = turb.bestScan.y;
            turb.phase = 'moving';
            setStatus(`Turbina ${ti+1}: moviéndose...`);
        }
    }
    else if (turb.phase === 'moving') {
        const dx = turb.targetX-turb.x, dy = turb.targetY-turb.y;
        const d = Math.hypot(dx,dy);
        if (d < 2) {
            turb.x = turb.targetX; turb.y = turb.targetY;
            turb.phase = 'refining'; turb.refineN = 0;
            setStatus(`Turbina ${ti+1}: refinando...`);
        } else {
            const spd = Math.min(CFG.SEARCH_SPEED * ANIM_SPEED * dt, d);
            turb.x += (dx/d)*spd; turb.y += (dy/d)*spd;
        }
        turb.trail.push({x:turb.x, y:turb.y});
        if (turb.trail.length > 600) turb.trail.shift();
    }
    else if (turb.phase === 'refining') {
        // If we have a refine target, animate toward it like the 'moving' phase
        if (turb.refineTarget) {
            const dx = turb.refineTarget.x - turb.x, dy = turb.refineTarget.y - turb.y;
            const d = Math.hypot(dx, dy);
            if (d < 2) {
                turb.x = turb.refineTarget.x; turb.y = turb.refineTarget.y;
                turb.refineTarget = null; // arrived, search next direction
            } else {
                const spd = Math.min(CFG.SEARCH_SPEED * ANIM_SPEED * dt, d);
                turb.x += (dx/d)*spd; turb.y += (dy/d)*spd;
            }
            turb.trail.push({x:turb.x, y:turb.y});
            if (turb.trail.length > 600) turb.trail.shift();
        } else {
            // Find next best direction
            const step = 8;
            const cur = windAt(turb.x, turb.y, turb);
            let bx=0, by=0, bv=cur;
            for (let a=0; a<12; a++) {
                const ang = a/12*Math.PI*2;
                const nx = turb.x + Math.cos(ang)*step;
                const ny = turb.y + Math.sin(ang)*step;
                if (!isValidPos(turb, nx, ny)) continue;
                let ok = true;
                for (let j=0; j<S.turbines.length; j++) {
                    if (j===ti) continue;
                    if (dist(nx,ny,S.turbines[j].x,S.turbines[j].y)<minTurbDist()) { ok=false; break; }
                }
                if (!ok) continue;
                const v = windAt(nx, ny, turb);
                if (v > bv + 0.01) { bv=v; bx=Math.cos(ang)*step*1.0; by=Math.sin(ang)*step*1.0; }
            }
            if (bx||by) {
                turb.refineTarget = { x: turb.x + bx, y: turb.y + by };
            }
            turb.refineN++;
            if (turb.refineN > 25 || (!bx && !by)) {
                turb.phase = 'done';
                turb.trailFadeStart = S.t;
                // Activate next waiting turbine
                activateNext(ti+1);
            }
        }
    }
}

function continuousOptimize() {
    if (S.searching) return;
    for (let i=0; i<S.turbines.length; i++) {
        const turb = S.turbines[i];
        if (turb.phase !== 'done') continue;
        const step = 4, cur = windAt(turb.x,turb.y,turb);
        let bx=0,by=0,bv=cur;
        for (let a=0; a<8; a++) {
            const ang = a/8*Math.PI*2;
            const nx = turb.x+Math.cos(ang)*step;
            const ny = turb.y+Math.sin(ang)*step;
            if (!isValidPos(turb,nx,ny)) continue;
            let ok=true;
            for (let j=0;j<S.turbines.length;j++) {
                if(j===i) continue;
                if(dist(nx,ny,S.turbines[j].x,S.turbines[j].y)<minTurbDist()){ok=false;break;}
            }
            if(!ok) continue;
            const v = windAt(nx,ny,turb);
            if (v > bv+0.06) { bv=v; bx=Math.cos(ang)*0.5; by=Math.sin(ang)*0.5; }
        }
        if (bx||by) {
            turb.x+=bx; turb.y+=by;
            turb.trail.push({x:turb.x,y:turb.y});
            if (turb.trail.length>600) turb.trail.shift();
        }
    }
}

// ===================== PARTICLES =====================
function spawnParticle(scatter) {
    const t=S.tank, w=WIND_DIRS[S.windDir];
    let x,y;
    if (scatter) { x=t.x+Math.random()*t.w; y=t.y+Math.random()*t.h; }
    else {
        if (Math.abs(w.dx) >= Math.abs(w.dy)) {
            x = w.dx>0 ? t.x-4 : t.x+t.w+4;
            y = t.y+Math.random()*t.h;
        } else {
            x = t.x+Math.random()*t.w;
            y = w.dy>0 ? t.y-4 : t.y+t.h+4;
        }
        if (Math.abs(w.dx)>0.1 && Math.abs(w.dy)>0.1 && Math.random()>0.5) {
            x = t.x+Math.random()*t.w;
            y = w.dy>0 ? t.y-4 : t.y+t.h+4;
        }
    }
    return { x, y, spd:0.3+Math.random()*0.7, life:1, sz:1+Math.random()*1.5 };
}

function initParticles() {
    S.particles = [];
    for (let i=0;i<CFG.PARTICLE_N;i++) S.particles.push(spawnParticle(true));
}

function updateParticles(dt) {
    const t=S.tank, w=WIND_DIRS[S.windDir];
    for (let i=0; i<S.particles.length; i++) {
        const p=S.particles[i];
        const v = windAt(p.x, p.y) * 0.5;
        p.x += w.dx*v*p.spd*dt;
        p.y += w.dy*v*p.spd*dt;
        p.life -= 0.002*dt;
        if (p.life<=0 || p.x<t.x-20 || p.x>t.x+t.w+20 || p.y<t.y-20 || p.y>t.y+t.h+20) {
            S.particles[i] = spawnParticle(false);
        }
    }
}

// ===================== RENDERING =====================
function drawTank() {
    const t=S.tank;
    const g = cx.createRadialGradient(t.x+t.w/2,t.y+t.h/2,0, t.x+t.w/2,t.y+t.h/2,Math.max(t.w,t.h)*0.7);
    g.addColorStop(0, CFG.COL_WATER_B); g.addColorStop(1, CFG.COL_WATER_A);
    cx.fillStyle = g; cx.fillRect(t.x,t.y,t.w,t.h);
    // Ripples
    cx.save(); cx.globalAlpha=0.035; cx.strokeStyle="#4a9af0"; cx.lineWidth=0.8;
    for (let i=0;i<10;i++) {
        const rx=t.x+t.w*((i*0.17+S.t*0.02)%1);
        const ry=t.y+t.h*((i*0.23+S.t*0.015)%1);
        const r=12+Math.sin(S.t*0.4+i*1.1)*8;
        cx.beginPath(); cx.arc(rx,ry,r,0,Math.PI*2); cx.stroke();
    }
    cx.restore();
    // Downwind zone subtle highlight (only in wall mode)
    if (S.mode === 'wall') {
        const b = downwindBounds();
        cx.fillStyle = "rgba(10,50,80,0.15)";
        cx.fillRect(b.x0, b.y0, b.x1-b.x0, b.y1-b.y0);
        // Downwind label
        cx.fillStyle="rgba(74,160,240,0.3)"; cx.font="10px Segoe UI";
        cx.textAlign="center";
        cx.fillText("Zona downwind (turbinas)", (b.x0+b.x1)/2, b.y1+12);
        cx.textAlign="left";
    }
    // Labels
    cx.strokeStyle="#2a4a6a"; cx.lineWidth=2; cx.strokeRect(t.x,t.y,t.w,t.h);
    cx.fillStyle="#2a4a6a"; cx.font="11px Segoe UI";
    cx.fillText("Tanque de agua", t.x+6, t.y+14);
}

function drawWallSegment(x0,y0,x1,y1) {
    cx.beginPath();cx.moveTo(x0,y0);cx.lineTo(x1,y1);
    cx.strokeStyle=CFG.COL_WALL;cx.lineWidth=CFG.WALL_THICK;cx.lineCap="round";cx.stroke();
    cx.beginPath();cx.moveTo(x0,y0);cx.lineTo(x1,y1);
    cx.strokeStyle="rgba(106,122,154,0.2)";cx.lineWidth=CFG.WALL_THICK+6;cx.stroke();
}

function drawWall() {
    const t=S.tank, wc=wallCoord(), holes=holePos();
    const V = isVert();

    // Sort holes by their position along the wall
    const sorted = holes.slice().sort((a,b) => V ? a.y-b.y : a.x-b.x);

    // Draw wall segments between holes
    let cur = V ? t.y : t.x;
    const wallEnd = V ? t.y+t.h : t.x+t.w;

    for (const h of sorted) {
        const holeStart = V ? h.y-h.hs : h.x-h.hs;
        const holeEnd = V ? h.y+h.hs : h.x+h.hs;
        if (cur < holeStart) {
            if (V) drawWallSegment(wc,cur, wc,holeStart);
            else   drawWallSegment(cur,wc, holeStart,wc);
        }
        cur = Math.max(cur, holeEnd);
    }
    if (cur < wallEnd) {
        if (V) drawWallSegment(wc,cur, wc,wallEnd);
        else   drawWallSegment(cur,wc, wallEnd,wc);
    }

    // Draw holes with glow
    for (let i=0;i<sorted.length;i++) {
        const h=sorted[i];
        const pulse=0.7+0.3*Math.sin(S.t*2+i);
        cx.save(); cx.shadowColor=CFG.COL_HOLE; cx.shadowBlur=8*pulse;
        cx.beginPath();
        if (V) { cx.moveTo(wc,h.y-h.hs); cx.lineTo(wc,h.y+h.hs); }
        else   { cx.moveTo(h.x-h.hs,wc); cx.lineTo(h.x+h.hs,wc); }
        cx.strokeStyle=CFG.COL_HOLE;cx.lineWidth=3;cx.stroke();
        cx.restore();
        // Markers
        cx.fillStyle=CFG.COL_HOLE;
        if (V) {
            cx.beginPath();cx.arc(wc,h.y-h.hs,3,0,Math.PI*2);cx.fill();
            cx.beginPath();cx.arc(wc,h.y+h.hs,3,0,Math.PI*2);cx.fill();
        } else {
            cx.beginPath();cx.arc(h.x-h.hs,wc,3,0,Math.PI*2);cx.fill();
            cx.beginPath();cx.arc(h.x+h.hs,wc,3,0,Math.PI*2);cx.fill();
        }
        // Label
        cx.font="10px Segoe UI"; cx.fillStyle=CFG.COL_HOLE;
        if (V) {
            const ls = WIND_DIRS[S.windDir].dx >= 0 ? 10 : -60;
            cx.fillText(`Agujero ${i+1}`, wc+ls, h.y+3);
            cx.fillStyle="rgba(74,240,160,0.4)";
            cx.fillText("↕ arrastra", wc+ls, h.y+14);
        } else {
            cx.textAlign="center";
            const ls = WIND_DIRS[S.windDir].dy >= 0 ? 14 : -10;
            cx.fillText(`Agujero ${i+1}`, h.x, wc+ls);
            cx.fillStyle="rgba(74,240,160,0.4)";
            cx.fillText("↔ arrastra", h.x, wc+ls+11);
            cx.textAlign="left";
        }
    }
    // Wall label
    cx.fillStyle="#5a7a9a";cx.font="10px Segoe UI";cx.textAlign="center";
    if (V) { cx.fillText("Pared",wc,t.y-8); }
    else   { cx.fillText("Pared",t.x-20,wc+4); cx.textAlign="right"; }
    cx.textAlign="left";
}

function drawWindField() {
    if (!S.showField) return;
    const t=S.tank, w=WIND_DIRS[S.windDir];
    const step=28;
    for (let x=t.x+step/2;x<t.x+t.w;x+=step) {
        for (let y=t.y+step/2;y<t.y+t.h;y+=step) {
            const v = windAt(x,y);
            const int = clamp(v/S.windSpeed, 0, 1);
            cx.save(); cx.globalAlpha=0.2*int+0.05;
            const len=10*int;
            const ang=Math.atan2(w.dy,w.dx);
            cx.beginPath();
            cx.moveTo(x-w.dx*len*0.3,y-w.dy*len*0.3);
            cx.lineTo(x+w.dx*len,y+w.dy*len);
            cx.strokeStyle = int>0.35 ? "#4af0a0" : "#f06a4a";
            cx.lineWidth=1;cx.stroke();
            const ax=x+w.dx*len, ay=y+w.dy*len;
            cx.beginPath();cx.moveTo(ax,ay);
            cx.lineTo(ax-Math.cos(ang-0.5)*4,ay-Math.sin(ang-0.5)*4);
            cx.moveTo(ax,ay);
            cx.lineTo(ax-Math.cos(ang+0.5)*4,ay-Math.sin(ang+0.5)*4);
            cx.stroke(); cx.restore();
        }
    }
}

function drawParticles() {
    if (!S.showWind) return;
    for (const p of S.particles) {
        if (!inTank(p.x,p.y)) continue;
        const v=windAt(p.x,p.y);
        const int=clamp(v/S.windSpeed,0,1);
        cx.beginPath();
        cx.arc(p.x,p.y,p.sz*(0.3+int*0.7),0,Math.PI*2);
        cx.fillStyle=`rgba(120,200,255,${p.life*int*0.5})`;
        cx.fill();
    }
}

function drawWake() {
    if (!S.showWake) return;
    const w=WIND_DIRS[S.windDir], px=-w.dy, py=w.dx;
    for (const turb of S.turbines) {
        const cl=400, r0=turbR(), r1=r0+CFG.WAKE_K*cl;
        cx.beginPath();
        cx.moveTo(turb.x+px*r0, turb.y+py*r0);
        cx.lineTo(turb.x+w.dx*cl+px*r1, turb.y+w.dy*cl+py*r1);
        cx.lineTo(turb.x+w.dx*cl-px*r1, turb.y+w.dy*cl-py*r1);
        cx.lineTo(turb.x-px*r0, turb.y-py*r0);
        cx.closePath();
        const g=cx.createLinearGradient(turb.x,turb.y, turb.x+w.dx*cl,turb.y+w.dy*cl);
        g.addColorStop(0,"rgba(255,70,50,0.12)");
        g.addColorStop(0.4,"rgba(255,100,50,0.06)");
        g.addColorStop(1,"rgba(255,140,50,0.01)");
        cx.fillStyle=g; cx.fill();
        cx.setLineDash([4,6]); cx.strokeStyle="rgba(255,80,50,0.1)"; cx.lineWidth=1;
        cx.beginPath();
        cx.moveTo(turb.x+px*r0,turb.y+py*r0);
        cx.lineTo(turb.x+w.dx*cl+px*r1,turb.y+w.dy*cl+py*r1);
        cx.moveTo(turb.x-px*r0,turb.y-py*r0);
        cx.lineTo(turb.x+w.dx*cl-px*r1,turb.y+w.dy*cl-py*r1);
        cx.stroke(); cx.setLineDash([]);
    }
}

function drawScanOverlay() {
    for (const turb of S.turbines) {
        if (!turb.scanPts || turb.phase === 'waiting' || turb.phase === null) continue;
        // Show scan points (persist during scanning AND moving phases)
        const showAll = turb.phase === 'scanning' || turb.phase === 'moving';
        if (!showAll && turb.phase !== 'refining') continue;
        const maxShow = turb.phase === 'scanning' ? turb.scanIdx : turb.scanPts.length;
        for (let i=0; i<maxShow; i++) {
            const sp=turb.scanPts[i];
            if (sp.v<0) continue;
            const int=clamp(sp.v/S.windSpeed,0,1);
            const r = 2 + int * 2;
            cx.beginPath(); cx.arc(sp.x, sp.y, r, 0, Math.PI*2);
            // Color: green=good wind, red=no wind
            const g = Math.round(100 + 155*int);
            const rb = Math.round(100*(1-int));
            cx.fillStyle = `rgba(${rb},${g},${rb+60},${0.1+int*0.4})`;
            cx.fill();
        }
        // Pulsing best-position marker
        if (turb.bestScan.v>0) {
            const pulse = 6 + 3*Math.sin(S.t*4);
            cx.save(); cx.shadowColor="#4af0a0"; cx.shadowBlur=15;
            cx.beginPath(); cx.arc(turb.bestScan.x, turb.bestScan.y, pulse, 0, Math.PI*2);
            cx.strokeStyle="#4af0a0"; cx.lineWidth=2; cx.stroke();
            cx.restore();
            // Cross-hair
            cx.strokeStyle="rgba(74,240,160,0.5)"; cx.lineWidth=1;
            cx.beginPath();
            cx.moveTo(turb.bestScan.x-10, turb.bestScan.y);
            cx.lineTo(turb.bestScan.x+10, turb.bestScan.y);
            cx.moveTo(turb.bestScan.x, turb.bestScan.y-10);
            cx.lineTo(turb.bestScan.x, turb.bestScan.y+10);
            cx.stroke();
        }
        // Scanning beam effect: line from turbine to current scan point
        if (turb.phase === 'scanning' && turb.scanIdx < turb.scanPts.length) {
            const sp = turb.scanPts[Math.min(turb.scanIdx, turb.scanPts.length-1)];
            cx.save(); cx.globalAlpha=0.3;
            cx.setLineDash([3,5]);
            cx.beginPath(); cx.moveTo(turb.x, turb.y); cx.lineTo(sp.x, sp.y);
            cx.strokeStyle="#4af0a0"; cx.lineWidth=1; cx.stroke();
            cx.setLineDash([]);
            cx.restore();
        }
    }
}

function drawTurbine(turb, idx) {
    const {x,y,bladeAngle}=turb;
    const col=CFG.COL_BLADE[idx%CFG.COL_BLADE.length];
    const tr = turbR(), bl = bladeLen();
    // Movement range circle
    if (turb.homeX !== undefined) {
        cx.save();
        cx.beginPath(); cx.arc(turb.homeX, turb.homeY, CFG.MOVE_RANGE, 0, Math.PI*2);
        cx.setLineDash([6,6]);
        cx.strokeStyle = `rgba(${hexToRgb(col)},0.2)`;
        cx.lineWidth = 1; cx.stroke();
        cx.setLineDash([]);
        // Home position small marker
        cx.beginPath(); cx.arc(turb.homeX, turb.homeY, 3, 0, Math.PI*2);
        cx.fillStyle = `rgba(${hexToRgb(col)},0.3)`; cx.fill();
        cx.restore();
    }
    // Trail
    if (turb.trail && turb.trail.length>1) {
        let alpha = 0.3;
        if (turb.trailFadeStart > 0) {
            const elapsed = S.t - turb.trailFadeStart;
            const fade = 1 - elapsed / CFG.TRAIL_FADE_TIME;
            if (fade <= 0) { turb.trail = []; }
            else alpha = 0.3 * fade;
        }
        if (turb.trail.length > 1) {
            cx.save(); cx.globalAlpha=alpha; cx.strokeStyle=col; cx.lineWidth=1.5;
            cx.beginPath(); cx.moveTo(turb.trail[0].x, turb.trail[0].y);
            for (let i=1;i<turb.trail.length;i++) cx.lineTo(turb.trail[i].x, turb.trail[i].y);
            cx.stroke(); cx.restore();
        }
    }
    // Platform
    cx.beginPath();cx.arc(x,y,tr+5,0,Math.PI*2);
    cx.fillStyle="rgba(30,50,80,0.45)";cx.fill();
    cx.strokeStyle="rgba(80,120,160,0.3)";cx.lineWidth=1;cx.stroke();
    // Search glow
    if (turb.phase==='moving'||turb.phase==='refining'||turb.phase==='scanning') {
        const gl=0.3+0.2*Math.sin(S.t*4);
        cx.beginPath();cx.arc(x,y,tr+10+Math.sin(S.t*3)*3,0,Math.PI*2);
        cx.strokeStyle=`rgba(74,240,160,${gl})`;cx.lineWidth=2;cx.stroke();
    }
    // Moving: dashed line to target
    if (turb.phase==='moving' && turb.targetX !== undefined) {
        cx.save(); cx.setLineDash([6,4]); cx.globalAlpha=0.4;
        cx.beginPath(); cx.moveTo(x,y); cx.lineTo(turb.targetX, turb.targetY);
        cx.strokeStyle=col; cx.lineWidth=1.5; cx.stroke();
        cx.setLineDash([]); cx.restore();
        cx.beginPath(); cx.arc(turb.targetX, turb.targetY, 4+Math.sin(S.t*5)*2, 0, Math.PI*2);
        cx.strokeStyle=col; cx.lineWidth=1.5; cx.stroke();
    }
    // Hub
    const hubR = S.mode === 'free' ? 7 : 5;
    cx.beginPath();cx.arc(x,y,hubR,0,Math.PI*2);
    cx.fillStyle="#c0c8d8";cx.fill();cx.strokeStyle="#8090a8";cx.lineWidth=1.5;cx.stroke();
    // Blades
    for (let i=0;i<3;i++) {
        const a=bladeAngle+i*Math.PI*2/3;
        const bx=x+Math.cos(a)*bl, by=y+Math.sin(a)*bl;
        cx.beginPath();cx.moveTo(x,y);cx.lineTo(bx,by);
        cx.strokeStyle=col;cx.lineWidth= S.mode==='free'?4:3;cx.lineCap="round";cx.stroke();
        cx.beginPath();cx.arc(bx,by, S.mode==='free'?3:2,0,Math.PI*2);cx.fillStyle=col;cx.fill();
    }
    // Voltage bar
    const bw=36,bh=4,bx2=x-bw/2,by2=y+tr+10;
    cx.fillStyle="rgba(0,0,0,0.5)";cx.fillRect(bx2,by2,bw,bh);
    const vp=clamp(turb.voltage/100,0,1);
    cx.fillStyle=vp>0.5?"#4af06a":vp>0.2?"#f0da4a":"#f04a4a";
    cx.fillRect(bx2,by2,bw*vp,bh);
    cx.strokeStyle="rgba(80,120,160,0.4)";cx.lineWidth=0.5;cx.strokeRect(bx2,by2,bw,bh);
    // Text
    cx.fillStyle="#b0c0d8";cx.font="10px Segoe UI";cx.textAlign="center";
    cx.fillText(`${turb.voltage.toFixed(1)}V`,x,by2+14);
    cx.fillStyle=col;cx.font="bold 9px Segoe UI";
    cx.fillText(`T${idx+1}`,x,y-tr-8);
    cx.textAlign="left";
}

// Helper to convert hex color to rgb components
function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `${r},${g},${b}`;
}

function drawWindArrow() {
    const t=S.tank, w=WIND_DIRS[S.windDir];
    const margin=20, al=22;
    const ax=t.x+t.w-margin-al, ay=t.y+margin+al+6;
    cx.save();cx.globalAlpha=0.65;
    cx.beginPath();
    cx.moveTo(ax-w.dx*al,ay-w.dy*al);cx.lineTo(ax+w.dx*al,ay+w.dy*al);
    cx.strokeStyle="#4a9af0";cx.lineWidth=3;cx.stroke();
    const tx=ax+w.dx*al, ty=ay+w.dy*al;
    const ang=Math.atan2(w.dy,w.dx);
    cx.beginPath();cx.moveTo(tx,ty);
    cx.lineTo(tx-Math.cos(ang-0.4)*9,ty-Math.sin(ang-0.4)*9);
    cx.lineTo(tx-Math.cos(ang+0.4)*9,ty-Math.sin(ang+0.4)*9);
    cx.closePath();cx.fillStyle="#4a9af0";cx.fill();
    cx.fillStyle="#6a9ad0";cx.font="11px Segoe UI";cx.textAlign="center";
    cx.fillText("Viento",ax,ay-al-6);
    cx.fillText(`${S.windSpeed.toFixed(1)} m/s`,ax,ay+al+16);
    cx.textAlign="left";cx.restore();
}

// ===================== UPDATE + RENDER =====================
function update(dt) {
    S.t += dt*0.016;
    updateParticles(dt);
    updateSearch(dt);
    continuousOptimize();
    for (const t of S.turbines) {
        const ws = windAt(t.x,t.y);
        t.voltage = windToVoltage(ws);
        t.bladeSpeed = ws*0.06;
        t.bladeAngle = (t.bladeAngle||0) + t.bladeSpeed*dt;
    }
}

function render() {
    cx.clearRect(0,0,W,H);
    cx.fillStyle="#060a14";cx.fillRect(0,0,W,H);
    drawTank();
    drawWindField();
    drawWake();
    if (S.mode === 'wall') drawWall();
    drawScanOverlay();
    drawParticles();
    for (let i=0;i<S.turbines.length;i++) drawTurbine(S.turbines[i],i);
    drawWindArrow();
    document.getElementById("info-turbines").textContent = S.turbines.length;
    document.getElementById("info-holes").textContent = S.holes.length;
    updateTurbineList();
}

let lastT = performance.now();
function loop(now) {
    const dt = Math.min((now-lastT)/16.67, 3);
    lastT = now;
    update(dt); render();
    requestAnimationFrame(loop);
}

// ===================== UI =====================
function setStatus(txt) { document.getElementById("info-status").textContent=txt; }

function spawnTurbine() {
    const b = globalBounds();
    // Try to find a position that doesn't overlap existing turbines
    let px, py, attempts = 0;
    do {
        px = b.x0 + Math.random()*(b.x1-b.x0);
        py = b.y0 + Math.random()*(b.y1-b.y0);
        attempts++;
    } while (attempts < 50 && S.turbines.some(t => dist(px,py,t.x,t.y) < minTurbDist()));
    const turb = {
        x: px, y: py,
        homeX: px, homeY: py,  // Home position for range constraint
        bladeAngle: Math.random()*Math.PI*2,
        bladeSpeed:0, voltage:0,
        phase:null, trail:[], scanPts:null,
        trailAlpha: 0, trailFadeStart: 0,
        id: Date.now()+Math.random(),
    };
    S.turbines.push(turb);
    updateTurbineList();
}

function setupUI() {
    // Wind buttons
    document.querySelectorAll(".wind-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            S.windDir = parseInt(btn.dataset.dir);
            document.querySelectorAll(".wind-btn").forEach(b=>b.classList.remove("active"));
            btn.classList.add("active");
            initParticles();
            // Move turbines into new zone (only clamp in wall mode)
            if (S.mode === 'wall') {
                const b = globalBounds();
                for (const t of S.turbines) {
                    t.x = clamp(t.x, b.x0, b.x1);
                    t.y = clamp(t.y, b.y0, b.y1);
                    t.homeX = clamp(t.homeX, b.x0, b.x1);
                    t.homeY = clamp(t.homeY, b.y0, b.y1);
                    t.trail = [];
                }
            }
            if (S.turbines.some(t=>t.phase==='done')) startSearch();
        });
    });

    document.getElementById("wind-speed").addEventListener("input", e => {
        S.windSpeed = parseFloat(e.target.value);
        document.getElementById("wind-speed-val").textContent = S.windSpeed.toFixed(1);
    });

    document.getElementById("wall-position").addEventListener("input", e => {
        S.wallPct = parseInt(e.target.value);
        document.getElementById("wall-pos-val").textContent = S.wallPct;
        // Re-clamp turbines
        const b = globalBounds();
        for (const t of S.turbines) {
            t.x = clamp(t.x, b.x0, b.x1);
            t.y = clamp(t.y, b.y0, b.y1);
            t.homeX = clamp(t.homeX, b.x0, b.x1);
            t.homeY = clamp(t.homeY, b.y0, b.y1);
        }
        if (S.turbines.some(t=>t.phase==='done')) startSearch();
    });

    // Mode toggle
    document.getElementById("btn-mode-wall").addEventListener("click", () => {
        S.mode = 'wall';
        document.getElementById("btn-mode-wall").classList.add("active");
        document.getElementById("btn-mode-free").classList.remove("active");
        document.getElementById("wall-section").classList.remove("hidden-section");
        // Reset turbines to downwind zone
        S.searching = false;
        const b = globalBounds();
        for (const t of S.turbines) {
            t.x = clamp(t.x, b.x0, b.x1);
            t.y = clamp(t.y, b.y0, b.y1);
            t.homeX = t.x; t.homeY = t.y;
            t.phase = null; t.trail = [];
        }
        initParticles();
        setStatus("Esperando");
    });
    document.getElementById("btn-mode-free").addEventListener("click", () => {
        S.mode = 'free';
        document.getElementById("btn-mode-free").classList.add("active");
        document.getElementById("btn-mode-wall").classList.remove("active");
        document.getElementById("wall-section").classList.add("hidden-section");
        // Reset turbines for free mode
        S.searching = false;
        const b = globalBounds();
        for (const t of S.turbines) {
            t.x = clamp(t.x, b.x0, b.x1);
            t.y = clamp(t.y, b.y0, b.y1);
            t.homeX = t.x; t.homeY = t.y;
            t.phase = null; t.trail = [];
        }
        initParticles();
        setStatus("Modo libre");
    });

    // Movement range slider
    document.getElementById("move-range").addEventListener("input", e => {
        CFG.MOVE_RANGE = parseInt(e.target.value);
        document.getElementById("move-range-val").textContent = CFG.MOVE_RANGE;
    });

    document.getElementById("btn-add-turbine").addEventListener("click", spawnTurbine);
    document.getElementById("btn-remove-turbine").addEventListener("click", () => {
        if (S.turbines.length) { S.turbines.pop(); updateTurbineList(); }
    });

    // Wall orientation buttons
    document.getElementById("btn-wall-v").addEventListener("click", () => {
        S.wallOrient = 'vertical';
        document.getElementById("btn-wall-v").classList.add("active");
        document.getElementById("btn-wall-h").classList.remove("active");
        document.getElementById("wall-pos-label").textContent = "Posición X";
        const b = globalBounds();
        for (const t of S.turbines) {
            t.x = clamp(t.x, b.x0, b.x1);
            t.y = clamp(t.y, b.y0, b.y1);
            t.homeX = clamp(t.homeX, b.x0, b.x1);
            t.homeY = clamp(t.homeY, b.y0, b.y1);
            t.trail = [];
        }
        initParticles();
        if (S.turbines.some(t=>t.phase==='done')) startSearch();
    });
    document.getElementById("btn-wall-h").addEventListener("click", () => {
        S.wallOrient = 'horizontal';
        document.getElementById("btn-wall-h").classList.add("active");
        document.getElementById("btn-wall-v").classList.remove("active");
        document.getElementById("wall-pos-label").textContent = "Posición Y";
        const b = globalBounds();
        for (const t of S.turbines) {
            t.x = clamp(t.x, b.x0, b.x1);
            t.y = clamp(t.y, b.y0, b.y1);
            t.homeX = clamp(t.homeX, b.x0, b.x1);
            t.homeY = clamp(t.homeY, b.y0, b.y1);
            t.trail = [];
        }
        initParticles();
        if (S.turbines.some(t=>t.phase==='done')) startSearch();
    });

    document.getElementById("hole-size").addEventListener("input", e => {
        const val = parseInt(e.target.value);
        document.getElementById("hole-size-val").textContent = val;
        S.holes.forEach(h => h.size = val);
        if (S.turbines.some(t=>t.phase==='done')) startSearch();
    });

    document.getElementById("btn-add-hole").addEventListener("click", () => {
        // Place hole in the largest gap between existing holes
        const sorted = S.holes.map(h=>h.pct).sort((a,b)=>a-b);
        let best = 25; // default fallback
        let maxGap = 0;
        // Check gap before first hole
        if (sorted[0] > maxGap) { maxGap = sorted[0]; best = sorted[0] / 2; }
        // Gaps between consecutive holes
        for (let i=1; i<sorted.length; i++) {
            const gap = sorted[i] - sorted[i-1];
            if (gap > maxGap) { maxGap = gap; best = (sorted[i-1]+sorted[i])/2; }
        }
        // Gap after last hole
        const endGap = 100 - sorted[sorted.length-1];
        if (endGap > maxGap) { best = sorted[sorted.length-1] + endGap/2; }
        best = clamp(best, 8, 92);
        const holeSize = parseInt(document.getElementById("hole-size").value);
        S.holes.push({pct:best, size:holeSize});
        updateHoleList();
        if (S.turbines.some(t=>t.phase==='done')) startSearch();
    });

    document.getElementById("btn-remove-hole").addEventListener("click", () => {
        if (S.holes.length>1) { S.holes.pop(); updateHoleList(); }
        if (S.turbines.some(t=>t.phase==='done')) startSearch();
    });

    document.getElementById("btn-start-search").addEventListener("click", startSearch);
    document.getElementById("btn-reset").addEventListener("click", () => {
        S.searching=false;
        for (const t of S.turbines) {
            // Return to home position
            t.x = t.homeX; t.y = t.homeY;
            t.phase=null; t.trail=[];
        }
        setStatus("Esperando");
    });

    document.getElementById("chk-show-wake").addEventListener("change",e=>{S.showWake=e.target.checked;});
    document.getElementById("chk-show-wind").addEventListener("change",e=>{S.showWind=e.target.checked;});
    document.getElementById("chk-show-field").addEventListener("change",e=>{S.showField=e.target.checked;});

    cvs.addEventListener("mousedown", onDown);
    cvs.addEventListener("mousemove", onMove);
    cvs.addEventListener("mouseup", onUp);
    cvs.addEventListener("mouseleave", onUp);

    document.querySelector('.wind-btn[data-dir="0"]').classList.add("active");
}

function canvasXY(e) {
    const r=cvs.getBoundingClientRect();
    return { mx:e.clientX-r.left, my:e.clientY-r.top };
}

function holeHitTest(mx, my) {
    const wc=wallCoord(), holes=holePos(), V=isVert();
    for (let i=0;i<holes.length;i++) {
        const h=holes[i];
        if (V) {
            if (Math.abs(mx-wc)<25 && Math.abs(my-h.y)<h.hs+12) return i;
        } else {
            if (Math.abs(my-wc)<25 && Math.abs(mx-h.x)<h.hs+12) return i;
        }
    }
    return -1;
}

function onDown(e) {
    const {mx,my}=canvasXY(e);
    const hi = holeHitTest(mx,my);
    if (hi >= 0) {
        S.dragHole=hi; cvs.style.cursor=isVert()?"ns-resize":"ew-resize"; return;
    }
    if (!S.searching) {
        for (let i=0;i<S.turbines.length;i++) {
            if (dist(mx,my,S.turbines[i].x,S.turbines[i].y)<turbR()+8) {
                S.dragTurbine=i; cvs.style.cursor="grabbing"; return;
            }
        }
    }
}

function onMove(e) {
    const {mx,my}=canvasXY(e), t=S.tank;
    if (S.dragHole!==null) {
        if (isVert()) {
            S.holes[S.dragHole].pct = clamp((my-t.y)/t.h*100, 5, 95);
        } else {
            S.holes[S.dragHole].pct = clamp((mx-t.x)/t.w*100, 5, 95);
        }
        updateHoleList(); return;
    }
    if (S.dragTurbine!==null) {
        const b=globalBounds();
        const turb = S.turbines[S.dragTurbine];
        turb.x = clamp(mx, b.x0, b.x1);
        turb.y = clamp(my, b.y0, b.y1);
        // Update home position when manually dragging
        turb.homeX = turb.x;
        turb.homeY = turb.y;
        turb.phase=null;
        turb.trail=[];
        return;
    }
    // Cursor
    let cur="crosshair";
    if (holeHitTest(mx,my)>=0) cur = isVert()?"ns-resize":"ew-resize";
    if (cur==="crosshair" && !S.searching) {
        for (const tb of S.turbines) {
            if (dist(mx,my,tb.x,tb.y)<turbR()+8) { cur="grab"; break; }
        }
    }
    cvs.style.cursor=cur;
    // Tooltip
    const tip=document.getElementById("canvas-tooltip");
    let found=false;
    for (let i=0;i<S.turbines.length;i++) {
        const tb=S.turbines[i];
        if (dist(mx,my,tb.x,tb.y)<turbR()+8) {
            const ws=windAt(tb.x,tb.y);
            tip.classList.remove("hidden");
            tip.style.left=(mx+15)+"px"; tip.style.top=(my-30)+"px";
            tip.innerHTML=`<b>Turbina ${i+1}</b><br>Voltaje: ${tb.voltage.toFixed(1)}V<br>Viento: ${ws.toFixed(1)} m/s`;
            found=true; break;
        }
    }
    if (!found) tip.classList.add("hidden");
}

function onUp() {
    if (S.dragHole!==null) {
        S.dragHole=null; cvs.style.cursor="crosshair";
        if (S.turbines.some(t=>t.phase==='done')) startSearch();
    }
    if (S.dragTurbine!==null) { S.dragTurbine=null; cvs.style.cursor="crosshair"; }
}

function updateTurbineList() {
    document.getElementById("turbine-list").innerHTML = S.turbines.map((t,i) => {
        const col=CFG.COL_BLADE[i%CFG.COL_BLADE.length];
        const phaseLabel = t.phase==='scanning'?' [scan]':t.phase==='moving'?' [mov]':t.phase==='refining'?' [ref]':'';
        return `<div class="list-item"><span style="color:${col}">● T${i+1}${phaseLabel}</span><span class="voltage">${(t.voltage||0).toFixed(1)}V</span></div>`;
    }).join("");
}

function updateHoleList() {
    const axis = isVert() ? "Y" : "X";
    document.getElementById("hole-list").innerHTML = S.holes.map((h,i) =>
        `<div class="list-item"><span>Agujero ${i+1}</span><span>${axis}: ${h.pct.toFixed(0)}%</span></div>`
    ).join("");
    document.getElementById("info-holes").textContent = S.holes.length;
}

// ===================== INIT =====================
function init() {
    resize();
    window.addEventListener("resize", resize);
    setupUI();
    initParticles();
    updateHoleList();
    // Default: one turbine in downwind zone
    spawnTurbine();
    requestAnimationFrame(loop);
}
init();
})();
