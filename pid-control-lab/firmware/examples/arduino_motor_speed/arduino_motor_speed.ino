/*
 * arduino_motor_speed.ino - DC motor speed control with pid.c (UNTESTED ON HARDWARE).
 *
 * Hardware (Arduino Uno / Nano, ATmega328P @ 16 MHz):
 *   - H-bridge (e.g. L298N / TB6612): PWM -> D5 (Timer0; Timer1 is the sample clock), DIR -> D7
 *   - Quadrature encoder: channel A -> D2 (INT0), channel B -> D4
 *   - 12 V motor supply, encoder CPR below
 *
 * Copy ../../pid.h and ../../pid.c into this sketch folder before compiling (the Arduino
 * IDE only compiles files that live next to the .ino). pid.h has extern "C" guards.
 *
 * Timing: Timer1 in CTC mode raises a flag every 5 ms (200 Hz). The control step runs in
 * loop() when the flag is set, so the PID always sees a fixed Ts even though loop() does
 * other work. Speed is estimated from encoder counts per sample.
 */
#include "pid.h"

static const uint8_t PIN_PWM = 5;          // analogWrite (Timer0, ~980 Hz)
static const uint8_t PIN_DIR = 7;
static const uint8_t PIN_ENC_A = 2;
static const uint8_t PIN_ENC_B = 4;

static const float TS = 0.005f;            // 5 ms sample time - must match Timer1 below
static const float ENCODER_CPR = 1400.0f;  // counts per output-shaft revolution (x1 decoding)
static const float SUPPLY_V = 12.0f;

static volatile long g_count = 0;          // encoder position, updated in the ISR
static volatile bool g_tick = false;       // set by Timer1 every TS

static pid_ctrl_t g_pid;
static float g_setpoint = 100.0f;          // rad/s

void encoderISR() {
  // x1 decoding: on each rising edge of A, B tells the direction.
  if (digitalRead(PIN_ENC_B)) g_count--; else g_count++;
}

ISR(TIMER1_COMPA_vect) { g_tick = true; }

static void setupTimer1(void) {
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = _BV(WGM12) | _BV(CS11) | _BV(CS10);   // CTC, prescaler 64 -> 250 kHz
  OCR1A = 1249;                                   // 250 kHz / 1250 = 200 Hz
  TIMSK1 = _BV(OCIE1A);
  interrupts();
}

static void driveMotor(float volts) {
  const float duty = volts / SUPPLY_V;            // -1..1 (PID output is already clamped)
  digitalWrite(PIN_DIR, duty >= 0.0f ? HIGH : LOW);
  analogWrite(PIN_PWM, (int)(fabs(duty) * 255.0f + 0.5f));
}

void setup() {
  pinMode(PIN_PWM, OUTPUT);
  pinMode(PIN_DIR, OUTPUT);
  pinMode(PIN_ENC_A, INPUT_PULLUP);
  pinMode(PIN_ENC_B, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_A), encoderISR, RISING);
  Serial.begin(115200);

  pid_config_t cfg;
  pid_default_config(&cfg);
  cfg.kp = 0.12f;                  // lab defaults for the "motor-speed" plant;
  cfg.ki = 0.9f;                   // re-tune with the relay autotune for a real motor
  cfg.kd = 0.0f;
  cfg.ts = TS;
  cfg.tf = 0.01f;
  cfg.out_min = -SUPPLY_V;
  cfg.out_max = SUPPLY_V;
  cfg.aw = PID_AW_CLAMP;
  pid_init(&g_pid, &cfg);

  setupTimer1();
}

void loop() {
  static long lastCount = 0;
  static uint16_t printDiv = 0;
  if (!g_tick) return;
  g_tick = false;

  noInterrupts();
  const long count = g_count;
  interrupts();

  // Speed from counts per sample: w = 2*pi * dCounts / CPR / Ts
  const float w = 6.2831853f * (float)(count - lastCount) / ENCODER_CPR / TS;
  lastCount = count;

  const float u = pid_update(&g_pid, g_setpoint, w);
  driveMotor(u);

  if (++printDiv >= 20) {          // 10 Hz telemetry: sp, speed, volts
    printDiv = 0;
    Serial.print(g_setpoint); Serial.print(',');
    Serial.print(w); Serial.print(',');
    Serial.println(u);
  }
}
