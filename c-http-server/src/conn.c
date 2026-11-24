/*
 * conn.c - the per-connection request loop run by worker threads.
 *
 *   wait for bytes -> find end of header block -> parse -> route -> respond
 *        ^                                                            |
 *        +---------------- keep-alive: next request -----------------+
 *
 * Timeouts are enforced with a monotonic deadline plus short poll slices
 * instead of one long blocking recv(), so an idle keep-alive connection
 * notices server shutdown within POLL_SLICE_MS.
 */
#include "conn.h"
#include "fileserve.h"
#include "log.h"
#include "platform.h"
#include "response.h"

#include <string.h>

#define REQUEST_TIMEOUT_MS 10000 /* a started request must be complete within 10 s */
#define SHUTDOWN_GRACE_MS  1000  /* how long a queued connection may stay silent while stopping */
#define POLL_SLICE_MS      200
#define LINGER_MS          1000

#define MS_TO_NS(ms) ((uint64_t)(ms) * 1000000ULL)

static int path_is(const http_request_t *req, const char *s)
{
    size_t n = strlen(s);
    return req->path_len == n && memcmp(req->path, s, n) == 0;
}

/* Wait until fd is readable or the deadline passes. Returns 1 readable,
 * 0 timeout (or stop requested while idle), -1 error. */
static int wait_input(server_t *srv, sock_t fd, uint64_t deadline, int idle)
{
    for (;;) {
        uint64_t now = plat_now_ns(), left_ms;
        int r;
        if (now >= deadline)
            return 0;
        if (idle && atomic_load(&srv->stopping))
            return 0; /* shutting down: drop idle keep-alive connections */
        left_ms = (deadline - now) / 1000000ULL + 1;
        r = net_wait_readable(fd, left_ms < POLL_SLICE_MS ? (int)left_ms : POLL_SLICE_MS);
        if (r != 0)
            return r;
    }
}

/*
 * Make sure rx holds a complete header block.
 * Returns 0 when it does (*hdr_len = its length), -1 when the connection
 * should just be closed (EOF, error, idle timeout), or an HTTP status for a
 * framing error: 408 too slow, 414 request line too long, 431 headers too big.
 */
static int read_head(server_t *srv, sock_t fd, char *rx, size_t *used, int served,
                     long *hdr_len, uint64_t *t_start)
{
    uint64_t now = plat_now_ns(), deadline;

    *t_start = now;
    if (*used > 0) /* a pipelined request is already (partly) buffered */
        deadline = now + MS_TO_NS(REQUEST_TIMEOUT_MS);
    else if (served == 0)
        deadline = now + MS_TO_NS(atomic_load(&srv->stopping) ? SHUTDOWN_GRACE_MS
                                                              : REQUEST_TIMEOUT_MS);
    else
        deadline = now + MS_TO_NS((uint64_t)srv->cfg.keepalive_s * 1000ULL);

    for (;;) {
        size_t skip = 0;
        long n;
        int r;

        /* RFC 9112 2.2: ignore empty lines before a request line. */
        while (skip < *used && (rx[skip] == '\r' || rx[skip] == '\n'))
            skip++;
        if (skip > 0) {
            memmove(rx, rx + skip, *used - skip);
            *used -= skip;
        }
        if (*used > 0 && (*hdr_len = http_find_header_end(rx, *used)) >= 0)
            return 0;
        if (*used >= HTTP_MAX_HEADER_BYTES)
            return memchr(rx, '\n', *used) != NULL ? 431 : 414;

        r = wait_input(srv, fd, deadline, *used == 0 && served > 0);
        if (r < 0)
            return -1;
        if (r == 0)
            return *used > 0 ? 408 : -1;
        n = net_recv(fd, rx + *used, HTTP_MAX_HEADER_BYTES - *used);
        if (n <= 0)
            return -1;
        if (*used == 0) { /* first byte of a new request starts its clock */
            *t_start = plat_now_ns();
            deadline = *t_start + MS_TO_NS(REQUEST_TIMEOUT_MS);
        }
        *used += (size_t)n;
    }
}

/* Built-in endpoints first, then the static file handler. */
static int route(server_t *srv, conn_buffers_t *b, sock_t fd, const http_request_t *req,
                 int keep, unsigned long long *body, int *io_err)
{
    int head_only = req->method == HTTP_HEAD;
    resp_head_t h;

    memset(&h, 0, sizeof h);
    h.status = 200;
    h.keep_alive = keep;
    h.extra = "Cache-Control: no-store\r\n";

    if (path_is(req, "/__health")) {
        static const char ok[] = "ok\n";
        h.content_type = "text/plain; charset=utf-8";
        h.content_length = sizeof ok - 1;
        if (resp_send_simple(fd, &h, ok, sizeof ok - 1, head_only, body) != 0)
            *io_err = 1;
        return 200;
    }
    if (path_is(req, "/__stats")) {
        char json[1024];
        int n = stats_to_json(&srv->stats, queue_depth(&srv->queue), srv->cfg.workers, json,
                              sizeof json);
        if (n < 0) {
            if (resp_send_error(fd, 500, keep, head_only, NULL, body) != 0)
                *io_err = 1;
            return 500;
        }
        h.content_type = "application/json";
        h.content_length = (unsigned long long)n;
        if (resp_send_simple(fd, &h, json, (size_t)n, head_only, body) != 0)
            *io_err = 1;
        return 200;
    }
    return fs_serve(fd, srv->cfg.docroot, req, keep, b->tx, sizeof b->tx, body, io_err);
}

void conn_handle(server_t *srv, conn_buffers_t *b, const job_t *job)
{
    sock_t fd = job->fd;
    size_t used = 0;
    int served = 0, linger = 0;

    atomic_fetch_add(&srv->stats.active_connections, 1);
    atomic_fetch_add(&srv->stats.connections_total, 1);

    for (;;) {
        http_request_t req;
        long hdr_len = 0;
        uint64_t t_start;
        int status, keep = 0, io_err = 0;
        unsigned long long body = 0;
        int rc = read_head(srv, fd, b->rx, &used, served, &hdr_len, &t_start);

        if (rc < 0)
            break; /* client went away or idled out: nothing to answer */
        if (rc > 0) { /* framing error: answer, then close */
            if (resp_send_error(fd, rc, 0, 0, NULL, &body) == 0)
                linger = 1;
            stats_record(&srv->stats, rc);
            log_access(job->peer, NULL, rc, body, (double)(plat_now_ns() - t_start) / 1e6);
            break;
        }

        status = http_parse_request(b->rx, (size_t)hdr_len, &req);
        served++;
        if (status != 0) {
            /* Malformed or unsupported: we can't trust where the next request
             * would start, so the connection is always closed. */
            if (resp_send_error(fd, status, 0, 0, status == 405 ? "Allow: GET, HEAD\r\n" : NULL,
                                &body) != 0)
                io_err = 1;
        } else {
            keep = req.keep_alive && srv->cfg.keepalive_s > 0 &&
                   served < srv->cfg.max_requests && !atomic_load(&srv->stopping);
            status = route(srv, b, fd, &req, keep, &body, &io_err);
        }
        stats_record(&srv->stats, status);
        log_access(job->peer, &req, status, body, (double)(plat_now_ns() - t_start) / 1e6);

        if (io_err || !keep) {
            /* Unread input (error, or pipelined requests we won't serve)
             * would turn our close into a RST: drain it first. */
            linger = !io_err && (status >= 400 || (size_t)hdr_len < used);
            break;
        }
        /* Keep-alive: slide any pipelined bytes to the front of the buffer. */
        used -= (size_t)hdr_len;
        memmove(b->rx, b->rx + hdr_len, used);
    }

    if (linger)
        net_graceful_close(fd, LINGER_MS);
    else
        net_close(fd);
    atomic_fetch_sub(&srv->stats.active_connections, 1);
}
