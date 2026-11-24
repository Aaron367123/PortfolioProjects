/*
 * log.c - access log.
 *
 * Several workers finish requests at the same time; without a lock their
 * fprintf calls could interleave inside a line. One mutex around "format +
 * write + flush" keeps every line intact. The flush makes lines appear
 * immediately even when stdout is a pipe (as in the integration tests).
 */
#include "log.h"
#include "platform.h"

#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <time.h>

static pthread_mutex_t g_log_mu = PTHREAD_MUTEX_INITIALIZER;
static int g_quiet;

void log_init(int quiet) { g_quiet = quiet; }

void log_access(const char *peer, const http_request_t *req, int status,
                unsigned long long body_bytes, double millis)
{
    static const char *const months[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    struct tm tm;
    char when[40];

    if (g_quiet)
        return;
    if (plat_gmtime(time(NULL), &tm) == 0 && tm.tm_mon >= 0 && tm.tm_mon < 12)
        snprintf(when, sizeof when, "%02d/%s/%04d:%02d:%02d:%02d +0000", tm.tm_mday,
                 months[tm.tm_mon], tm.tm_year + 1900, tm.tm_hour, tm.tm_min, tm.tm_sec);
    else
        snprintf(when, sizeof when, "-");

    pthread_mutex_lock(&g_log_mu);
    if (req != NULL && req->method_str != NULL && req->target != NULL)
        /* The parser only accepts visible ASCII in the target, so it cannot
         * inject newlines into the log; long targets are truncated. */
        printf("%s - - [%s] \"%s %.200s HTTP/1.%d\" %d %llu %.2fms\n", peer, when,
               req->method_str, req->target, req->version_minor, status, body_bytes, millis);
    else
        printf("%s - - [%s] \"-\" %d %llu %.2fms\n", peer, when, status, body_bytes, millis);
    fflush(stdout);
    pthread_mutex_unlock(&g_log_mu);
}

void log_msg(const char *fmt, ...)
{
    va_list ap;
    pthread_mutex_lock(&g_log_mu);
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
    pthread_mutex_unlock(&g_log_mu);
}
