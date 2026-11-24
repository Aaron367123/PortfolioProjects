/*
 * server.c - tinyhttpd entry point: CLI, accept loop, worker pool, shutdown.
 *
 *   main thread                      worker threads (N, fixed)
 *   -----------                      -------------------------
 *   accept() ──► queue_try_push() ─► queue_pop() ─► conn_handle()
 *                 │ full?                              (keep-alive loop)
 *                 └─► 503 + close (back-pressure)
 *
 * Shutdown (Ctrl-C / SIGINT / SIGTERM):
 *   1. the handler only sets srv.stopping (async-signal-safe)
 *   2. the accept loop sees it within ACCEPT_POLL_MS and closes the listener
 *   3. queue_close() wakes all workers; they finish the queue, then exit
 *   4. main joins every worker and prints the final statistics
 */
#include "conn.h"
#include "log.h"
#include "net.h"
#include "platform.h"
#include "queue.h"
#include "response.h"
#include "server.h"

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define ACCEPT_POLL_MS 250
#define LISTEN_BACKLOG 128
#define SEND_TIMEOUT_MS 10000
#define MAX_WORKERS 256

static server_t g_srv; /* global only so the signal handler can reach `stopping` */

static void request_stop(void) { atomic_store(&g_srv.stopping, 1); }

typedef struct {
    server_t       *srv;
    conn_buffers_t *bufs;
    pthread_t       thread;
} worker_t;

static void *worker_main(void *arg)
{
    worker_t *w = (worker_t *)arg;
    job_t job;
    /* queue_pop returns 0 only once the queue is closed *and* empty,
     * which is exactly "drain, then exit". */
    while (queue_pop(&w->srv->queue, &job) == 1)
        conn_handle(w->srv, w->bufs, &job);
    return NULL;
}

static void usage(const char *prog)
{
    printf("usage: %s [options]\n"
           "  -p <port>      port to listen on (default 8080, 0 = any free port)\n"
           "  -b <address>   bind address (default 127.0.0.1; 0.0.0.0 for all interfaces)\n"
           "  -d <dir>       document root (default ./www)\n"
           "  -t <n>         worker threads (default 4, max %d)\n"
           "  -k <seconds>   keep-alive idle timeout (default 5, 0 disables keep-alive)\n"
           "  -m <n>         max requests per connection (default 100)\n"
           "  -Q <n>         pending-connection queue size (default 64)\n"
           "  -q             quiet: no access log\n"
           "  -h, --help     show this help\n"
           "built-in endpoints: /__health, /__stats\n",
           prog, MAX_WORKERS);
}

/* Parse a decimal int in [lo, hi]; returns 0 on success. */
static int parse_int(const char *s, int lo, int hi, int *out)
{
    char *end;
    long v;
    errno = 0;
    v = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0' || v < lo || v > hi)
        return -1;
    *out = (int)v;
    return 0;
}

static int parse_args(int argc, char **argv, server_config_t *cfg)
{
    int i;
    const char *docroot = "./www";
    size_t len;

    cfg->bind_addr = "127.0.0.1";
    cfg->port = 8080;
    cfg->workers = 4;
    cfg->keepalive_s = 5;
    cfg->max_requests = 100;
    cfg->queue_cap = 64;
    cfg->quiet = 0;

    for (i = 1; i < argc; i++) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        int ok = 0;
        if (strcmp(a, "-h") == 0 || strcmp(a, "--help") == 0) {
            usage(argv[0]);
            exit(0);
        } else if (strcmp(a, "-q") == 0) {
            cfg->quiet = 1;
            continue;
        }
        if (v == NULL) {
            fprintf(stderr, "error: unknown option or missing value: %s\n", a);
            return -1;
        }
        if (strcmp(a, "-p") == 0)
            ok = parse_int(v, 0, 65535, &cfg->port) == 0;
        else if (strcmp(a, "-t") == 0)
            ok = parse_int(v, 1, MAX_WORKERS, &cfg->workers) == 0;
        else if (strcmp(a, "-k") == 0)
            ok = parse_int(v, 0, 3600, &cfg->keepalive_s) == 0;
        else if (strcmp(a, "-m") == 0)
            ok = parse_int(v, 1, INT_MAX, &cfg->max_requests) == 0;
        else if (strcmp(a, "-Q") == 0)
            ok = parse_int(v, 1, 65536, &cfg->queue_cap) == 0;
        else if (strcmp(a, "-b") == 0)
            ok = (cfg->bind_addr = v)[0] != '\0';
        else if (strcmp(a, "-d") == 0)
            ok = (docroot = v)[0] != '\0';
        if (!ok) {
            fprintf(stderr, "error: bad value for %s: %s\n", a, v);
            return -1;
        }
        i++;
    }

    len = strlen(docroot);
    if (len >= sizeof cfg->docroot) {
        fprintf(stderr, "error: document root path too long\n");
        return -1;
    }
    memcpy(cfg->docroot, docroot, len + 1);
    /* "www/" -> "www" so joining with "/file" never yields "//". */
    while (len > 1 && (cfg->docroot[len - 1] == '/' || cfg->docroot[len - 1] == '\\'))
        cfg->docroot[--len] = '\0';
    return 0;
}

/* Back-pressure: the queue is full, answer 503 right here and hang up. */
static void reject_busy(sock_t fd)
{
    unsigned long long sent;
    net_set_timeouts(fd, 0, 1000); /* never let a slow client block accept() */
    resp_send_error(fd, 503, 0, 0, "Retry-After: 1\r\n", &sent);
    net_close(fd);
}

static void accept_loop(server_t *srv, sock_t listener)
{
    while (!atomic_load(&srv->stopping)) {
        job_t job;
        int r = net_wait_readable(listener, ACCEPT_POLL_MS);
        if (r == 0)
            continue; /* timeout: re-check `stopping` */
        if (r < 0) {
            if (atomic_load(&srv->stopping))
                break;
            plat_sleep_ms(10);
            continue;
        }
        job.fd = net_accept(listener, job.peer, sizeof job.peer);
        if (job.fd == SOCK_INVALID) {
            plat_sleep_ms(1); /* e.g. out of descriptors: back off instead of spinning */
            continue;
        }
        /* Best effort: a failure here only costs latency or robustness. */
        (void)net_set_nodelay(job.fd);
        (void)net_set_timeouts(job.fd, 0, SEND_TIMEOUT_MS);

        if (queue_try_push(&srv->queue, &job) != 1) {
            atomic_fetch_add(&srv->stats.rejected_busy, 1);
            stats_record(&srv->stats, 503);
            log_access(job.peer, NULL, 503, 0, 0.0);
            reject_busy(job.fd);
        }
    }
}

int main(int argc, char **argv)
{
    server_t *srv = &g_srv;
    worker_t *workers;
    sock_t listener;
    int bound_port = 0, started = 0, i, rc = 1;

    memset(srv, 0, sizeof *srv);
    atomic_init(&srv->stopping, 0);
    if (parse_args(argc, argv, &srv->cfg) != 0) {
        usage(argv[0]);
        return 2;
    }
    log_init(srv->cfg.quiet);
    stats_init(&srv->stats);

    {
        plat_fileinfo_t fi;
        if (plat_stat(srv->cfg.docroot, &fi) != PLAT_OK || !fi.is_dir) {
            fprintf(stderr, "error: document root '%s' is not a directory\n", srv->cfg.docroot);
            return 1;
        }
    }
    if (net_init() != 0) {
        fprintf(stderr, "error: socket library initialisation failed\n");
        return 1;
    }
    listener = net_listen(srv->cfg.bind_addr, srv->cfg.port, LISTEN_BACKLOG, &bound_port);
    if (listener == SOCK_INVALID) {
        char msg[256];
        fprintf(stderr, "error: cannot listen on %s:%d: %s\n", srv->cfg.bind_addr,
                srv->cfg.port, net_strerror(net_last_error(), msg, sizeof msg));
        net_cleanup();
        return 1;
    }
    if (queue_init(&srv->queue, (size_t)srv->cfg.queue_cap) != 0) {
        fprintf(stderr, "error: cannot allocate work queue\n");
        net_close(listener);
        net_cleanup();
        return 1;
    }

    workers = calloc((size_t)srv->cfg.workers, sizeof *workers);
    if (workers == NULL) {
        fprintf(stderr, "error: out of memory\n");
        goto out_queue;
    }
    for (i = 0; i < srv->cfg.workers; i++) {
        workers[i].srv = srv;
        workers[i].bufs = malloc(sizeof *workers[i].bufs);
        if (workers[i].bufs == NULL ||
            pthread_create(&workers[i].thread, NULL, worker_main, &workers[i]) != 0) {
            fprintf(stderr, "error: cannot start worker %d\n", i);
            free(workers[i].bufs);
            workers[i].bufs = NULL;
            goto out_workers;
        }
        started++;
    }
    if (plat_install_stop_handler(request_stop) != 0)
        fprintf(stderr, "warning: cannot install Ctrl-C handler\n");

    log_msg("tinyhttpd listening on http://%s:%d/ (docroot %s, %d workers, queue %d, "
            "keep-alive %ds, max %d req/conn)",
            srv->cfg.bind_addr, bound_port, srv->cfg.docroot, srv->cfg.workers,
            srv->cfg.queue_cap, srv->cfg.keepalive_s, srv->cfg.max_requests);
    log_msg("press Ctrl-C to stop");

    accept_loop(srv, listener);
    log_msg("shutting down: no longer accepting, draining %llu queued connection(s)...",
            (unsigned long long)queue_depth(&srv->queue));
    rc = 0;

out_workers:
    net_close(listener);
    listener = SOCK_INVALID;
    queue_close(&srv->queue); /* wakes idle workers; busy ones finish first */
    for (i = 0; i < started; i++)
        pthread_join(workers[i].thread, NULL);
    for (i = 0; i < srv->cfg.workers; i++)
        free(workers[i].bufs);
    free(workers);
    if (rc == 0) {
        log_msg("all %d workers joined", started);
        stats_print_summary(&srv->stats, stdout);
        fflush(stdout);
    }
out_queue:
    if (listener != SOCK_INVALID)
        net_close(listener);
    queue_destroy(&srv->queue);
    net_cleanup();
    return rc;
}
