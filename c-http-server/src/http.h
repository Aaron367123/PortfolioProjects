/*
 * http.h - HTTP/1.x request parsing and small protocol helpers.
 *
 * Everything here is pure (no sockets, no globals), which is what makes the
 * parser easy to unit-test: feed it bytes, inspect the struct.
 */
#ifndef TINYHTTPD_HTTP_H
#define TINYHTTPD_HTTP_H

#include <stddef.h>
#include <time.h>

#define HTTP_MAX_HEADER_BYTES 8192 /* request line + headers; beyond -> 431 */
#define HTTP_MAX_URI          2048 /* request-target length; beyond -> 414 */
#define HTTP_MAX_HEADERS      64   /* header field count; beyond -> 431 */
#define HTTP_DATE_LEN         32   /* buffer for "Sun, 06 Nov 1994 08:49:37 GMT" */

typedef enum { HTTP_GET, HTTP_HEAD, HTTP_OTHER } http_method_t;

typedef struct {
    const char *name;  /* NUL-terminated, points into the request buffer */
    const char *value; /* NUL-terminated, surrounding whitespace trimmed */
} http_header_t;

typedef struct {
    http_method_t method;
    const char   *method_str;    /* e.g. "GET"; NULL if the line was unparsable */
    const char   *target;        /* raw request-target as sent; NULL if unparsable */
    const char   *path;          /* start of the (still percent-encoded) path */
    size_t        path_len;      /* path ends at '?' or end of target */
    const char   *query;         /* text after '?', or NULL */
    int           version_minor; /* HTTP/1.0 -> 0, HTTP/1.1 -> 1 */
    int           keep_alive;    /* persistent connection requested? */
    const char   *host;          /* Host header, or NULL */
    const char   *if_modified_since;
    http_header_t headers[HTTP_MAX_HEADERS];
    size_t        header_count;
} http_request_t;

/*
 * Find the end of the header block ("\r\n\r\n", tolerating bare "\n\n").
 * Returns the number of bytes up to and including the blank line, or -1 if
 * the block is not complete yet.
 */
long http_find_header_end(const char *buf, size_t len);

/*
 * Parse a complete header block of `len` bytes. The buffer is modified in
 * place (NUL terminators are written) and `req` points into it.
 * Returns 0 on success or the HTTP status code to answer with:
 *   400 malformed, 405 method not allowed, 414 URI too long,
 *   431 too many headers, 505 unsupported HTTP version.
 */
int http_parse_request(char *buf, size_t len, http_request_t *req);

/* Case-insensitive header lookup; NULL if absent. */
const char *http_get_header(const http_request_t *req, const char *name);

/*
 * Decode %XX escapes from `in` (inlen bytes) into `out` (outsz bytes,
 * always NUL-terminated on success). Rejects malformed escapes and encoded
 * NUL bytes (%00). Returns the decoded length, or -1 on error/overflow.
 */
long http_percent_decode(const char *in, size_t inlen, char *out, size_t outsz);

/* Reason phrase for a status code ("Not Found"); "Unknown" if not listed. */
const char *http_reason(int status);

/* Format/parse an IMF-fixdate ("Sun, 06 Nov 1994 08:49:37 GMT"). */
int http_format_date(time_t t, char out[HTTP_DATE_LEN]);
int http_parse_date(const char *s, time_t *out);

/* ASCII case-insensitive string equality (locale independent). */
int http_strcaseeq(const char *a, const char *b);

#endif /* TINYHTTPD_HTTP_H */
