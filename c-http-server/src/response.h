/*
 * response.h - building and sending HTTP response heads and small bodies.
 */
#ifndef TINYHTTPD_RESPONSE_H
#define TINYHTTPD_RESPONSE_H

#include "net.h"

#include <stddef.h>
#include <time.h>

#define SERVER_NAME "tinyhttpd/1.0"

typedef struct {
    int                status;
    const char        *content_type;   /* NULL = no Content-Type header */
    unsigned long long content_length; /* ignored when no_length is set */
    int                no_length;      /* omit Content-Length (304) */
    time_t             last_modified;  /* 0 = no Last-Modified header */
    int                keep_alive;     /* Connection: keep-alive vs close */
    const char        *extra;          /* extra header lines ending in CRLF, or NULL */
} resp_head_t;

/* Format the status line + headers + blank line. Returns length or -1 if it
 * did not fit in `cap` bytes. */
int resp_format_head(char *out, size_t cap, const resp_head_t *h);

/*
 * Send a complete response with an in-memory body in a single send() call
 * (head and body share one buffer, so Nagle/delayed-ACK cannot split them).
 * head_only suppresses the body (HEAD requests) but keeps Content-Length.
 * *body_sent receives the number of body bytes written.
 * Returns 0 on success, -1 if the connection failed.
 */
int resp_send_simple(sock_t fd, const resp_head_t *h, const char *body, size_t body_len,
                     int head_only, unsigned long long *body_sent);

/* Send a short text/plain error page such as "404 Not Found\n". */
int resp_send_error(sock_t fd, int status, int keep_alive, int head_only, const char *extra,
                    unsigned long long *body_sent);

#endif /* TINYHTTPD_RESPONSE_H */
