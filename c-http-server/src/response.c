/*
 * response.c - response heads and small complete responses.
 */
#include "response.h"
#include "http.h"

#include <stdio.h>
#include <string.h>

/* Bounded append helper: returns -1 once the output would be truncated. */
static int put(size_t cap, size_t *off, int n)
{
    if (n < 0 || (size_t)n >= cap - *off)
        return -1;
    *off += (size_t)n;
    return 0;
}

int resp_format_head(char *out, size_t cap, const resp_head_t *h)
{
    char date[HTTP_DATE_LEN];
    size_t off = 0;

    if (cap == 0 || http_format_date(time(NULL), date) != 0)
        return -1;
    if (put(cap, &off,
            snprintf(out, cap, "HTTP/1.1 %d %s\r\nDate: %s\r\nServer: " SERVER_NAME "\r\n",
                     h->status, http_reason(h->status), date)) != 0)
        return -1;
    if (h->content_type != NULL &&
        put(cap, &off,
            snprintf(out + off, cap - off, "Content-Type: %s\r\n", h->content_type)) != 0)
        return -1;
    if (!h->no_length &&
        put(cap, &off,
            snprintf(out + off, cap - off, "Content-Length: %llu\r\n", h->content_length)) != 0)
        return -1;
    if (h->last_modified != 0) {
        char lm[HTTP_DATE_LEN];
        if (http_format_date(h->last_modified, lm) == 0 &&
            put(cap, &off, snprintf(out + off, cap - off, "Last-Modified: %s\r\n", lm)) != 0)
            return -1;
    }
    if (put(cap, &off,
            snprintf(out + off, cap - off, "Connection: %s\r\n%s\r\n",
                     h->keep_alive ? "keep-alive" : "close",
                     h->extra != NULL ? h->extra : "")) != 0)
        return -1;
    return (int)off;
}

int resp_send_simple(sock_t fd, const resp_head_t *h, const char *body, size_t body_len,
                     int head_only, unsigned long long *body_sent)
{
    char buf[4096];
    int n = resp_format_head(buf, sizeof buf, h);
    size_t total;

    *body_sent = 0;
    if (n < 0)
        return -1;
    total = (size_t)n;
    if (!head_only && body_len > 0) {
        if (body_len <= sizeof buf - total) {
            memcpy(buf + total, body, body_len); /* coalesce into one packet */
            total += body_len;
        } else {
            if (net_send_all(fd, buf, total) != 0 || net_send_all(fd, body, body_len) != 0)
                return -1;
            *body_sent = body_len;
            return 0;
        }
    }
    if (net_send_all(fd, buf, total) != 0)
        return -1;
    *body_sent = head_only ? 0 : body_len;
    return 0;
}

int resp_send_error(sock_t fd, int status, int keep_alive, int head_only, const char *extra,
                    unsigned long long *body_sent)
{
    char body[128];
    resp_head_t h;
    int n = snprintf(body, sizeof body, "%d %s\n", status, http_reason(status));

    if (n < 0 || (size_t)n >= sizeof body)
        return -1;
    memset(&h, 0, sizeof h);
    h.status = status;
    h.content_type = "text/plain; charset=utf-8";
    h.content_length = (unsigned long long)n;
    h.keep_alive = keep_alive;
    h.extra = extra;
    return resp_send_simple(fd, &h, body, (size_t)n, head_only, body_sent);
}
