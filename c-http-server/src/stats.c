/*
 * stats.c - counters updated by every worker without taking a lock.
 *
 * Each counter is an independent atomic, so a /__stats snapshot is not a
 * single consistent instant (requests_total may be read a moment before
 * by_status). That is the usual trade-off for metrics and is fine here.
 */
#include "stats.h"
#include "platform.h"

#include <string.h>

static const int k_codes[STATS_NCODES] = {200, 301, 304, 400, 403, 404, 405, 408,
                                          413, 414, 431, 500, 503, 505, 501};

void stats_init(stats_t *s)
{
    int i;
    s->start_ns = plat_now_ns();
    atomic_init(&s->requests_total, 0);
    for (i = 0; i < STATS_NCODES; i++)
        atomic_init(&s->by_status[i], 0);
    atomic_init(&s->by_status_other, 0);
    atomic_init(&s->connections_total, 0);
    atomic_init(&s->rejected_busy, 0);
    atomic_init(&s->active_connections, 0);
}

void stats_record(stats_t *s, int status)
{
    int i;
    atomic_fetch_add(&s->requests_total, 1);
    for (i = 0; i < STATS_NCODES; i++) {
        if (k_codes[i] == status) {
            atomic_fetch_add(&s->by_status[i], 1);
            return;
        }
    }
    atomic_fetch_add(&s->by_status_other, 1);
}

/* Append formatted text at *off; returns -1 once the buffer is exhausted. */
static int append(size_t cap, size_t *off, int n)
{
    if (n < 0 || (size_t)n >= cap - *off)
        return -1;
    *off += (size_t)n;
    return 0;
}

int stats_to_json(stats_t *s, size_t queue_depth, int workers, char *out, size_t cap)
{
    size_t off = 0;
    int i, first = 1;
    double uptime = (double)(plat_now_ns() - s->start_ns) / 1e9;

    if (cap == 0)
        return -1;
    if (append(cap, &off,
               snprintf(out, cap, "{\"uptime_s\":%.3f,\"requests_total\":%llu,\"by_status\":{",
                        uptime, (unsigned long long)atomic_load(&s->requests_total))) != 0)
        return -1;
    for (i = 0; i < STATS_NCODES; i++) {
        unsigned long long n = atomic_load(&s->by_status[i]);
        if (n == 0)
            continue;
        if (append(cap, &off,
                   snprintf(out + off, cap - off, "%s\"%d\":%llu", first ? "" : ",",
                            k_codes[i], n)) != 0)
            return -1;
        first = 0;
    }
    {
        unsigned long long other = atomic_load(&s->by_status_other);
        if (other > 0 &&
            append(cap, &off,
                   snprintf(out + off, cap - off, "%s\"other\":%llu", first ? "" : ",", other)) != 0)
            return -1;
    }
    if (append(cap, &off,
               snprintf(out + off, cap - off,
                        "},\"active_connections\":%d,\"connections_total\":%llu,"
                        "\"rejected_busy\":%llu,\"queue_depth\":%zu,\"workers\":%d}\n",
                        atomic_load(&s->active_connections),
                        (unsigned long long)atomic_load(&s->connections_total),
                        (unsigned long long)atomic_load(&s->rejected_busy), queue_depth,
                        workers)) != 0)
        return -1;
    return (int)off;
}

void stats_print_summary(stats_t *s, FILE *f)
{
    int i;
    double uptime = (double)(plat_now_ns() - s->start_ns) / 1e9;
    fprintf(f, "stats: %llu requests on %llu connections in %.1f s (",
            (unsigned long long)atomic_load(&s->requests_total),
            (unsigned long long)atomic_load(&s->connections_total), uptime);
    for (i = 0; i < STATS_NCODES; i++) {
        unsigned long long n = atomic_load(&s->by_status[i]);
        if (n > 0)
            fprintf(f, " %d=%llu", k_codes[i], n);
    }
    fprintf(f, " ), %llu rejected busy\n", (unsigned long long)atomic_load(&s->rejected_busy));
}
