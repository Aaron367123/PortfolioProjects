/*
 * conn.h - one client connection: read requests, dispatch, keep-alive loop.
 */
#ifndef TINYHTTPD_CONN_H
#define TINYHTTPD_CONN_H

#include "http.h"
#include "queue.h"
#include "server.h"

#define CONN_TX_BUF (64 * 1024) /* file streaming chunk size */

/* Per-worker scratch memory, allocated once when the worker starts so the
 * request path never calls malloc. */
typedef struct {
    char rx[HTTP_MAX_HEADER_BYTES + 1];
    char tx[CONN_TX_BUF];
} conn_buffers_t;

/* Serve every request on the connection, then close it. */
void conn_handle(server_t *srv, conn_buffers_t *bufs, const job_t *job);

#endif /* TINYHTTPD_CONN_H */
