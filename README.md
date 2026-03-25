# Simulador Sistema Flotante

Simulador visual e interactivo de aerogeneradores flotantes en un tanque de agua con efecto estela (wake effect). Basado en el proyecto [Floating Farm](https://github.com/leofdezzz/Sistema-Flotante) que utiliza un Raspberry Pi Pico para controlar un aerogenerador flotante real.

## Descripcion

El simulador permite visualizar y experimentar con la colocacion optima de multiples aerogeneradores flotantes dentro de un tanque de agua. Una pared con agujeros actua como barrera fisica, y las turbinas deben posicionarse en el lado sotavento (downwind) para capturar el viento que pasa a traves de los agujeros, evitando el efecto estela entre ellas.

### Caracteristicas

- **Multiples aerogeneradores** con busqueda automatica de posicion optima
- **8 direcciones de viento** configurables en tiempo real
- **Pared con agujeros** draggables, en orientacion vertical u horizontal
- **Efecto estela** basado en el modelo Jensen/Park
- **Visualizacion** de campo de viento, particulas y conos de estela
- **Coordinacion global** entre turbinas para maximizar la produccion total

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

## Uso

1. Servir los archivos con cualquier servidor HTTP:
   ```bash
   python -m http.server 3000
   ```
2. Abrir `http://localhost:3000` en el navegador
3. Agregar aerogeneradores y agujeros en la pared
4. Pulsar **Iniciar Busqueda** para que las turbinas encuentren su posicion optima
5. Cambiar la direccion y velocidad del viento en tiempo real

---

## Tecnologias

- HTML5 Canvas para renderizado
- JavaScript vanilla (sin dependencias)
- Modelo fisico Jensen/Park para efecto estela
