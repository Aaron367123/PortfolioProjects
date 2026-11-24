/*
 * log.h - serialized access log and server messages.
 */
#ifndef TINYHTTPD_LOG_H
#define TINYHTTPD_LOG_H

#include "http.h"

/* quiet != 0 silences the per-request access log (server messages stay). */
void log_init(int quiet);

/*
 * One Common-Log-Format-style line per request, e.g.
 *   127.0.0.1 - - [23/Nov/2026:20:15:03 +0000] "GET / HTTP/1.1" 200 1043 0.21ms
 * `req` may be NULL or only partially parsed (malformed requests).
 */
void log_access(const char *peer, const http_request_t *req, int status,
                unsigned long long body_bytes, double millis);

/* printf-style server message (startup, shutdown, errors) to stdout. */
void log_msg(const char *fmt, ...)
#if defined(__GNUC__)
    __attribute__((format(printf, 1, 2)))
#endif
    ;

#endif /* TINYHTTPD_LOG_H */
