/*
 * stats.h - lock-free server counters (C11 atomics), exposed at /__stats.
 */
#ifndef TINYHTTPD_STATS_H
#define TINYHTTPD_STATS_H

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define STATS_NCODES 15

typedef struct {
    uint64_t           start_ns; /* plat_now_ns() at startup (written once) */
    atomic_ullong      requests_total;
    atomic_ullong      by_status[STATS_NCODES]; /* parallel to k_codes in stats.c */
    atomic_ullong      by_status_other;
    atomic_ullong      connections_total;
    atomic_ullong      rejected_busy; /* connections refused with 503 */
    atomic_int         active_connections;
} stats_t;

void stats_init(stats_t *s);

/* Count one response with the given status code. */
void stats_record(stats_t *s, int status);

/* Render the /__stats JSON document. Returns its length, or -1 if it did not fit. */
int stats_to_json(stats_t *s, size_t queue_depth, int workers, char *out, size_t cap);

/* One-line human summary, printed at shutdown. */
void stats_print_summary(stats_t *s, FILE *f);

#endif /* TINYHTTPD_STATS_H */
