# Floating Farm — Prototipo Físico (ESP32)

Este documento describe el hardware necesario para construir el prototipo que imita en el mundo físico el movimiento de **una** turbina seleccionada en el simulador. El simulador puede cambiar en caliente cuál turbina sigue el prototipo, así que el mismo dispositivo sirve para visualizar cualquier turbina del parque virtual.

---

## 1. BOM (Bill of Materials)

| # | Componente | Cantidad | Notas |
|---|------------|----------|-------|
| 1 | ESP32 DevKit V1 (38 pines) | 1 | Cualquier ESP32 con USB y al menos 5 GPIO libres sirve. |
| 2 | Driver paso a paso DRV8825 | 1 | Alternativa: A4988. Ajustar microstepping y corriente con `VREF`. |
| 3 | Motor NEMA17 1.8°/paso | 1 | 200 pasos/rev. Modelo típico: 17HS19-1684S. |
| 4 | Endstop mecánico (microswitch NC) | 1 | Con cable + conector. Se usa para homing. |
| 5 | Riel lineal + carro | 1 | MGN12 o V-slot, recorrido ≥ 100 mm. |
| 6 | Correa GT2 6 mm + polea 20T | 1 | O varilla roscada M8 + acople flexible si prefieres tornillo. |
| 7 | Fuente 12 V ≥ 2 A | 1 | Para alimentar el driver. La lógica del ESP32 va por USB. |
| 8 | Condensador electrolítico 100 µF / 25 V | 1 | A través de la entrada 12 V del driver. **Imprescindible**. |
| 9 | Cableado Dupont, prototipo | — | Hembra-hembra para conexiones rápidas. |
| 10 | Cable USB-C o micro-USB | 1 | El que corresponda al ESP32, para datos y alimentación lógica. |

Coste orientativo total: 30–45 €.

---

## 2. Pinout ESP32 ↔ DRV8825 ↔ NEMA17

Coincide con los `constexpr int PIN_*` definidos en `firmware/esp32/src/main.cpp`. Cámbialos ahí si modificas el cableado.

| Señal | ESP32 GPIO | DRV8825 pin | Notas |
|-------|------------|-------------|-------|
| STEP | GPIO 25 | STEP | Pulso por paso. |
| DIR | GPIO 26 | DIR | Sentido del giro. |
| ENABLE | GPIO 27 | EN | Activo en LOW (motor energizado). |
| ENDSTOP | GPIO 32 | — | Microswitch a GND, `INPUT_PULLUP`. NC: cerrado en reposo ⇒ LOW = tope tocado. |
| LED estado | GPIO 2 | — | LED on-board, ON mientras hay movimiento. |
| 3V3 | 3V3 | RESET, SLEEP | Para que el driver no se duerma. |
| GND | GND | GND (lógica) | Compartido con la masa de 12 V. |

El driver DRV8825 además necesita:

| Driver pin | A |
|------------|---|
| VMOT | + 12 V de la fuente externa. |
| GND (potencia) | – de la fuente externa **y** GND del ESP32 (masa común). |
| 1A, 1B | Bobina A del NEMA17 (negro/verde). |
| 2A, 2B | Bobina B del NEMA17 (rojo/azul). |
| M0, M1, M2 | Configuración de microstepping (ver tabla del datasheet). Para 1/16 µstep: HIGH-HIGH-LOW (con jumpers o atado a 3V3/GND). |

### Esquema en ASCII

```
        +12V ─────┬───── VMOT (DRV8825)
                  │
                  ├──┐
                  │  ═══ 100 µF / 25 V (entre VMOT y GND)
                  │  │
        GND ──────┴──┴─── GND  (DRV8825 lógica + potencia)
                              │
                              └─── GND (ESP32)

  ESP32  ────────────────────────────  DRV8825
   GPIO25 ─────────────────  STEP
   GPIO26 ─────────────────  DIR
   GPIO27 ─────────────────  EN     (LOW = enable)
    3V3   ─────────────────  RST + SLP

  DRV8825 1A,1B ── bobina A NEMA17 (negro/verde)
  DRV8825 2A,2B ── bobina B NEMA17 (rojo/azul)

  Microswitch endstop:
     COM ── GND
     NC  ── ESP32 GPIO32   (PULLUP interno)
```

> **Importante:** ajusta la corriente del DRV8825 girando el potenciómetro hasta que `VREF ≈ I_motor / 2`. Para 1.0 A por bobina, `VREF ≈ 0.5 V` medido entre el potenciómetro y GND con el motor desconectado.

---

## 3. Montaje mecánico mínimo

* El carro del riel se conecta a la correa GT2 (o tuerca del tornillo M8).
* El motor queda en un extremo, el endstop en el extremo opuesto a la dirección "negativa" del movimiento.
* El simulador envía valores `0..1000` per-mille; `0` debe corresponder al lado donde está el endstop y `1000` al extremo opuesto. Si te queda al revés, invierte `DIR` en `main.cpp` o cambia el signo en `STEPS_PER_MM`.

Ajusta en `firmware/esp32/src/main.cpp` según tu mecánica:

```cpp
constexpr long STEPS_PER_MM = 80;   // GT2 20T + microstep 1/16
constexpr long TRAVEL_MM    = 200;  // longitud útil del riel
constexpr float MAX_SPEED   = 2000; // pasos/s
constexpr float ACCEL       = 1500; // pasos/s^2
```

---

## 4. Protocolo serie

UART USB-CDC a **115200 baudios, 8N1, fin de línea `\n`**.

| Dirección | Comando | Significado |
|-----------|---------|-------------|
| Sim → ESP32 | `H` | Ejecuta homing (toca endstop, retrocede, fija posición = 0). |
| Sim → ESP32 | `M <p>` | Mueve a posición per-mille `p` ∈ `[0..1000]`. |
| Sim → ESP32 | `?` | Solicita posición actual. |
| Sim → ESP32 | `S` | Para el motor y lo desenergiza. |
| ESP32 → Sim | `READY` | Booteo y homing completados, listo para órdenes. |
| ESP32 → Sim | `HOMED` | Homing terminado correctamente. |
| ESP32 → Sim | `POS <p>` | Posición actual per-mille. |
| ESP32 → Sim | `ERR <msg>` | Error textual (cmd desconocido, no homed, payload inválido…). |
| ESP32 → Sim | `LOG <msg>` | Mensaje informativo (no es error). |

Toda mensajería ASCII, una línea por mensaje. El driver web (`src/core.mjs`) implementa formateadores (`formatHome`, `formatMove`, etc.) y el parser (`parseLine`) — están cubiertos por `tests/core.test.mjs` y `tests/protocol.test.mjs`.

---

## 5. Flujo de uso

1. Conecta el ESP32 al PC por USB.
2. Abre el simulador (`index.html`) en Chrome o Edge (Web Serial requiere uno de los dos).
3. Coloca las turbinas que quieras en el simulador.
4. En la sección **🔌 Prototipo Físico**, pulsa **Conectar prototipo** y elige el puerto.
5. Espera a ver el estado **Calibrado (home)** o **Listo**.
6. En el desplegable **Turbina vinculada**, elige qué turbina del simulador debe imitar el prototipo.
7. Pulsa **▶ Iniciar Búsqueda**. La turbina vinculada se moverá en el eje diagonal en el simulador y el motor del prototipo seguirá su posición en tiempo real.
8. Puedes cambiar la turbina vinculada en cualquier momento; el motor se moverá inmediatamente a la nueva posición.

> Si el estado muestra **Web Serial no soportado**, asegúrate de usar Chrome/Edge sirviendo el simulador desde `localhost` o HTTPS (no `file://`).

---

## 6. Cableado fotográfico (placeholder)

Pega aquí una foto del montaje real cuando tengas el prototipo armado:

```
docs/img/cabling.jpg      ← añadir cuando exista
```

Sugerencia: foto con el ESP32 a la izquierda, DRV8825 al centro, NEMA17 a la derecha, endstop visible en un extremo del riel, todas las etiquetas legibles.

---

## 7. Compilación firmware

```bash
cd firmware/esp32
pio run                 # compila
pio run -t upload       # flashea (ajusta puerto si pio no lo detecta solo)
pio device monitor      # consola serie a 115200
```

Si no usas PlatformIO, abre `firmware/esp32/src/main.cpp` desde el IDE de Arduino, instala la librería **AccelStepper** y selecciona la placa `ESP32 Dev Module`.
