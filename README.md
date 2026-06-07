# Simulador Sistema Flotante — L298N

Simulador web de aerogeneradores flotantes con efecto estela (Jensen/Park) y control de una **maqueta física** con ESP32, driver **L298N** y dos motores DC **JGB-37**.

**Demo en línea:** https://leofdezzz.github.io/Simulador-Sistema-Flotante-L298N/

---

## Estructura del proyecto

```
├── index.html              # Simulador (UI + estilos)
├── app.jsx                 # React: paneles, controles, Web Serial
├── sim.jsx                 # Motor de simulación Canvas
├── tweaks-panel.jsx        # Panel de ajustes visuales
├── src/core.mjs            # Lógica compartida + protocolo serie (tests)
├── firmware/
│   ├── arduino/FloatingFarm/FloatingFarm.ino   # Firmware ESP32 (Arduino IDE)
│   └── mock/mock-esp32.mjs                     # Mock para tests de protocolo
├── docs/HARDWARE.md        # Cableado, calibración, pinout L298N
└── tests/                  # Suite node --test
```

---

## Simulador web

Requiere **Chrome o Edge** y servir por HTTP (no `file://`).

```bash
# Local
python -m http.server 3000
# → http://localhost:3000

# O usa la URL pública de GitHub Pages (arriba)
```

### Uso rápido

1. Coloca turbinas arrastrando en el mapa.
2. **§03 — RIG → Conectar** (ESP32 por USB en el mismo PC).
3. Vincula una turbina y pulsa **▶ Buscar óptimo**.

> **Web Serial:** solo funciona en el ordenador donde está enchufado el ESP32.

---

## Firmware (Arduino IDE)

1. Abre `firmware/arduino/FloatingFarm/FloatingFarm.ino`
2. Instala el core **esp32 by Espressif** (Gestor de tarjetas)
3. Placa: **ESP32 Dev Module** · Monitor serie: **115200**
4. Sube el sketch (no requiere librerías externas)

Cableado, calibración (`MM_PER_SIDE`, `MM_PER_S`, `MOTOR_PWM`) y pinout en [`docs/HARDWARE.md`](docs/HARDWARE.md).

---

## Tests

```bash
npm test
```

Cubre geometría del eje diagonal, protocolo serie (mock ESP32) y comprobaciones estáticas del `.ino`.

---

## Despliegue

Cada push a `master` publica automáticamente en GitHub Pages (`.github/workflows/pages.yml`).

---

## Modelo físico (resumen)

- Estela Jensen/Park con deficit de velocidad aguas abajo.
- Potencia \(P \propto v^3\) con curva cúbica normalizada.
- Turbinas se desplazan a lo largo de un eje diagonal global (NE-SW o NW-SE).
- La maqueta recibe posiciones per-mille `0..1000` por motor vía protocolo serie v2.
