// ============================================================
// Floating Farm — ESP32 firmware
//
// Hardware (see HARDWARE.md):
//   ESP32 DevKit V1
//   DRV8825 stepper driver
//   NEMA17 stepper (1.8°/step → 200 steps/rev, microstep configurable)
//   1x mechanical endstop (NC) at the NEGATIVE end of travel
//   External 12V supply for the driver (logic 3V3 from ESP32)
//
// Serial protocol (115200 baud, LF terminated):
//   Sim → ESP32:    H | M <0..1000> | ? | S
//   ESP32 → Sim:    READY | HOMED | POS <n> | ERR <msg> | LOG <msg>
//
// Build: PlatformIO (firmware/esp32/platformio.ini) — `pio run`.
// ============================================================

#include <Arduino.h>
#include <AccelStepper.h>

// ----- Pin assignments (change to match your wiring) ---------
constexpr int PIN_STEP    = 25;
constexpr int PIN_DIR     = 26;
constexpr int PIN_ENABLE  = 27;   // DRV8825 ENABLE (active LOW = enabled)
constexpr int PIN_ENDSTOP = 32;   // NC endstop to GND when triggered
constexpr int PIN_LED     = 2;    // onboard LED

// ----- Motion config — tune for your mechanical setup --------
constexpr long  STEPS_PER_MM     = 80;     // GT2 20T pulley microstepped 1/16
constexpr long  TRAVEL_MM        = 200;    // physical rail length
constexpr long  TRAVEL_STEPS     = STEPS_PER_MM * TRAVEL_MM;
constexpr float MAX_SPEED        = 2000.0; // steps/s
constexpr float ACCEL            = 1500.0; // steps/s^2
constexpr float HOMING_SPEED     = 400.0;  // steps/s
constexpr long  HOMING_BACKOFF   = 200;    // steps to back off after touch

// ----- Globals -----------------------------------------------
AccelStepper stepper(AccelStepper::DRIVER, PIN_STEP, PIN_DIR);
bool   g_homed   = false;
String g_inbuf;

// ----- Helpers -----------------------------------------------
void sendLine(const String& s) {
    Serial.print(s);
    Serial.print('\n');
}

void sendLOG(const String& s) { sendLine(String("LOG ") + s); }
void sendERR(const String& s) { sendLine(String("ERR ") + s); }

long perMilleToSteps(long p) {
    if (p < 0) p = 0;
    if (p > 1000) p = 1000;
    return (TRAVEL_STEPS * p) / 1000;
}

long stepsToPerMille(long s) {
    if (TRAVEL_STEPS <= 0) return 0;
    long p = (s * 1000L) / TRAVEL_STEPS;
    if (p < 0) p = 0;
    if (p > 1000) p = 1000;
    return p;
}

bool endstopHit() {
    // NC switch: LOW = pressed
    return digitalRead(PIN_ENDSTOP) == LOW;
}

void enableDriver(bool on) {
    digitalWrite(PIN_ENABLE, on ? LOW : HIGH);
}

void homing() {
    sendLOG("homing");
    g_homed = false;
    enableDriver(true);
    stepper.setMaxSpeed(HOMING_SPEED);
    stepper.setAcceleration(ACCEL);

    // Run toward the negative end until endstop trips
    stepper.setSpeed(-HOMING_SPEED);
    const unsigned long deadline = millis() + 30000UL;
    while (!endstopHit()) {
        stepper.runSpeed();
        if (millis() > deadline) {
            sendERR("homing timeout");
            return;
        }
    }
    stepper.setCurrentPosition(0);

    // Back off a few steps so the switch is no longer pressed
    stepper.moveTo(HOMING_BACKOFF);
    while (stepper.distanceToGo() != 0) stepper.run();
    stepper.setCurrentPosition(0);

    stepper.setMaxSpeed(MAX_SPEED);
    g_homed = true;
    sendLine("HOMED");
}

void handleCommand(const String& raw) {
    String l = raw;
    l.trim();
    if (l.length() == 0) return;

    if (l == "H") {
        homing();
        return;
    }
    if (l == "?") {
        sendLine(String("POS ") + stepsToPerMille(stepper.currentPosition()));
        return;
    }
    if (l == "S") {
        stepper.stop();
        enableDriver(false);
        sendLOG("stopped");
        return;
    }
    if (l.startsWith("M ")) {
        if (!g_homed) { sendERR("not homed"); return; }
        String payload = l.substring(2);
        payload.trim();
        char* endp = nullptr;
        long  p    = strtol(payload.c_str(), &endp, 10);
        if (endp == payload.c_str() || *endp != '\0' || p < 0 || p > 1000) {
            sendERR(String("bad pos: ") + payload);
            return;
        }
        enableDriver(true);
        stepper.moveTo(perMilleToSteps(p));
        sendLine(String("POS ") + p);
        return;
    }
    sendERR(String("unknown cmd: ") + l);
}

void readSerial() {
    while (Serial.available()) {
        char c = (char) Serial.read();
        if (c == '\n') {
            handleCommand(g_inbuf);
            g_inbuf = "";
        } else if (c != '\r') {
            g_inbuf += c;
            if (g_inbuf.length() > 64) g_inbuf = ""; // overflow guard
        }
    }
}

// ----- Arduino entry points ----------------------------------
void setup() {
    Serial.begin(115200);
    delay(100);
    pinMode(PIN_ENABLE,  OUTPUT);
    pinMode(PIN_ENDSTOP, INPUT_PULLUP);
    pinMode(PIN_LED,     OUTPUT);
    enableDriver(false);

    stepper.setMaxSpeed(MAX_SPEED);
    stepper.setAcceleration(ACCEL);

    sendLOG("boot");
    homing();
    sendLine("READY");
}

void loop() {
    readSerial();
    if (stepper.distanceToGo() != 0) {
        digitalWrite(PIN_LED, HIGH);
        stepper.run();
    } else {
        digitalWrite(PIN_LED, LOW);
    }
}
