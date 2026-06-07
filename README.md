# Simulador Sistema Flotante

Simulador visual e interactivo de aerogeneradores flotantes en un tanque de agua con efecto estela (wake effect). Basado en el proyecto [Floating Farm](https://github.com/leofdezzz/Sistema-Flotante) que utiliza un Raspberry Pi Pico para controlar un aerogenerador flotante real.

## Archivos

| Archivo | Descripcion |
|---------|-------------|
| `index.html` | Simulador principal con multiples aerogeneradores |
| `wall-optimizer.html` | Optimizador de un solo aerogenerador en modo pared |
| `simulator.js` | Logica del simulador principal |
| `style.css` | Estilos compartidos |

---

## Simulador Principal (`index.html`)

Permite visualizar y experimentar con la colocacion optima de multiples aerogeneradores flotantes dentro de un tanque de agua. Una pared con agujeros actua como barrera fisica, y las turbinas deben posicionarse en el lado sotavento (downwind) para capturar el viento que pasa a traves de los agujeros, evitando el efecto estela entre ellas.

### Caracteristicas

- **Multiples aerogeneradores** con busqueda automatica de posicion optima
- **8 direcciones de viento** configurables en tiempo real
- **Pared con agujeros** draggables, en orientacion vertical u horizontal
- **Efecto estela** basado en el modelo Jensen/Park
- **Visualizacion** de campo de viento, particulas y conos de estela
- **Coordinacion global** entre turbinas para maximizar la produccion total

---

## Optimizador de Pared (`wall-optimizer.html`)

Simulador de un unico aerogenerador con una pared fija en uno de los cuatro lados del tanque. Disenado para encontrar automaticamente la posicion optima del aerogenerador segun la posicion del agujero y la direccion del viento.

### Caracteristicas

- **Un aerogenerador** arrastrable con el raton
- **Pared en 4 posiciones** fijas: izquierda, derecha, arriba, abajo
- **Agujero** ajustable en posicion y tamano
- **4 diagonales de viento** seleccionables (la pared establece el cardinal correspondiente)
- **Modo bucle**: busca la posicion optima continuamente; si se mueve el agujero o cambia el viento, espera ~1 segundo de estabilidad y busca de nuevo
- **Panel de potencia** con voltaje y vatios en tiempo real
- **Campo de viento** con mapa de calor y flechas
- **Particulas** de flujo uniformes en todo el campo

### Uso

Abrir `wall-optimizer.html` directamente en el navegador (no requiere servidor).

1. Seleccionar el lado donde va la pared (izquierda, derecha, arriba, abajo)
2. Ajustar la posicion y tamano del agujero con los sliders
3. Opcionalmente seleccionar una diagonal de viento compatible con el lado de pared elegido
4. Pulsar **Buscar posicion optima** para entrar en modo bucle
5. Mover el agujero — el aerogenerador se reposicionara automaticamente al dejar de mover

---

## Modelo Matematico

### 1. Modelo de Estela (Jensen/Park)

El efecto estela modela como una turbina aguas arriba reduce la velocidad del viento para las turbinas que estan detras. Se utiliza el modelo Jensen con decaimiento Gaussiano radial.

#### Expansion del radio de estela

```
R(d) = R_turbina + k * d
```

Donde:
- `R_turbina = 18px` — radio del rotor
- `k = 0.08` — coeficiente de expansion de estela (WAKE_K)
- `d` — distancia aguas abajo (downstream)

#### Deficit de velocidad

```
deficit(d) = (2 * a) / (1 + k * d / R_turbina)^2
```

Donde `a = 0.33` es el factor de induccion axial (WAKE_A).

#### Decaimiento radial (Gaussiano)

```
wake(d, r) = deficit(d) * exp(-2 * (r / R(d))^2)
```

Donde `r` es la distancia perpendicular al eje de la estela. Esto produce un cono de estela que se expande linealmente con la distancia, con maxima reduccion en el centro y decaimiento suave hacia los bordes.

### 2. Campo de Viento

La velocidad del viento en cualquier punto `(x, y)` se calcula como:

```
V(x,y) = V_base * W(x,y) * PROD(1 - wake_i(x,y))
```

Donde:
- `V_base` — velocidad del viento configurada (1-15 m/s)
- `W(x,y)` — factor de pared (0 a 1)
- El productorio aplica el deficit de estela acumulado de todas las turbinas

#### Factor de Pared

La pared actua como barrera total. El viento solo pasa a traves de los agujeros. Para cada punto en el lado sotavento:

1. Se traza una linea desde el punto hasta la pared siguiendo la direccion del viento
2. Se calcula la posicion donde esa linea cruza la pared
3. Se evalua la influencia del agujero mas cercano:

```
influencia(d_h, d_w) = exp(-3 * (d_h / spread)^2) * (1 / (1 + d_w * 0.0008))
```

Donde:
- `d_h` — distancia al centro del agujero en la pared
- `d_w` — distancia perpendicular desde la pared
- `spread = tamanio_agujero/2 + d_w * 0.30` — el cono de viento se expande con la distancia

### 3. Modelo de Potencia

La relacion entre velocidad del viento y voltaje sigue la ley cubica de potencia eolica:

```
V_out = min(100, (V_viento / 15)^3 * 300)
```

Esto refleja que la potencia extraible del viento es proporcional al cubo de su velocidad (`P ~ v^3`), un principio fundamental de la aerodinamica eolica.

### 4. Rotacion de Aspas

```
omega = V_viento * 0.06    (velocidad angular)
theta(t) = theta(t-1) + omega * dt    (integracion temporal)
```

---

## Algoritmo de Busqueda

### Fase 1: Escaneo (Grid Search)

Se genera una malla de `22 x N` puntos sobre la zona sotavento. Cada punto se evalua con `windAt(x,y)` para encontrar el de mayor viento efectivo. Se procesan 24 puntos por frame para mantener la animacion fluida.

### Fase 2: Movimiento

La turbina se desplaza al mejor punto encontrado con velocidad `SEARCH_SPEED * ANIM_SPEED`.

### Fase 3: Refinamiento Local (Gradient Ascent)

Desde la posicion del grid, se ejecuta un ascenso por gradiente:

- **12 direcciones** equiespaciadas (cada 30 grados)
- **Paso de 8px** por iteracion
- **Umbral de mejora**: +0.01 m/s minimo
- **Maximo 25 iteraciones** o convergencia (sin mejora)
- Se respeta distancia minima entre turbinas (`MIN_TURB_DIST = 55px`)

### Fase 4: Secuencial

Las turbinas buscan una a una. Cada turbina considera las posiciones de las ya colocadas para evitar sus estelas. Esto asegura que no compitan por el mismo agujero.

### Fase 5: Refinamiento Global

Una vez todas las turbinas tienen posicion, se ejecuta una optimizacion simultanea:

- **Todas las turbinas se mueven a la vez**
- Cada una evalua 12 direcciones con paso de 6px
- Considera la estela de **todas** las demas turbinas
- **Maximo 30 iteraciones** o convergencia global

### Optimizacion Continua

Despues de la busqueda, un optimizador de baja intensidad sigue ajustando:

- **8 direcciones**, paso de 4px
- Umbral alto (+0.06 m/s) para evitar movimiento innecesario
- Movimiento de 0.5px por frame (imperceptible)

---

## Sistema de Particulas

400 particulas simulan el flujo de viento visible:

```
posicion += direccion_viento * velocidad_local * velocidad_particula * dt
vida -= 0.002 * dt
```

- Las particulas nacen en el borde de barlovento del tanque
- Su velocidad se modula por el campo de viento local (incluyendo estela y pared)
- Al morir o salir del tanque, se regeneran en el borde

---

## Configuracion

Al inicio de `simulator.js` hay una variable para controlar la velocidad de todas las animaciones:

```javascript
const ANIM_SPEED = 1.0;  // 1.0 = normal, 2.0 = doble, 0.5 = mitad
```

Parametros principales en `CFG`:

| Parametro | Valor | Descripcion |
|-----------|-------|-------------|
| `WAKE_K` | 0.08 | Coeficiente de expansion de estela |
| `WAKE_A` | 0.33 | Factor de induccion axial |
| `SEARCH_SPEED` | 3.0 | Velocidad base de movimiento |
| `SCAN_GRID` | 22 | Resolucion de la malla de escaneo |
| `MIN_TURB_DIST` | 55 | Distancia minima entre turbinas (px) |
| `WALL_MARGIN` | 45 | Distancia minima turbina-pared (px) |
| `TRAIL_FADE_TIME` | 2.0 | Tiempo de desvanecimiento del trail (s) |
| `PARTICLE_N` | 400 | Numero de particulas de viento |

---

## Iniciar el simulador (servidor local)

El simulador **no puede abrirse directamente con `file://`**. Necesita un servidor HTTP en `localhost` porque:
- `simulator.js` se carga como modulo ES (`<script type="module">`) y los modulos requieren origen `http(s)`.
- La Web Serial API (puente con el prototipo ESP32) tambien exige `localhost` o HTTPS y solo funciona en Chrome o Edge.

Cualquiera de estos comandos sirve la raiz del repo:

```bash
# Opcion A — Python (no instala nada en el proyecto)
python -m http.server 3000

# Opcion B — npm script equivalente (alias de la anterior)
npm run serve

# Opcion C — Node sin Python
npx http-server -p 3000 .
```

Despues abre **http://localhost:3000** en Chrome o Edge.

> Para detener el servidor: `Ctrl+C` en la terminal donde corre.

## Publicar en internet (acceso desde cualquier sitio)

El simulador es **solo archivos estaticos** (`index.html`, `app.jsx`, `sim.jsx`…). La forma mas sencilla es **GitHub Pages** (gratis, HTTPS):

| Opcion | URL tras desplegar | Dificultad |
|--------|-------------------|------------|
| **GitHub Pages** (recomendado) | https://leofdezzz.github.io/Simulador-Sistema-Flotante-L298N/ | Automatico con cada `git push` |
| Render static site | `https://tu-app.onrender.com` | Crear cuenta en [render.com](https://render.com), Static Site, repo GitHub |
| Netlify | `https://tu-app.netlify.app` | [netlify.com](https://netlify.com) → Import from Git |

### GitHub Pages (ya configurado en este repo)

1. Repositorio: **https://github.com/leofdezzz/Simulador-Sistema-Flotante-L298N**
2. Cada push a `master` despliega el simulador via GitHub Actions (`.github/workflows/pages.yml`).
3. La URL publica es: **https://leofdezzz.github.io/Simulador-Sistema-Flotante-L298N/**
4. La primera vez puede tardar 1–2 minutos; luego en **Settings → Pages** del repo veras el enlace.

> **Web Serial (ESP32):** el simulador web se abre desde cualquier PC o movil, pero **Conectar** al ESP32 solo funciona en **Chrome o Edge** en el **ordenador donde esta enchufado el USB** del ESP32 (HTTPS o localhost). Desde el movil puedes ver el simulador; para controlar la maqueta fisica usa el portatil con el cable USB.

### Tests

```bash
npm test
```

Ejecuta la suite `node --test` (geometria diagonal, protocolo serial contra un mock del ESP32, checks estaticos del firmware y del wiring del simulador). No requiere navegador ni hardware. Los pasos que dependen de PlatformIO se saltan automaticamente si `pio` no esta en el `PATH`.

### Firmware ESP32 (maqueta L298N + JGB-37)

Sketch para **Arduino IDE**: `firmware/arduino/FloatingFarm/FloatingFarm.ino`  
Detalles de cableado, calibracion y protocolo serie en [`docs/HARDWARE.md`](docs/HARDWARE.md).

Opcional con PlatformIO: `firmware/esp32/` (`pio run -t upload`).

## Flujo de uso

1. Abre `http://localhost:3000` (ver arriba).
2. Agrega aerogeneradores arrastrando con el raton.
3. (Opcional) En **🔌 Prototipo Fisico**: conecta el ESP32 por USB y elige que turbina debe imitar el motor.
4. Pulsa **▶ Iniciar Busqueda** para que las turbinas se reposicionen sobre su eje diagonal.
5. Cambia la direccion y velocidad del viento en tiempo real. El motor del prototipo sigue a la turbina vinculada.

---

## Tecnologias

- HTML5 Canvas para renderizado
- JavaScript vanilla (sin dependencias)
- Modelo fisico Jensen/Park para efecto estela
