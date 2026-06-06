# Floating Farm — Prototipo Físico (ESP32)

Este documento describe el hardware para construir el prototipo que imita el movimiento de **una** turbina seleccionada en el simulador. El prototipo usa **dos motores DC JGB-37** controlados por un **driver L298N** (dos salidas de motor), en esquinas opuestas del tanque, **sin endstops**: se asume que el montaje arranca en el **centro** (posición 500/500). Cuatro botones físicos permiten ajuste manual.

> **Nota sobre los motores DC:** a diferencia de un paso a paso, un JGB-37 sin encoder no conoce su posición. El firmware estima la posición **por tiempo** (lazo abierto): asume que tarda `TRAVEL_MS` en recorrer todo el rango. Por eso la posición física puede derivar poco a poco; usa el botón **Centro** o recoloca la turbina a mano para resincronizar. Si tu JGB-37 trae encoder, se puede pasar a lazo cerrado (ver §7).

---

## 1. BOM (Bill of Materials)

| # | Componente | Cantidad | Notas |
|---|------------|----------|-------|
| 1 | ESP32 DevKit V1 (38 pines) | 1 | USB + GPIO libres. |
| 2 | Driver L298N (doble puente H) | 1 | Controla los **dos** motores (OUT1/2 y OUT3/4). |
| 3 | Motor DC JGB-37 | 2 | Motorreductor DC (6–12V según versión). |
| 4 | Pulsador táctil | 4 | Izquierda, derecha, tensar, destensar. |
| 5 | Fuente para motores | 1 | Según el JGB-37 (típico 6V o 12V) ≥ 1A. |
| 6 | Cable/pita para arrastre | ~4 m | Un cable por motor hacia la turbina. |
| 7 | Cableado Dupont | — | Hembra-hembra. |
| 8 | Cable USB | 1 | Datos + alimentación lógica del ESP32. |

Coste orientativo: 18–30 €.

---

## 2. Pinout ESP32 ↔ L298N

Coincide con `firmware/arduino/FloatingFarm/FloatingFarm.ino`.

### Motor A (esquina 1) → salida OUT1/OUT2 del L298N

| Señal ESP32 | GPIO | L298N |
|-------------|------|-------|
| ENA (PWM) | **13** | ENA |
| IN1 | **25** | IN1 |
| IN2 | **26** | IN2 |
| — | — | OUT1 → motor A (+) |
| — | — | OUT2 → motor A (–) |

### Motor B (esquina 2) → salida OUT3/OUT4 del L298N

| Señal ESP32 | GPIO | L298N |
|-------------|------|-------|
| ENB (PWM) | **23** | ENB |
| IN3 | **27** | IN3 |
| IN4 | **14** | IN4 |
| — | — | OUT3 → motor B (+) |
| — | — | OUT4 → motor B (–) |

> Quita los **jumpers** de ENA y ENB del L298N para controlar la velocidad por PWM desde el ESP32. Si los dejas puestos, los motores van siempre a tope.

### Alimentación del L298N

| Pin L298N | Conectar a |
|-----------|------------|
| **+12V / VS** | + de la fuente de motores (la tensión de tus JGB-37) |
| **GND** | GND de la fuente **y** GND del ESP32 (masa común) |
| **+5V** | Salida lógica 5V del L298N (déjalo; si tu fuente es >12V, valora el jumper de 5V). No alimentes el ESP32 desde aquí: el ESP32 va por USB. |

### Botones manuales (INPUT_PULLUP, LOW = pulsado)

| Botón | GPIO | Acción (mantener pulsado) |
|-------|------|---------------------------|
| Izquierda | **32** | Mueve hacia esquina A (A recoge, B suelta) |
| Derecha | **33** | Mueve hacia esquina B (A suelta, B recoge) |
| Tensar | **18** | Ambos recogen cable |
| Destensar | **19** | Ambos sueltan cable |

Cableado de cada botón: un terminal a **GPIO**, el otro a **GND**.

### LED

| Señal | GPIO | Notas |
|-------|------|-------|
| LED estado | 2 | On-board, ON mientras algún motor se mueve |

### Esquema en ASCII

```
   FUENTE MOTORES ──► +12V/VS (L298N)
                 └──► GND (L298N) ──┬── GND (ESP32)   ← masa común
                                     │
   ESP32                          L298N
    GPIO13 ───────────────────── ENA  (quitar jumper)
    GPIO25 ───────────────────── IN1
    GPIO26 ───────────────────── IN2     OUT1/OUT2 → Motor A (JGB-37)
    GPIO23 ───────────────────── ENB  (quitar jumper)
    GPIO27 ───────────────────── IN3
    GPIO14 ───────────────────── IN4     OUT3/OUT4 → Motor B (JGB-37)

   Botón Izq:  GPIO32 ──[ ]── GND
   Botón Der:  GPIO33 ──[ ]── GND
   Botón Tens: GPIO18 ──[ ]── GND
   Botón Dest: GPIO19 ──[ ]── GND
```

> **Importante:** el ESP32 se alimenta por **USB**; los motores por la **fuente externa** vía L298N. Une todas las masas (GND).

---

## 3. Montaje y posición inicial

```
   ┌─────────────────────────────┐
   │  Motor A          Motor B   │
   │   ╲                  ╱      │
   │    ╲    ● turbina   ╱       │  ← turbina en el CENTRO al encender
   │     ╲              ╱        │
   └─────────────────────────────┘
```

- **Antes de encender:** coloca la turbina en el centro del recorrido y deja los cables con holgura moderada.
- Al boot el firmware **asume** posición 500/500 sin mover los motores.
- Si la posición física se desfasa (deriva del lazo abierto), pulsa **Centro** (comando `H`) y/o recoloca la turbina a mano.

### Coordenadas

- `pA`, `pB` ∈ [0..1000] per-mille por motor.
- Centro: **500 / 500**.
- Modo simulador (turbina vinculada): `pA = posición`, `pB = 1000 - pA`.

Ajusta en `FloatingFarm.ino`:

```cpp
const float MM_PER_SIDE = 100.0f;  // distancia máx. a cada lado del centro (mm)
const float MM_PER_S    = 50.0f;   // velocidad real del cable a MOTOR_PWM (mídela)
const int   MOTOR_PWM   = 200;     // 0..255 velocidad (sube si no arranca)
const long  JOG_PER_MILLE = 8;     // paso por pulsación de botón
```

`TRAVEL_MS` se calcula solo a partir de `MM_PER_SIDE` y `MM_PER_S`. Ver §3.1 para el procedimiento completo de calibración.

Si un motor gira al revés, intercambia sus dos cables en OUT1/OUT2 (o OUT3/OUT4).

### 3.1. Calibración paso a paso

1. **Sentido de giro.** Tras `H`, pulsa **Der →**. Si la turbina va al lado equivocado, intercambia los dos cables de ese motor en el L298N (OUT1/OUT2 o OUT3/OUT4).
2. **`MOTOR_PWM`.** Sube desde ~150 hasta que ambos motores arranquen suaves sin tirones (típico 180–230). Si van demasiado rápido para seguir la web, bájalo.
3. **Distancia máxima por lado (`MM_PER_SIDE`).** Decide cuántos mm quieres que la turbina se aleje del centro hacia **cada** lado (el recorrido total será el doble). Ponlo en el sketch.
4. **Velocidad real (`MM_PER_S`).** Mídela: parte del centro (`H`), manda `M 1000 500` y cronometra; recorre `MM_PER_SIDE` mm. Entonces `MM_PER_S = MM_PER_SIDE / segundos`. Ajusta la constante y vuelve a subir el sketch.
5. **Verifica.** `H` (centro) → `M 1000 0` debe llevar la turbina justo a `MM_PER_SIDE` mm de un extremo, y `M 0 1000` al otro. Si se queda corto o se pasa, corrige `MM_PER_S`.
6. **Jog de botones.** `JOG_PER_MILLE` (cuánto avanza por pulsación) y `JOG_INTERVAL_MS` (cada cuánto repite al mantener). Súbelos para mover más rápido a mano.

### 3.2. Relación con la web

El simulador trabaja en per-mille **normalizado**, así que la proporción siempre se mantiene:

```
Web:        −MOVE_RANGE ........ 0 (centro) ........ +MOVE_RANGE
per-mille:        0 ............. 500 ............... 1000
Maqueta:    −MM_PER_SIDE ..... 0 (centro) ....... +MM_PER_SIDE
```

- `MOVE_RANGE` (en `sim.jsx`, por defecto **130 px**) es el desplazamiento máximo de la turbina en el simulador. Mapea linealmente al rango físico completo.
- No hace falta tocar nada para que coincidan: la web manda per-mille y la maqueta lo escala a `±MM_PER_SIDE`.
- Si quieres que la web esté **a escala real** (que 1 px del simulador = X mm reales), elige `MM_PER_SIDE = MOVE_RANGE × X`. Ej.: si `MOVE_RANGE = 130` y quieres 1 px = 1 mm → `MM_PER_SIDE = 130`.

---

## 4. Protocolo serie

115200 baud, 8N1, fin de línea `\n`.

| Dirección | Comando | Significado |
|-----------|---------|-------------|
| Sim → ESP32 | `H` | Ir al centro (500/500) |
| Sim → ESP32 | `M <pA> <pB>` | Mover ambos motores |
| Sim → ESP32 | `M <p>` | Legado: A=p, B=1000-p |
| Sim → ESP32 | `J L` | Jog izquierda (un paso) |
| Sim → ESP32 | `J R` | Jog derecha |
| Sim → ESP32 | `J T` | Tensar (un paso) |
| Sim → ESP32 | `J D` | Destensar (un paso) |
| Sim → ESP32 | `?` | Consultar posición |
| Sim → ESP32 | `S` | Parar motores |
| ESP32 → Sim | `READY` | Listo (centro asumido al boot) |
| ESP32 → Sim | `HOMED` | Centrado completado |
| ESP32 → Sim | `POS <pA> <pB>` | Posición estimada actual |
| ESP32 → Sim | `ERR <msg>` | Error |
| ESP32 → Sim | `LOG <msg>` | Log |

---

## 5. Flujo de uso

1. Coloca la turbina en el **centro** y enciende el ESP32 por USB + la fuente de motores.
2. Sube el firmware (`FloatingFarm.ino` desde Arduino IDE).
3. Abre el simulador en Chrome/Edge vía `localhost`.
4. **§03 — RIG** → **Conectar** → elige el puerto COM.
5. Usa los botones **← Izq / Der → / Tensar / Destensar** en pantalla, o los **4 botones físicos** (mantener pulsados para mover de forma continua).
6. Vincula una turbina y pulsa **▶ Buscar óptimo** para seguimiento automático.

---

## 6. Subir firmware con Arduino IDE

1. Abre **`firmware/arduino/FloatingFarm/FloatingFarm.ino`** en Arduino IDE.
2. **Herramientas → Placa** → `ESP32 Dev Module` (instala el core *esp32* de Espressif si no lo tienes).
3. **Herramientas → Puerto** → el COM de tu ESP32.
4. Pulsa **Subir** (→). *(No requiere librerías externas.)*
5. **Herramientas → Monitor serie** → **115200** baud.

Deberías ver `LOG boot`, `LOG assumed center`, `HOMED`, `READY`.

### PlatformIO (opcional)

```bash
cd firmware/esp32
pio run -t upload
pio device monitor
```

---

## 7. Opcional: lazo cerrado con encoder

Si tus JGB-37 son la versión **con encoder** (6 cables: 2 motor + 2 alimentación del encoder + 2 señales A/B), puedes pasar a control con realimentación:

- El L298N **no** lee el encoder: sus dos canales (A/B) van a **GPIO de entrada** del ESP32 (con interrupciones).
- Se cuentan pulsos para conocer la posición real y cerrar un PID hacia el objetivo per-mille.
- Esto elimina la deriva del lazo abierto.

Si quieres esta versión, indícalo y se añade el conteo de encoder + PID manteniendo el mismo protocolo.
