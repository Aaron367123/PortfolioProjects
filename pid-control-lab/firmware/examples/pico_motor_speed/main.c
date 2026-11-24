/*
 * main.c - Raspberry Pi Pico (RP2040) DC motor speed loop skeleton (UNTESTED ON HARDWARE).
 *
 *   GP15 -> H-bridge PWM (20 kHz)   GP14 -> H-bridge DIR
 *   GP2  <- encoder A (IRQ)         GP3  <- encoder B
 *
 * A repeating_timer fires every 5 ms on core 0 and runs the whole control step inside the
 * callback, so the sample time is set by the hardware alarm, not by the main loop.
 * Build with the Pico C SDK (see CMakeLists.txt); pid.c is compiled from ../../.
 */
#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/pwm.h"
#include "hardware/gpio.h"
#include "pid.h"

#define PIN_PWM 15
#define PIN_DIR 14
#define PIN_ENC_A 2
#define PIN_ENC_B 3

#define TS_US 5000
#define TS_S 0.005f
#define ENCODER_CPR 1400.0f
#define SUPPLY_V 12.0f
#define PWM_WRAP 6249            /* 125 MHz / (6249 + 1) = 20 kHz */

static volatile int32_t g_count = 0;
static pid_ctrl_t g_pid;
static volatile float g_setpoint = 100.0f;   /* rad/s */
static volatile float g_speed, g_u;

static void encoder_irq(uint gpio, uint32_t events)
{
    (void)gpio; (void)events;
    if (gpio_get(PIN_ENC_B)) g_count--; else g_count++;
}

static void drive(float volts)
{
    float duty = volts / SUPPLY_V;
    gpio_put(PIN_DIR, duty >= 0.0f);
    if (duty < 0.0f) duty = -duty;
    pwm_set_gpio_level(PIN_PWM, (uint16_t)(duty * (float)PWM_WRAP));
}

static bool control_step(repeating_timer_t *t)
{
    static int32_t last = 0;
    (void)t;
    const int32_t c = g_count;
    g_speed = 6.2831853f * (float)(c - last) / ENCODER_CPR / TS_S;
    last = c;
    g_u = pid_update(&g_pid, g_setpoint, g_speed);
    drive(g_u);
    return true;                 /* keep repeating */
}

int main(void)
{
    stdio_init_all();

    gpio_set_function(PIN_PWM, GPIO_FUNC_PWM);
    uint slice = pwm_gpio_to_slice_num(PIN_PWM);
    pwm_set_wrap(slice, PWM_WRAP);
    pwm_set_enabled(slice, true);
    gpio_init(PIN_DIR);
    gpio_set_dir(PIN_DIR, GPIO_OUT);

    gpio_init(PIN_ENC_B);
    gpio_set_dir(PIN_ENC_B, GPIO_IN);
    gpio_pull_up(PIN_ENC_B);
    gpio_set_irq_enabled_with_callback(PIN_ENC_A, GPIO_IRQ_EDGE_RISE, true, &encoder_irq);

    pid_config_t cfg;
    pid_default_config(&cfg);
    cfg.kp = 0.12f; cfg.ki = 0.9f; cfg.kd = 0.0f;
    cfg.ts = TS_S;  cfg.tf = 0.01f;
    cfg.out_min = -SUPPLY_V; cfg.out_max = SUPPLY_V;
    cfg.aw = PID_AW_CLAMP;
    pid_init(&g_pid, &cfg);

    repeating_timer_t timer;
    add_repeating_timer_us(-TS_US, control_step, NULL, &timer);  /* negative: period from start to start */

    while (true) {               /* telemetry only - control runs in the timer callback */
        printf("%.1f,%.1f,%.2f\n", (double)g_setpoint, (double)g_speed, (double)g_u);
        sleep_ms(100);
    }
}
