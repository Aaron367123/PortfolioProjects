/*
 * queue.h - bounded, thread-safe FIFO of accepted connections.
 *
 * A fixed-size ring buffer protected by one mutex and two condition
 * variables (not_empty for consumers, not_full for blocking producers).
 * The accept loop uses queue_try_push() so a full queue turns into an
 * immediate 503 instead of unbounded memory growth (back-pressure).
 */
#ifndef TINYHTTPD_QUEUE_H
#define TINYHTTPD_QUEUE_H

#include "net.h"

#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

/* One unit of work: an accepted client connection. */
typedef struct {
    sock_t fd;
    char   peer[NET_ADDRSTR_LEN]; /* numeric client address, for the access log */
} job_t;

typedef struct {
    job_t          *items;
    size_t          capacity;
    size_t          head;   /* index of the oldest item */
    size_t          count;  /* number of items stored */
    int             closed; /* no more pushes; pops drain what is left */
    pthread_mutex_t mu;
    pthread_cond_t  not_empty;
    pthread_cond_t  not_full;
} queue_t;

/* Returns 0 on success, -1 on allocation/initialisation failure. */
int  queue_init(queue_t *q, size_t capacity);
void queue_destroy(queue_t *q);

/* Non-blocking push. Returns 1 = queued, 0 = full, -1 = closed. */
int queue_try_push(queue_t *q, const job_t *job);

/* Blocking push: waits while full. Returns 1 = queued, -1 = closed. */
int queue_push(queue_t *q, const job_t *job);

/* Blocking pop: waits while empty. Returns 1 = got a job,
 * 0 = queue closed and fully drained (the consumer should exit). */
int queue_pop(queue_t *q, job_t *out);

/* Wake everyone; further pushes fail, pops return remaining items then 0. */
void queue_close(queue_t *q);

size_t queue_depth(queue_t *q);

#endif /* TINYHTTPD_QUEUE_H */
