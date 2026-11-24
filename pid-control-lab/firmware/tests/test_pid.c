/**
 * @file test_pid.c
 * @brief Unit tests for pid.c plus the JS <-> C golden-trajectory parity test.
 *
 * Usage: test_pid [golden.csv ...]
 * Each golden file was produced by scripts/gen-golden.mjs from the JS reference
 * implementation; every u, P, I, D sample must match within GOLDEN_TOL.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../pid.h"

#define GOLDEN_TOL 1e-4

/* ---- tiny assert harness ---------------------------------------------------------- */
static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond) do {                                                          \
        g_checks++;                                                               \
        if (!(cond)) {                                                            \
            g_failures++;                                                         \
            printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);              \
        }                                                                         \
    } while (0)

#define CHECK_NEAR(a, b, tol) do {                                                \
        double a_ = (double)(a), b_ = (double)(b);                                \
        double d_ = a_ - b_;                                                      \
        g_checks++;                                                               \
        if (d_ < 0) d_ = -d_;                                                     \
        if (!(d_ <= (tol))) {                                                     \
            g_failures++;                                                         \
            printf("  FAIL %s:%d: %s = %.9g, expected %.9g (tol %g)\n",           \
                   __FILE__, __LINE__, #a, a_, b_, (double)(tol));                \
        }                                                                         \
    } while (0)

static void run(const char *name, void (*fn)(void))
{
    int before = g_failures;
    fn();
    printf("%s %s\n", g_failures == before ? "ok  " : "FAIL", name);
}

static pid_config_t base_config(void)
{
    pid_config_t c;
    pid_default_config(&c);
    c.out_min = -1000.0f;
    c.out_max = 1000.0f;
    return c;
}

/* ---- unit tests ------------------------------------------------------------------- */

static void test_init_validation(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    CHECK(pid_init(&pid, &c) == 0);
    c.ts = 0.0f;
    CHECK(pid_init(&pid, &c) == -1);
    c = base_config();
    c.out_min = 2.0f;
    c.out_max = 1.0f;
    CHECK(pid_init(&pid, &c) == -1);
    c = base_config();
    c.tf = -1.0f;
    CHECK(pid_init(&pid, &c) == -1);
}

/* P only: u = Kp*(b*r - y) */
static void test_proportional(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    c.kp = 2.0f;
    pid_init(&pid, &c);
    CHECK_NEAR(pid_update(&pid, 1.0f, 0.25f), 1.5, 1e-6);
    pid.cfg.b = 0.5f;                                  /* setpoint weighting */
    CHECK_NEAR(pid_update(&pid, 1.0f, 0.25f), 0.5, 1e-6);
}

/* PI hand calculation, Kp = 1, Ki = 10, Ts = 0.1, constant e = 1:
 *   k=0: P = 1, I = 0      -> u = 1, then I = 0 + 10*0.1*1 = 1
 *   k=1: u = 1 + 1 = 2,    I = 2
 *   k=2: u = 3 */
static void test_integral_steps(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    c.kp = 1.0f;
    c.ki = 10.0f;
    c.ts = 0.1f;
    pid_init(&pid, &c);
    CHECK_NEAR(pid_update(&pid, 1.0f, 0.0f), 1.0, 1e-6);
    CHECK_NEAR(pid_update(&pid, 1.0f, 0.0f), 2.0, 1e-6);
    CHECK_NEAR(pid_update(&pid, 1.0f, 0.0f), 3.0, 1e-6);
    CHECK_NEAR(pid.i, 2.0, 1e-6);
}

/* Derivative on measurement: a setpoint step with constant y gives D = 0 (no kick).
 * With c = 1 (derivative on error) the same step gives D = Kd/(Tf+Ts)*dr. */
static void test_no_derivative_kick(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    c.kp = 0.0f;
    c.kd = 0.5f;
    c.tf = 0.05f;
    c.ts = 0.01f;
    pid_init(&pid, &c);
    pid_update(&pid, 0.0f, 0.0f);
    CHECK_NEAR(pid_update(&pid, 1.0f, 0.0f), 0.0, 1e-9);

    c.c = 1.0f;
    pid_init(&pid, &c);
    pid_update(&pid, 0.0f, 0.0f);
    CHECK_NEAR(pid_update(&pid, 1.0f, 0.0f), 0.5 / (0.05 + 0.01), 1e-4);
}

/* Measurement ramp y = s*t: filtered D converges to -Kd*s; first output = -Kd/(Tf+Ts)*s*Ts. */
static void test_derivative_filter(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    int k;
    pid_real_t u = 0.0f;
    c.kp = 0.0f;
    c.kd = 2.0f;
    c.tf = 0.02f;
    c.ts = 0.01f;
    pid_init(&pid, &c);
    pid_update(&pid, 0.0f, 0.0f);
    u = pid_update(&pid, 0.0f, 0.03f);                  /* s = 3 /s */
    CHECK_NEAR(u, -2.0 / 0.03 * 0.03, 1e-5);
    for (k = 2; k < 200; k++) {
        u = pid_update(&pid, 0.0f, (pid_real_t)0.03 * (pid_real_t)k);
    }
    CHECK_NEAR(u, -6.0, 1e-3);
}

/* Clamping: while saturated with e pushing outward the integrator must not move. */
static void test_clamp_antiwindup(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    int k;
    c.kp = 1.0f;
    c.ki = 5.0f;
    c.out_min = -1.0f;
    c.out_max = 1.0f;
    pid_init(&pid, &c);
    for (k = 0; k < 100; k++) {
        CHECK_NEAR(pid_update(&pid, 10.0f, 0.0f), 1.0, 0);
    }
    CHECK_NEAR(pid.integ, 0.0, 0);
    CHECK(pid.sat == 1);

    /* Same thing without anti-windup winds up: I = 100 * Ki*Ts*e = 50 */
    c.aw = PID_AW_NONE;
    pid_init(&pid, &c);
    for (k = 0; k < 100; k++) {
        pid_update(&pid, 10.0f, 0.0f);
    }
    CHECK_NEAR(pid.integ, 50.0, 1e-3);
}

/* Back-calculation: I settles where Ki*e = (u - v)/Tt, i.e. bounded instead of growing. */
static void test_backcalc_antiwindup(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    int k;
    pid_real_t prev = 0.0f;
    c.kp = 1.0f;
    c.ki = 5.0f;
    c.out_min = -1.0f;
    c.out_max = 1.0f;
    c.aw = PID_AW_BACKCALC;
    c.tt = 0.1f;
    pid_init(&pid, &c);
    for (k = 0; k < 400; k++) {
        pid_update(&pid, 10.0f, 0.0f);
        if (k == 398) {
            prev = pid.integ;
        }
    }
    /* Fixed point: Ki*e + (u - P - I)/Tt = 0 -> I = u - P + Ki*e*Tt = 1 - 10 + 5 = -4 */
    CHECK_NEAR(pid.integ, -4.0, 1e-3);
    CHECK_NEAR(pid.integ, prev, 1e-4);
}

/* Bumpless transfer: right after pid_set_gains the output for the same (r, y) is unchanged. */
static void test_bumpless_gain_change(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    pid_real_t v_before, v_after;
    c.kp = 2.0f;
    c.ki = 1.0f;
    c.kd = 0.3f;
    c.tf = 0.05f;
    pid_init(&pid, &c);
    pid_update(&pid, 1.0f, 0.2f);
    pid_update(&pid, 1.0f, 0.3f);
    v_before = pid.cfg.kp * (pid.cfg.b * (pid_real_t)1 - (pid_real_t)0.3) + pid.integ + pid.deriv;
    pid_set_gains(&pid, 5.0f, 2.0f, 0.1f, 1.0f, 0.3f);
    v_after = pid.cfg.kp * (pid.cfg.b * (pid_real_t)1 - (pid_real_t)0.3) + pid.integ + pid.deriv;
    CHECK_NEAR(v_after, v_before, 1e-5);
    CHECK_NEAR(pid.cfg.kp, 5.0, 0);
}

static void test_reset(void)
{
    pid_ctrl_t pid;
    pid_config_t c = base_config();
    c.kp = 1.0f;
    c.ki = 1.0f;
    c.kd = 1.0f;
    pid_init(&pid, &c);
    pid_update(&pid, 1.0f, 0.0f);
    pid_update(&pid, 1.0f, 0.5f);
    pid_reset(&pid);
    CHECK_NEAR(pid.integ, 0.0, 0);
    CHECK_NEAR(pid.deriv, 0.0, 0);
    CHECK(pid.started == 0);
    /* After reset the first sample has no derivative term */
    pid_update(&pid, 1.0f, 0.7f);
    CHECK_NEAR(pid.d, 0.0, 0);
}

/* ---- golden parity test ----------------------------------------------------------- */

static int golden_file(const char *path)
{
    FILE *fp = fopen(path, "r");
    char line[512];
    double kp, ki, kd, ts, tf, b, c, umin, umax, tt;
    int aw, rows = 0, before = g_failures;
    double max_err = 0.0;
    pid_config_t cfg;
    pid_ctrl_t pid;
    double prev_sp = 0.0, prev_y = 0.0;

    if (!fp) {
        printf("FAIL cannot open %s\n", path);
        g_failures++;
        return -1;
    }
    /* comment, config header, config values, data header */
    if (!fgets(line, sizeof line, fp) || !fgets(line, sizeof line, fp) || !fgets(line, sizeof line, fp) ||
        sscanf(line, "%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%lf,%d,%lf",
               &kp, &ki, &kd, &ts, &tf, &b, &c, &umin, &umax, &aw, &tt) != 11 ||
        !fgets(line, sizeof line, fp)) {
        printf("FAIL bad header in %s\n", path);
        g_failures++;
        fclose(fp);
        return -1;
    }
    pid_default_config(&cfg);
    cfg.kp = (pid_real_t)kp; cfg.ki = (pid_real_t)ki; cfg.kd = (pid_real_t)kd;
    cfg.ts = (pid_real_t)ts; cfg.tf = (pid_real_t)tf;
    cfg.b = (pid_real_t)b;   cfg.c = (pid_real_t)c;
    cfg.out_min = (pid_real_t)umin; cfg.out_max = (pid_real_t)umax;
    cfg.aw = (pid_aw_mode_t)aw; cfg.tt = (pid_real_t)tt;
    CHECK(pid_init(&pid, &cfg) == 0);

    while (fgets(line, sizeof line, fp)) {
        int k, reset;
        double sp, y, gkp, gki, gkd, u, p, i, d;
        double errs[4];
        int j;
        if (sscanf(line, "%d,%lf,%lf,%lf,%lf,%lf,%d,%lf,%lf,%lf,%lf",
                   &k, &sp, &y, &gkp, &gki, &gkd, &reset, &u, &p, &i, &d) != 11) {
            continue;
        }
        if ((pid_real_t)gkp != pid.cfg.kp || (pid_real_t)gki != pid.cfg.ki || (pid_real_t)gkd != pid.cfg.kd) {
            pid_set_gains(&pid, (pid_real_t)gkp, (pid_real_t)gki, (pid_real_t)gkd,
                          (pid_real_t)prev_sp, (pid_real_t)prev_y);
        }
        if (reset) {
            pid_reset(&pid);
        }
        pid_update(&pid, (pid_real_t)sp, (pid_real_t)y);
        errs[0] = (double)pid.u - u;
        errs[1] = (double)pid.p - p;
        errs[2] = (double)pid.i - i;
        errs[3] = (double)pid.d - d;
        for (j = 0; j < 4; j++) {
            double e = errs[j] < 0 ? -errs[j] : errs[j];
            if (e > max_err) {
                max_err = e;
            }
        }
        CHECK_NEAR(pid.u, u, GOLDEN_TOL);
        CHECK_NEAR(pid.i, i, GOLDEN_TOL);
        CHECK_NEAR(pid.d, d, GOLDEN_TOL);
        prev_sp = sp;
        prev_y = y;
        rows++;
    }
    fclose(fp);
    printf("%s golden %s: %d samples, max |C - JS| = %.3g (tol %g)\n",
           g_failures == before ? "ok  " : "FAIL", path, rows, max_err, GOLDEN_TOL);
    return 0;
}

int main(int argc, char **argv)
{
    int a;
    run("init validation", test_init_validation);
    run("proportional + setpoint weight", test_proportional);
    run("integral hand-computed steps", test_integral_steps);
    run("no derivative kick on setpoint step", test_no_derivative_kick);
    run("derivative low-pass filter", test_derivative_filter);
    run("clamping anti-windup", test_clamp_antiwindup);
    run("back-calculation anti-windup", test_backcalc_antiwindup);
    run("bumpless gain change", test_bumpless_gain_change);
    run("reset", test_reset);
    for (a = 1; a < argc; a++) {
        golden_file(argv[a]);
    }
    printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
