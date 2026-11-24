/**
 * @file pid.h
 * @brief Fixed-sample-time PID controller for microcontrollers (C99, no malloc, no libm).
 *
 * Mirrors src/pid.js (the browser lab's reference implementation); a golden-trajectory
 * test (tests/test_pid.c) checks both produce the same output within 1e-4.
 *
 * Control law, evaluated once every Ts seconds (r = setpoint, y = measurement):
 * @code
 *   e     = r - y
 *   P     = Kp * (b*r - y)                         setpoint weight b
 *   D[k]  = a*D[k-1] + kd'*(ed[k] - ed[k-1])       ed = c*r - y, c = 0: derivative on measurement
 *           a = Tf/(Tf+Ts), kd' = Kd/(Tf+Ts)       backward Euler of Kd*s/(Tf*s + 1)
 *   v     = P + I + D,  u = clamp(v, out_min, out_max)
 *   I    += Ki*Ts*e                                 (+ anti-windup, see pid_aw_mode_t)
 * @endcode
 *
 * Typical use (timer ISR or a fixed-rate task):
 * @code
 *   static pid_ctrl_t pid;
 *   pid_config_t cfg;
 *   pid_default_config(&cfg);
 *   cfg.kp = 0.12f; cfg.ki = 0.9f; cfg.ts = 0.005f; cfg.out_min = -12.0f; cfg.out_max = 12.0f;
 *   pid_init(&pid, &cfg);
 *   ...
 *   float volts = pid_update(&pid, setpoint, measured_speed);   // every 5 ms
 * @endcode
 */
#ifndef PID_H
#define PID_H

#ifdef __cplusplus
extern "C" {
#endif

/** Scalar type. float by default (single-precision FPU on Cortex-M4F/M33); define
 *  PID_USE_DOUBLE to build the controller in double precision. */
#ifdef PID_USE_DOUBLE
typedef double pid_real_t;
#else
typedef float pid_real_t;
#endif

/** Anti-windup strategy used while the output is saturated. */
typedef enum {
    PID_AW_NONE = 0,     /**< plain integration - the integrator winds up (for comparison only) */
    PID_AW_CLAMP = 1,    /**< conditional integration: freeze I while saturated and e pushes further */
    PID_AW_BACKCALC = 2  /**< back-calculation: I += (Ts/Tt)*(u - v), bleeds I off while saturated */
} pid_aw_mode_t;

/** Controller configuration (all times in seconds). */
typedef struct {
    pid_real_t kp;       /**< proportional gain */
    pid_real_t ki;       /**< integral gain [1/s]   (Ki = Kp/Ti) */
    pid_real_t kd;       /**< derivative gain [s]   (Kd = Kp*Td) */
    pid_real_t ts;       /**< sample time, must be > 0 */
    pid_real_t tf;       /**< derivative filter time constant (0 = unfiltered), Tf = 1/N */
    pid_real_t b;        /**< proportional setpoint weight, usually 0..1 */
    pid_real_t c;        /**< derivative setpoint weight: 0 = derivative on measurement (no kick) */
    pid_real_t out_min;  /**< output lower limit */
    pid_real_t out_max;  /**< output upper limit */
    pid_aw_mode_t aw;    /**< anti-windup mode */
    pid_real_t tt;       /**< back-calculation tracking time; <= 0 selects max(Ts, Ti/2) */
} pid_config_t;

/** Controller instance. Treat the fields as read-only outside pid.c. */
typedef struct {
    pid_config_t cfg;    /**< active configuration */
    pid_real_t integ;    /**< integral term I (output units, already includes Ki) */
    pid_real_t deriv;    /**< filtered derivative term D (output units) */
    pid_real_t ed_prev;  /**< previous c*r - y */
    int started;         /**< 0 until the first update after init/reset */
    /* Last sample, for logging/telemetry: */
    pid_real_t p, i, d;  /**< terms that made up v */
    pid_real_t v;        /**< unsaturated output */
    pid_real_t u;        /**< saturated output */
    int sat;             /**< +1 above out_max, -1 below out_min, 0 otherwise */
} pid_ctrl_t;

/** Fill @p cfg with safe defaults: P-only Kp = 1, Ts = 10 ms, no filter, b = 1,
 *  c = 0 (derivative on measurement), limits +/-1, clamping anti-windup. */
void pid_default_config(pid_config_t *cfg);

/** Initialise @p pid with a copy of @p cfg and reset its state.
 *  @return 0 on success, -1 if the configuration is invalid (ts <= 0, tf < 0, out_min > out_max). */
int pid_init(pid_ctrl_t *pid, const pid_config_t *cfg);

/** Clear integrator, derivative filter and history (e.g. when re-enabling the loop). */
void pid_reset(pid_ctrl_t *pid);

/** Run one sample. Call exactly every cfg.ts seconds.
 *  @param sp setpoint r[k]
 *  @param y  measurement y[k]
 *  @return saturated output u[k] */
pid_real_t pid_update(pid_ctrl_t *pid, pid_real_t sp, pid_real_t y);

/** Change gains bumplessly: the integrator absorbs the jump the new Kp/Kd would cause,
 *  evaluated at the latest setpoint/measurement (@p sp, @p y). */
void pid_set_gains(pid_ctrl_t *pid, pid_real_t kp, pid_real_t ki, pid_real_t kd,
                   pid_real_t sp, pid_real_t y);

/** Change the output limits (state is kept). @return 0, or -1 if min > max. */
int pid_set_limits(pid_ctrl_t *pid, pid_real_t out_min, pid_real_t out_max);

#ifdef __cplusplus
}
#endif

#endif /* PID_H */
