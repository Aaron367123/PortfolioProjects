/*
 * server.h - shared server state passed to every worker.
 */
#ifndef TINYHTTPD_SERVER_H
#define TINYHTTPD_SERVER_H

#include "queue.h"
#include "stats.h"

#include <stdatomic.h>

typedef struct {
    const char *bind_addr;     /* -b, default 127.0.0.1 */
    int         port;          /* -p, default 8080 (0 = pick a free port) */
    char        docroot[1024]; /* -d, default ./www (trailing slash removed) */
    int         workers;       /* -t, default 4 */
    int         keepalive_s;   /* -k, idle keep-alive timeout, 0 disables keep-alive */
    int         max_requests;  /* -m, requests per connection before closing */
    int         queue_cap;     /* -Q, pending-connection queue capacity */
    int         quiet;         /* -q, no access log */
} server_config_t;

typedef struct {
    server_config_t cfg;
    stats_t         stats;
    queue_t         queue;
    atomic_int      stopping; /* set by the Ctrl-C handler */
} server_t;

#endif /* TINYHTTPD_SERVER_H */
