/*
 * queue.c - bounded ring-buffer work queue (mutex + two condition variables).
 *
 * Invariants (all guarded by q->mu):
 *   0 <= count <= capacity
 *   items live at indices head, head+1, ..., head+count-1 (mod capacity)
 * Every wait is in a while loop because condition variables may wake up
 * spuriously and because another thread may have taken the slot first.
 */
#include "queue.h"

#include <stdlib.h>

int queue_init(queue_t *q, size_t capacity)
{
    if (capacity == 0)
        return -1;
    q->items = calloc(capacity, sizeof *q->items);
    if (q->items == NULL)
        return -1;
    q->capacity = capacity;
    q->head = 0;
    q->count = 0;
    q->closed = 0;
    if (pthread_mutex_init(&q->mu, NULL) != 0)
        goto fail_mutex;
    if (pthread_cond_init(&q->not_empty, NULL) != 0)
        goto fail_empty;
    if (pthread_cond_init(&q->not_full, NULL) != 0)
        goto fail_full;
    return 0;

fail_full:
    pthread_cond_destroy(&q->not_empty);
fail_empty:
    pthread_mutex_destroy(&q->mu);
fail_mutex:
    free(q->items);
    q->items = NULL;
    return -1;
}

void queue_destroy(queue_t *q)
{
    pthread_cond_destroy(&q->not_full);
    pthread_cond_destroy(&q->not_empty);
    pthread_mutex_destroy(&q->mu);
    free(q->items);
    q->items = NULL;
}

/* Caller holds q->mu and has checked there is room. */
static void enqueue_locked(queue_t *q, const job_t *job)
{
    size_t tail = (q->head + q->count) % q->capacity;
    q->items[tail] = *job;
    q->count++;
    pthread_cond_signal(&q->not_empty); /* one item -> wake one consumer */
}

int queue_try_push(queue_t *q, const job_t *job)
{
    int rc;
    pthread_mutex_lock(&q->mu);
    if (q->closed) {
        rc = -1;
    } else if (q->count == q->capacity) {
        rc = 0; /* full: caller applies back-pressure (503) */
    } else {
        enqueue_locked(q, job);
        rc = 1;
    }
    pthread_mutex_unlock(&q->mu);
    return rc;
}

int queue_push(queue_t *q, const job_t *job)
{
    int rc = -1;
    pthread_mutex_lock(&q->mu);
    while (!q->closed && q->count == q->capacity)
        pthread_cond_wait(&q->not_full, &q->mu);
    if (!q->closed) {
        enqueue_locked(q, job);
        rc = 1;
    }
    pthread_mutex_unlock(&q->mu);
    return rc;
}

int queue_pop(queue_t *q, job_t *out)
{
    int rc = 0;
    pthread_mutex_lock(&q->mu);
    while (q->count == 0 && !q->closed)
        pthread_cond_wait(&q->not_empty, &q->mu);
    if (q->count > 0) { /* closed queues still hand out what is left */
        *out = q->items[q->head];
        q->head = (q->head + 1) % q->capacity;
        q->count--;
        pthread_cond_signal(&q->not_full); /* one slot freed -> wake one producer */
        rc = 1;
    }
    pthread_mutex_unlock(&q->mu);
    return rc;
}

void queue_close(queue_t *q)
{
    pthread_mutex_lock(&q->mu);
    q->closed = 1;
    pthread_cond_broadcast(&q->not_empty); /* every waiter must re-check `closed` */
    pthread_cond_broadcast(&q->not_full);
    pthread_mutex_unlock(&q->mu);
}

size_t queue_depth(queue_t *q)
{
    size_t n;
    pthread_mutex_lock(&q->mu);
    n = q->count;
    pthread_mutex_unlock(&q->mu);
    return n;
}
