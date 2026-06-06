// ============================================================
// Floating Farm — ESP32 (Arduino IDE)
// 2× motor DC JGB-37 con driver L298N. Sin endstops, 4 botones.
//
// IMPORTANTE: los JGB-37 son motores DC (no paso a paso). Esta placa
// L298N NO usa ENA/ENB (van fijos a 5V con sus jumpers puestos), así
// que la velocidad (PWM) y el sentido se controlan en los pines IN.
// La posición se estima por TIEMPO (lazo abierto): no hay encoder,
// así que la posición física puede derivar; usa "Centro" o recoloca
// la turbina a mano para resincronizar.
//
// Arduino IDE:
//   1. Instalar soporte ESP32 (Board Manager → esp32 by Espressif)
//   2. Placa: ESP32 Dev Module
//   3. Puerto: tu COM del ESP32
//   4. Monitor serie: 115200 baud
//   (No requiere librerías externas.)
//
// Hardware: ver docs/HARDWARE.md en el repo.
// ============================================================

// ----- Motor A (esquina 1) → salida OUT1/OUT2 del L298N -------
// Sin ENA/ENB: el PWM (velocidad) se aplica directo sobre los pines IN.
// Deja los jumpers ENA/ENB del L298N PUESTOS (motores siempre habilitados).
const int PIN_A_IN1 = 25;   // IN1 (PWM + sentido)
const int PIN_A_IN2 = 26;   // IN2 (PWM + sentido)

// ----- Motor B (esquina 2) → salida OUT3/OUT4 del L298N -------
const int PIN_B_IN3 = 27;   // IN3 (PWM + sentido)
const int PIN_B_IN4 = 14;   // IN4 (PWM + sentido)

// ----- Botones (LOW = pulsado, INPUT_PULLUP) -----------------
const int PIN_BTN_LEFT  = 32;   // izquierda
const int PIN_BTN_RIGHT = 33;   // derecha
const int PIN_BTN_TENSE = 18;   // tensar
const int PIN_BTN_LOOSE = 19;   // destensar

const int PIN_LED = 2;

// ----- Geometría física del recorrido ------------------------
// MM_PER_SIDE = distancia máxima del cable desde el CENTRO hacia un
// lado (en mm). El rango completo (extremo a extremo) = 2*MM_PER_SIDE.
//   per-mille 500 = centro · 0 = un extremo · 1000 = el otro extremo.
// Relación con la web: ±CFG.MOVE_RANGE del simulador  ↔  ±MM_PER_SIDE real.
const float MM_PER_SIDE = 100.0f;   // mm a cada lado (ajústalo a tu maqueta)
const float MM_PER_S    = 50.0f;    // velocidad real del cable a MOTOR_PWM (mídela)

// ----- Movimiento (lazo abierto, por tiempo) -----------------
const int   MOTOR_PWM           = 200;    // 0..255 (sube si no arranca, baja si va rápido)
const long  CENTER_PER_MILLE    = 500;
const float DEADBAND            = 4.0;    // per-mille de tolerancia
const long  JOG_PER_MILLE       = 8;      // paso por pulsación / comando J
const unsigned long JOG_INTERVAL_MS = 70;

// Tiempo de recorrer todo el rango (0→1000 = 2*MM_PER_SIDE) y velocidad lógica.
const float TRAVEL_MM    = 2.0f * MM_PER_SIDE;
const float TRAVEL_MS    = (TRAVEL_MM / MM_PER_S) * 1000.0f;
const float SPEED_PER_MS = 1000.0f / TRAVEL_MS;   // per-mille por ms

bool  g_ready = false;
String g_inbuf;
float g_posA = 0;      // posición estimada (per-mille)
float g_posB = 0;
long  g_tgtA = 0;      // objetivo (per-mille)
long  g_tgtB = 0;
unsigned long g_lastJogMs = 0;
unsigned long g_lastMotionMs = 0;

void sendLine(const String& s) {
  Serial.print(s);
  Serial.print('\n');
}

void sendLOG(const String& s) { sendLine(String("LOG ") + s); }
void sendERR(const String& s) { sendLine(String("ERR ") + s); }

long clampPm(long p) {
  if (p < 0) return 0;
  if (p > 1000) return 1000;
  return p;
}

// dir > 0 → adelante, dir < 0 → atrás, dir == 0 → parado.
// Sin ENA/ENB: el PWM va sobre el pin IN activo; el otro a 0.
// (En ESP32, analogWrite(pin, 0) deja la salida en LOW.)
void driveMotor(int inX, int inY, int dir) {
  if (dir > 0) {
    analogWrite(inX, MOTOR_PWM);
    analogWrite(inY, 0);
  } else if (dir < 0) {
    analogWrite(inX, 0);
    analogWrite(inY, MOTOR_PWM);
  } else {
    analogWrite(inX, 0);
    analogWrite(inY, 0);
  }
}

void stopMotors() {
  driveMotor(PIN_A_IN1, PIN_A_IN2, 0);
  driveMotor(PIN_B_IN3, PIN_B_IN4, 0);
}

void sendCurrentPos() {
  sendLine(String("POS ") + (long)lround(g_posA) + " " + (long)lround(g_posB));
}

void assumeCenter() {
  g_posA = g_posB = (float)CENTER_PER_MILLE;
  g_tgtA = g_tgtB = CENTER_PER_MILLE;
  stopMotors();
  g_ready = true;
}

// Integra el movimiento hacia los objetivos. No bloqueante.
// Devuelve true si algún motor sigue moviéndose.
bool updateMotion() {
  unsigned long now = millis();
  float dt = (float)(now - g_lastMotionMs);
  g_lastMotionMs = now;
  if (dt <= 0) dt = 0;
  float maxStep = SPEED_PER_MS * dt;
  bool moving = false;

  // Motor A
  float dA = (float)g_tgtA - g_posA;
  if (fabs(dA) <= DEADBAND) {
    g_posA = (float)g_tgtA;
    driveMotor(PIN_A_IN1, PIN_A_IN2, 0);
  } else {
    int dir = (dA > 0) ? 1 : -1;
    float step = (fabs(dA) < maxStep) ? fabs(dA) : maxStep;
    g_posA += dir * step;
    driveMotor(PIN_A_IN1, PIN_A_IN2, dir);
    moving = true;
  }

  // Motor B
  float dB = (float)g_tgtB - g_posB;
  if (fabs(dB) <= DEADBAND) {
    g_posB = (float)g_tgtB;
    driveMotor(PIN_B_IN3, PIN_B_IN4, 0);
  } else {
    int dir = (dB > 0) ? 1 : -1;
    float step = (fabs(dB) < maxStep) ? fabs(dB) : maxStep;
    g_posB += dir * step;
    driveMotor(PIN_B_IN3, PIN_B_IN4, dir);
    moving = true;
  }
  return moving;
}

void setTargets(long pA, long pB) {
  g_tgtA = clampPm(pA);
  g_tgtB = clampPm(pB);
}

void goToCenter() {
  sendLOG("centering");
  setTargets(CENTER_PER_MILLE, CENTER_PER_MILLE);
  g_lastMotionMs = millis();
  while (updateMotion()) {
    delay(2);
  }
  stopMotors();
  g_ready = true;
  sendLine("HOMED");
  sendCurrentPos();
}

void jogDelta(long dA, long dB) {
  if (!g_ready) return;
  setTargets(g_tgtA + dA, g_tgtB + dB);
}

bool handleJogChar(char dir) {
  switch (dir) {
    case 'L': case 'l': jogDelta(-JOG_PER_MILLE,  JOG_PER_MILLE); return true;
    case 'R': case 'r': jogDelta( JOG_PER_MILLE, -JOG_PER_MILLE); return true;
    case 'T': case 't': jogDelta(-JOG_PER_MILLE, -JOG_PER_MILLE); return true;
    case 'D': case 'd': jogDelta( JOG_PER_MILLE,  JOG_PER_MILLE); return true;
    default: return false;
  }
}

void pollButtons() {
  if (!g_ready) return;
  unsigned long now = millis();
  if (now - g_lastJogMs < JOG_INTERVAL_MS) return;

  bool left  = digitalRead(PIN_BTN_LEFT)  == LOW;
  bool right = digitalRead(PIN_BTN_RIGHT) == LOW;
  bool tense = digitalRead(PIN_BTN_TENSE) == LOW;
  bool loose = digitalRead(PIN_BTN_LOOSE) == LOW;

  if (left)       { handleJogChar('L'); g_lastJogMs = now; }
  else if (right) { handleJogChar('R'); g_lastJogMs = now; }
  else if (tense) { handleJogChar('T'); g_lastJogMs = now; }
  else if (loose) { handleJogChar('D'); g_lastJogMs = now; }
}

void handleCommand(const String& raw) {
  String l = raw;
  l.trim();
  if (l.length() == 0) return;

  if (l == "H") {
    goToCenter();
    return;
  }
  if (l == "?") {
    sendCurrentPos();
    return;
  }
  if (l == "S") {
    setTargets((long)lround(g_posA), (long)lround(g_posB));
    stopMotors();
    sendLOG("stopped");
    return;
  }
  if (l.startsWith("J ")) {
    if (!g_ready) { sendERR("not ready"); return; }
    String dir = l.substring(2);
    dir.trim();
    if (dir.length() != 1 || !handleJogChar(dir.charAt(0))) {
      sendERR(String("bad jog: ") + l);
      return;
    }
    sendCurrentPos();
    return;
  }
  if (l.startsWith("M ")) {
    if (!g_ready) { sendERR("not ready"); return; }
    String payload = l.substring(2);
    payload.trim();

    int spaceIdx = payload.indexOf(' ');
    if (spaceIdx > 0) {
      String sA = payload.substring(0, spaceIdx);
      String sB = payload.substring(spaceIdx + 1);
      sB.trim();
      char* endpA = nullptr;
      char* endpB = nullptr;
      long pA = strtol(sA.c_str(), &endpA, 10);
      long pB = strtol(sB.c_str(), &endpB, 10);
      if (endpA == sA.c_str() || *endpA != '\0' ||
          endpB == sB.c_str() || *endpB != '\0' ||
          pA < 0 || pA > 1000 || pB < 0 || pB > 1000) {
        sendERR(String("bad pos: ") + payload);
        return;
      }
      setTargets(pA, pB);
      sendCurrentPos();
      return;
    }

    char* endp = nullptr;
    long p = strtol(payload.c_str(), &endp, 10);
    if (endp == payload.c_str() || *endp != '\0' || p < 0 || p > 1000) {
      sendERR(String("bad pos: ") + payload);
      return;
    }
    setTargets(p, 1000 - p);
    sendCurrentPos();
    return;
  }
  sendERR(String("unknown cmd: ") + l);
}

void readSerial() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') {
      handleCommand(g_inbuf);
      g_inbuf = "";
    } else if (c != '\r') {
      g_inbuf += c;
      if (g_inbuf.length() > 64) g_inbuf = "";
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(100);

  pinMode(PIN_BTN_LEFT,  INPUT_PULLUP);
  pinMode(PIN_BTN_RIGHT, INPUT_PULLUP);
  pinMode(PIN_BTN_TENSE, INPUT_PULLUP);
  pinMode(PIN_BTN_LOOSE, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);

  pinMode(PIN_A_IN1, OUTPUT);
  pinMode(PIN_A_IN2, OUTPUT);
  pinMode(PIN_B_IN3, OUTPUT);
  pinMode(PIN_B_IN4, OUTPUT);

  stopMotors();

  sendLOG("boot");
  g_lastMotionMs = millis();
  assumeCenter();
  sendLOG("assumed center");
  sendLine("HOMED");
  sendLine("READY");
}

void loop() {
  readSerial();
  pollButtons();
  bool moving = updateMotion();
  digitalWrite(PIN_LED, moving ? HIGH : LOW);
}
