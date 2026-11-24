/**
 * @file pid.c
 * @brief Fixed-sample-time PID controller - implementation. See pid.h for the equations.
 *
 * Kept deliberately in the same order as src/pid.js so the two can be read side by side
 * and the golden test can compare them sample by sample.
 */
#include "pid.h"

static pid_real_t clampr(pid_real_t x, pid_real_t lo, pid_real_t hi)
{
    return (x < lo) ? lo : ((x > hi) ? hi : x);
}

/* Back-calculation tracking time: Tt = max(Ts, Ti/2) with Ti = Kp/Ki (no sqrt needed). */
static pid_real_t tracking_time(const pid_config_t *c)
{
    pid_real_t tt;
    if (c->tt > (pid_real_t)0) {
        return c->tt;
    }
    if (!(c->ki > (pid_real_t)0) || !(c->kp > (pid_real_t)0)) {
        return c->ts;
    }
    tt = (pid_real_t)0.5 * c->kp / c->ki;
    return (tt > c->ts) ? tt : c->ts;
}

void pid_default_config(pid_config_t *cfg)
{
    cfg->kp = (pid_real_t)1;
    cfg->ki = (pid_real_t)0;
    cfg->kd = (pid_real_t)0;
    cfg->ts = (pid_real_t)0.01;
    cfg->tf = (pid_real_t)0;
    cfg->b = (pid_real_t)1;
    cfg->c = (pid_real_t)0;
    cfg->out_min = (pid_real_t)-1;
    cfg->out_max = (pid_real_t)1;
    cfg->aw = PID_AW_CLAMP;
    cfg->tt = (pid_real_t)0;
}

int pid_init(pid_ctrl_t *pid, const pid_config_t *cfg)
{
    if (!(cfg->ts > (pid_real_t)0) || cfg->tf < (pid_real_t)0 || cfg->out_min > cfg->out_max) {
        return -1;
    }
    pid->cfg = *cfg;
    pid_reset(pid);
    return 0;
}

void pid_reset(pid_ctrl_t *pid)
{
    pid->integ = (pid_real_t)0;
    pid->deriv = (pid_real_t)0;
    pid->ed_prev = (pid_real_t)0;
    pid->started = 0;
    pid->p = pid->i = pid->d = pid->v = (pid_real_t)0;
    pid->u = clampr((pid_real_t)0, pid->cfg.out_min, pid->cfg.out_max);
    pid->sat = 0;
}

pid_real_t pid_update(pid_ctrl_t *pid, pid_real_t sp, pid_real_t y)
{
    const pid_config_t *c = &pid->cfg;
    const pid_real_t e = sp - y;
    const pid_real_t ed = c->c * sp - y;
    pid_real_t p, d, v, u, d_integ;
    int sat;

    if (!pid->started) {          /* first sample: no derivative spike */
        pid->ed_prev = ed;
        pid->started = 1;
    }

    /* Proportional with setpoint weighting */
    p = c->kp * (c->b * sp - y);

    /* Filtered derivative (backward Euler): D[k] = Tf/(Tf+Ts)*D[k-1] + Kd/(Tf+Ts)*(ed[k]-ed[k-1]) */
    d = (c->tf / (c->tf + c->ts)) * pid->deriv + (c->kd / (c->tf + c->ts)) * (ed - pid->ed_prev);

    /* Output and saturation */
    v = p + pid->integ + d;
    u = clampr(v, c->out_min, c->out_max);
    sat = (v > c->out_max) ? 1 : ((v < c->out_min) ? -1 : 0);

    /* Integrator update for the next sample, with anti-windup */
    d_integ = c->ki * c->ts * e;
    if (c->aw == PID_AW_CLAMP) {
        /* Conditional integration: hold I while saturated and e drives deeper into the limit */
        if ((sat > 0 && e > (pid_real_t)0) || (sat < 0 && e < (pid_real_t)0)) {
            d_integ = (pid_real_t)0;
        }
    } else if (c->aw == PID_AW_BACKCALC) {
        /* Back-calculation: feed the saturation excess (u - v) back with gain 1/Tt */
        d_integ += (c->ts / tracking_time(c)) * (u - v);
    }

    /* Log the terms that made up this output, then advance the state */
    pid->p = p;
    pid->i = pid->integ;
    pid->d = d;
    pid->v = v;
    pid->u = u;
    pid->sat = sat;

    pid->integ += d_integ;
    pid->deriv = d;
    pid->ed_prev = ed;
    return u;
}

void pid_set_gains(pid_ctrl_t *pid, pid_real_t kp, pid_real_t ki, pid_real_t kd,
                   pid_real_t sp, pid_real_t y)
{
    pid_config_t *c = &pid->cfg;
    if (pid->started) {
        const pid_real_t p_old = c->kp * (c->b * sp - y);
        const pid_real_t p_new = kp * (c->b * sp - y);
        const pid_real_t d_old = pid->deriv;
        const pid_real_t d_new = (c->kd != (pid_real_t)0) ? pid->deriv * (kd / c->kd) : (pid_real_t)0;
        pid->integ += (p_old - p_new) + (d_old - d_new);
        pid->deriv = d_new;
    }
    c->kp = kp;
    c->ki = ki;
    c->kd = kd;
}

int pid_set_limits(pid_ctrl_t *pid, pid_real_t out_min, pid_real_t out_max)
{
    if (out_min > out_max) {
        return -1;
    }
    pid->cfg.out_min = out_min;
    pid->cfg.out_max = out_max;
    return 0;
}
