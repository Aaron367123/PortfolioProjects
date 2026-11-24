/*
 * bench.c - a small closed-loop HTTP load generator.
 *
 *   bench -c <concurrency> -n <requests> [-k] http://host:port/path
 *
 * Starts `c` threads; each sends its share of the `n` GET requests one after
 * another (closed loop: a new request only after the previous response was
 * fully read), either over one persistent connection (-k) or with a fresh
 * TCP connection per request. Every request's latency is recorded so we can
 * report exact percentiles instead of averages only.
 */
#include "net.h"
#include "platform.h"

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RX_BUF (64 * 1024)
#define IO_TIMEOUT_MS 10000

typedef struct {
    /* input */
    const char *host;
    int         port;
    const char *request; /* the full request text, shared read-only */
    size_t      request_len;
    int         keepalive;
    size_t      count; /* requests this thread performs */
    double     *lat;   /* count slots, latency in ms for each success */
    /* output */
    size_t             ok;
    unsigned long long non2xx, err_connect, err_io, err_parse, bytes, connections;
    pthread_t          thread;
} bench_thread_t;

/* Start gate: all threads begin sending at the same moment. */
static pthread_mutex_t g_gate_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  g_gate_cv = PTHREAD_COND_INITIALIZER;
static int             g_gate_open;

static long find_head_end(const char *buf, size_t len)
{
    size_t i;
    for (i = 3; i < len; i++)
        if (buf[i - 3] == '\r' && buf[i - 2] == '\n' && buf[i - 1] == '\r' && buf[i] == '\n')
            return (long)(i + 1);
    return -1;
}

static int ieq_prefix(const char *s, const char *prefix)
{
    for (; *prefix; s++, prefix++) {
        char a = *s, b = *prefix;
        if (a >= 'A' && a <= 'Z')
            a = (char)(a + 32);
        if (b >= 'A' && b <= 'Z')
            b = (char)(b + 32);
        if (a != b)
            return 0;
    }
    return 1;
}

/*
 * Read one response. Returns 0 on success with *status, *close_after and
 * *body set; -1 on I/O error; -2 on an unparsable response.
 */
static int read_response(sock_t fd, char *buf, int *status, int *close_after,
                         unsigned long long *body)
{
    size_t used = 0;
    long head = -1;
    unsigned long long clen = 0, have;
    int has_clen = 0;
    const char *p;

    while (head < 0) {
        long n;
        if (used == RX_BUF - 1)
            return -2;
        n = net_recv(fd, buf + used, RX_BUF - 1 - used);
        if (n <= 0)
            return -1;
        used += (size_t)n;
        head = find_head_end(buf, used);
    }
    buf[head - 1] = '\0'; /* terminate the header block for string scanning */
    if (head < 12 || strncmp(buf, "HTTP/1.", 7) != 0 || buf[8] != ' ')
        return -2;
    *status = atoi(buf + 9);
    *close_after = strncmp(buf, "HTTP/1.0", 8) == 0;

    for (p = strchr(buf, '\n'); p != NULL; p = strchr(p, '\n')) {
        p++;
        if (ieq_prefix(p, "content-length:")) {
            clen = strtoull(p + 15, NULL, 10);
            has_clen = 1;
        } else if (ieq_prefix(p, "connection:")) {
            const char *v = p + 11;
            while (*v == ' ')
                v++;
            *close_after = ieq_prefix(v, "close");
        }
    }
    if (!has_clen)
        return -2; /* tinyhttpd always sends Content-Length */

    have = used - (size_t)head;
    if (have > clen)
        return -2; /* we never pipeline, so extra bytes are a protocol error */
    while (have < clen) {
        unsigned long long want = clen - have;
        long n = net_recv(fd, buf, want < RX_BUF ? (size_t)want : RX_BUF);
        if (n <= 0)
            return -1;
        have += (unsigned long long)n;
    }
    *body = clen;
    return 0;
}

static void *bench_main(void *arg)
{
    bench_thread_t *t = (bench_thread_t *)arg;
    char *buf = malloc(RX_BUF);
    sock_t fd = SOCK_INVALID;
    size_t i;

    pthread_mutex_lock(&g_gate_mu);
    while (!g_gate_open)
        pthread_cond_wait(&g_gate_cv, &g_gate_mu);
    pthread_mutex_unlock(&g_gate_mu);
    if (buf == NULL) {
        t->err_io = t->count;
        return NULL;
    }

    for (i = 0; i < t->count; i++) {
        uint64_t t0 = plat_now_ns();
        int status = 0, close_after = 0, rc;
        unsigned long long body = 0;

        if (fd == SOCK_INVALID) { /* connect time counts towards latency */
            fd = net_connect(t->host, t->port);
            if (fd == SOCK_INVALID) {
                t->err_connect++;
                continue;
            }
            t->connections++;
            (void)net_set_nodelay(fd);
            (void)net_set_timeouts(fd, IO_TIMEOUT_MS, IO_TIMEOUT_MS);
        }
        if (net_send_all(fd, t->request, t->request_len) != 0) {
            t->err_io++;
            net_close(fd);
            fd = SOCK_INVALID;
            continue;
        }
        rc = read_response(fd, buf, &status, &close_after, &body);
        if (rc != 0) {
            if (rc == -1)
                t->err_io++;
            else
                t->err_parse++;
            net_close(fd);
            fd = SOCK_INVALID;
            continue;
        }
        t->lat[t->ok++] = (double)(plat_now_ns() - t0) / 1e6;
        t->bytes += body;
        if (status < 200 || status > 299)
            t->non2xx++;
        if (!t->keepalive || close_after) {
            /* Wait for the server's FIN so the *server* holds TIME_WAIT and
             * we do not exhaust the client's ephemeral ports. */
            while (net_recv(fd, buf, RX_BUF) > 0) {
            }
            net_close(fd);
            fd = SOCK_INVALID;
        }
    }
    net_close(fd);
    free(buf);
    return NULL;
}

static int cmp_double(const void *a, const void *b)
{
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

/* Nearest-rank percentile of a sorted array. */
static double percentile(const double *v, size_t n, double p)
{
    size_t rank;
    if (n == 0)
        return 0.0;
    rank = (size_t)(p / 100.0 * (double)n + 0.999999);
    if (rank < 1)
        rank = 1;
    if (rank > n)
        rank = n;
    return v[rank - 1];
}

/* Parse "http://host[:port][/path]". */
static int parse_url(const char *url, char *host, size_t hostsz, int *port, const char **path)
{
    const char *h, *end, *colon;
    size_t hlen;
    if (strncmp(url, "http://", 7) != 0)
        return -1;
    h = url + 7;
    end = strchr(h, '/');
    *path = end != NULL ? end : "/";
    if (end == NULL)
        end = h + strlen(h);
    colon = memchr(h, ':', (size_t)(end - h));
    hlen = (size_t)((colon != NULL ? colon : end) - h);
    if (hlen == 0 || hlen >= hostsz)
        return -1;
    memcpy(host, h, hlen);
    host[hlen] = '\0';
    *port = 80;
    if (colon != NULL) {
        char *stop;
        long v = strtol(colon + 1, &stop, 10);
        if (stop != end || v < 1 || v > 65535)
            return -1;
        *port = (int)v;
    }
    return 0;
}

static void usage(const char *prog)
{
    printf("usage: %s [-c concurrency] [-n requests] [-k] http://host:port/path\n"
           "  -c <n>   parallel connections/threads (default 8)\n"
           "  -n <n>   total requests (default 1000)\n"
           "  -k       keep-alive: reuse one connection per thread\n",
           prog);
}

int main(int argc, char **argv)
{
    long conc = 8, total = 1000;
    int keepalive = 0, port = 0, i, created = 0;
    const char *url = NULL, *path = NULL;
    char host[256], request[1024];
    bench_thread_t *th;
    double *lat;
    size_t ok = 0, per, extra;
    unsigned long long non2xx = 0, e_conn = 0, e_io = 0, e_parse = 0, bytes = 0, conns = 0;
    uint64_t t_begin, t_end;
    double secs;
    int reqlen;

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-k") == 0) {
            keepalive = 1;
        } else if ((strcmp(argv[i], "-c") == 0 || strcmp(argv[i], "-n") == 0) && i + 1 < argc) {
            char *end;
            long v;
            errno = 0;
            v = strtol(argv[i + 1], &end, 10);
            if (errno != 0 || *end != '\0' || v < 1 || v > 100000000L) {
                fprintf(stderr, "bad value for %s\n", argv[i]);
                return 2;
            }
            if (argv[i][1] == 'c')
                conc = v;
            else
                total = v;
            i++;
        } else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else if (url == NULL && argv[i][0] != '-') {
            url = argv[i];
        } else {
            usage(argv[0]);
            return 2;
        }
    }
    if (url == NULL || parse_url(url, host, sizeof host, &port, &path) != 0) {
        usage(argv[0]);
        return 2;
    }
    if (conc > 1024)
        conc = 1024;
    if (conc > total)
        conc = total;

    reqlen = snprintf(request, sizeof request,
                      "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUser-Agent: tinyhttpd-bench\r\n%s\r\n",
                      path, host, port, keepalive ? "" : "Connection: close\r\n");
    if (reqlen < 0 || (size_t)reqlen >= sizeof request) {
        fprintf(stderr, "URL too long\n");
        return 2;
    }
    if (net_init() != 0) {
        fprintf(stderr, "socket init failed\n");
        return 1;
    }

    th = calloc((size_t)conc, sizeof *th);
    lat = malloc((size_t)total * sizeof *lat);
    if (th == NULL || lat == NULL) {
        fprintf(stderr, "out of memory\n");
        free(th);
        free(lat);
        net_cleanup();
        return 1;
    }

    /* Split n requests over c threads; each owns a disjoint slice of `lat`. */
    per = (size_t)(total / conc);
    extra = (size_t)(total % conc);
    {
        size_t offset = 0;
        for (i = 0; i < conc; i++) {
            th[i].host = host;
            th[i].port = port;
            th[i].request = request;
            th[i].request_len = (size_t)reqlen;
            th[i].keepalive = keepalive;
            th[i].count = per + ((size_t)i < extra ? 1 : 0);
            th[i].lat = lat + offset;
            offset += th[i].count;
            if (pthread_create(&th[i].thread, NULL, bench_main, &th[i]) != 0) {
                fprintf(stderr, "cannot create thread %d\n", i);
                break;
            }
            created++;
        }
    }

    pthread_mutex_lock(&g_gate_mu);
    g_gate_open = 1;
    t_begin = plat_now_ns();
    pthread_cond_broadcast(&g_gate_cv);
    pthread_mutex_unlock(&g_gate_mu);
    for (i = 0; i < created; i++)
        pthread_join(th[i].thread, NULL);
    t_end = plat_now_ns();
    secs = (double)(t_end - t_begin) / 1e9;

    /* Compact all successful latencies to the front, then sort once. */
    for (i = 0; i < created; i++) {
        if (th[i].lat != lat + ok)
            memmove(lat + ok, th[i].lat, th[i].ok * sizeof *lat);
        ok += th[i].ok;
        non2xx += th[i].non2xx;
        e_conn += th[i].err_connect;
        e_io += th[i].err_io;
        e_parse += th[i].err_parse;
        bytes += th[i].bytes;
        conns += th[i].connections;
    }
    qsort(lat, ok, sizeof *lat, cmp_double);

    {
        double sum = 0.0;
        size_t k;
        for (k = 0; k < ok; k++)
            sum += lat[k];
        printf("tinyhttpd bench: %ld requests, %d connections, keep-alive %s\n", total, created,
               keepalive ? "on" : "off");
        printf("target:          %s\n\n", url);
        printf("  completed      %zu\n", ok);
        printf("  failed         %llu (connect %llu, io %llu, parse %llu)\n",
               e_conn + e_io + e_parse, e_conn, e_io, e_parse);
        printf("  non-2xx        %llu\n", non2xx);
        printf("  connections    %llu opened\n", conns);
        printf("  total time     %.3f s\n", secs);
        printf("  requests/sec   %.1f\n", secs > 0 ? (double)ok / secs : 0.0);
        printf("  transfer       %.2f MB body (%.2f MB/s)\n\n", (double)bytes / 1e6,
               secs > 0 ? (double)bytes / 1e6 / secs : 0.0);
        printf("latency (ms)     min %.3f  avg %.3f  p50 %.3f  p90 %.3f  p99 %.3f  max %.3f\n",
               ok ? lat[0] : 0.0, ok ? sum / (double)ok : 0.0, percentile(lat, ok, 50),
               percentile(lat, ok, 90), percentile(lat, ok, 99), ok ? lat[ok - 1] : 0.0);
    }

    free(lat);
    free(th);
    net_cleanup();
    return (e_conn + e_io + e_parse) == 0 ? 0 : 1;
}
