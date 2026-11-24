/*
 * test_main.c - unit tests for the pure parts of tinyhttpd: request parser,
 * percent-decoder, path sanitiser, MIME table, dates and the work queue.
 *
 * Deliberately framework-free: CHECK() records a failure and keeps going so
 * one run shows every broken assertion.
 */
#include "fileserve.h"
#include "http.h"
#include "mime.h"
#include "queue.h"

#include <pthread.h>
#include <stdio.h>
#include <string.h>

static int g_checks, g_failures;

#define CHECK(cond)                                                              \
    do {                                                                         \
        g_checks++;                                                              \
        if (!(cond)) {                                                           \
            g_failures++;                                                        \
            fprintf(stderr, "  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);    \
        }                                                                        \
    } while (0)

#define CHECK_STR(a, b) CHECK((a) != NULL && strcmp((a), (b)) == 0)

/* Parse a request held in a string literal (copied: the parser writes NULs). */
static char g_buf[HTTP_MAX_HEADER_BYTES * 2];
static int parse(const char *text, http_request_t *req)
{
    size_t n = strlen(text);
    memcpy(g_buf, text, n + 1);
    return http_parse_request(g_buf, n, req);
}

/* ------------------------------------------------------------------ */

static void test_find_header_end(void)
{
    CHECK(http_find_header_end("GET / HTTP/1.1\r\nHost: a\r\n\r\n", 27) == 27);
    CHECK(http_find_header_end("GET / HTTP/1.1\r\nHost: a\r\n\r\nGET", 30) == 27);
    CHECK(http_find_header_end("GET / HTTP/1.0\n\n", 16) == 16);
    CHECK(http_find_header_end("GET / HTTP/1.1\r\nHost: a\r\n", 25) == -1);
    CHECK(http_find_header_end("", 0) == -1);
}

static void test_parse_valid(void)
{
    http_request_t r;
    CHECK(parse("GET /index.html?x=1&y HTTP/1.1\r\nHost: example\r\nUser-Agent:  t  \r\n\r\n",
                &r) == 0);
    CHECK(r.method == HTTP_GET);
    CHECK_STR(r.method_str, "GET");
    CHECK_STR(r.target, "/index.html?x=1&y");
    CHECK(r.path_len == strlen("/index.html") && memcmp(r.path, "/index.html", r.path_len) == 0);
    CHECK_STR(r.query, "x=1&y");
    CHECK(r.version_minor == 1);
    CHECK(r.keep_alive == 1);
    CHECK_STR(r.host, "example");
    CHECK_STR(http_get_header(&r, "user-agent"), "t"); /* OWS trimmed, case-insensitive */
    CHECK(http_get_header(&r, "Missing") == NULL);
    CHECK(r.header_count == 2);

    CHECK(parse("HEAD / HTTP/1.1\r\nHost: x\r\n\r\n", &r) == 0);
    CHECK(r.method == HTTP_HEAD);
    CHECK(r.query == NULL);

    /* bare LF line endings are tolerated */
    CHECK(parse("GET /a HTTP/1.1\nHost: x\n\n", &r) == 0);

    /* absolute-form target */
    CHECK(parse("GET http://example.com/p/q?z HTTP/1.1\r\nHost: example.com\r\n\r\n", &r) == 0);
    CHECK(r.path_len == 4 && memcmp(r.path, "/p/q", 4) == 0);
    CHECK_STR(r.query, "z");
    CHECK(parse("GET http://example.com HTTP/1.1\r\nHost: example.com\r\n\r\n", &r) == 0);
    CHECK(r.path_len == 1 && r.path[0] == '/');

    /* If-Modified-Since captured; Content-Length: 0 is fine */
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n"
                "If-Modified-Since: Sun, 06 Nov 1994 08:49:37 GMT\r\n\r\n",
                &r) == 0);
    CHECK_STR(r.if_modified_since, "Sun, 06 Nov 1994 08:49:37 GMT");

    /* HTTP/1.2 is handled as 1.1 */
    CHECK(parse("GET / HTTP/1.2\r\nHost: x\r\n\r\n", &r) == 0);
    CHECK(r.version_minor == 1);
}

static void test_parse_keepalive(void)
{
    http_request_t r;
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", &r) == 0);
    CHECK(r.keep_alive == 0);
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade, CLOSE\r\n\r\n", &r) == 0);
    CHECK(r.keep_alive == 0);
    CHECK(parse("GET / HTTP/1.0\r\n\r\n", &r) == 0); /* 1.0: no Host required */
    CHECK(r.version_minor == 0);
    CHECK(r.keep_alive == 0);
    CHECK(parse("GET / HTTP/1.0\r\nConnection: keep-alive\r\n\r\n", &r) == 0);
    CHECK(r.keep_alive == 1);
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nConnection: closed\r\n\r\n", &r) == 0);
    CHECK(r.keep_alive == 1); /* "closed" is not the token "close" */
}

static void test_parse_errors(void)
{
    http_request_t r;
    char big[HTTP_MAX_URI + 64];
    char many[HTTP_MAX_HEADER_BYTES];
    size_t off;
    int i;

    CHECK(parse("garbage\r\n\r\n", &r) == 400);
    CHECK(parse("\x01\x02\x03 / HTTP/1.1\r\n\r\n", &r) == 400);
    CHECK(parse("GET  / HTTP/1.1\r\nHost: x\r\n\r\n", &r) == 400);  /* double space */
    CHECK(parse("GET / HTTP/1.1 \r\nHost: x\r\n\r\n", &r) == 400);  /* trailing space */
    CHECK(parse("GET / HTTX/1.1\r\nHost: x\r\n\r\n", &r) == 400);
    CHECK(parse("GET / HTTP/2.0\r\nHost: x\r\n\r\n", &r) == 505);
    CHECK(parse("GET / HTTP/1.1\r\n\r\n", &r) == 400);              /* missing Host */
    CHECK(parse("GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n", &r) == 400);
    CHECK(parse("GET / HTTP/1.1\r\nHost : x\r\n\r\n", &r) == 400);  /* space before colon */
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nNoColon\r\n\r\n", &r) == 400);
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\n folded\r\n\r\n", &r) == 400);
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\rY: z\r\n\r\n", &r) == 400); /* bare CR */
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n", &r) == 400);
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nContent-Length: abc\r\n\r\n", &r) == 400);
    CHECK(parse("GET / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n", &r) == 400);
    CHECK(parse("GET relative HTTP/1.1\r\nHost: x\r\n\r\n", &r) == 400);
    CHECK(parse("GET /\xff HTTP/1.1\r\nHost: x\r\n\r\n", &r) == 400); /* raw non-ASCII */

    /* 405 for well-formed but unsupported methods; method is case-sensitive */
    CHECK(parse("POST /form HTTP/1.1\r\nHost: x\r\n\r\n", &r) == 405);
    CHECK(parse("DELETE / HTTP/1.1\r\nHost: x\r\n\r\n", &r) == 405);
    CHECK(parse("get / HTTP/1.1\r\nHost: x\r\n\r\n", &r) == 405);
    CHECK_STR(r.method_str, "get"); /* request line still exposed for logging */

    /* 414: target longer than HTTP_MAX_URI */
    off = (size_t)snprintf(big, sizeof big, "GET /");
    memset(big + off, 'a', HTTP_MAX_URI);
    off += HTTP_MAX_URI;
    off += (size_t)snprintf(big + off, sizeof big - off, " HTTP/1.1\r\nHost: x\r\n\r\n");
    CHECK(parse(big, &r) == 414);

    /* 431: more than HTTP_MAX_HEADERS fields */
    off = (size_t)snprintf(many, sizeof many, "GET / HTTP/1.1\r\nHost: x\r\n");
    for (i = 0; i < HTTP_MAX_HEADERS; i++)
        off += (size_t)snprintf(many + off, sizeof many - off, "X-%d: v\r\n", i);
    off += (size_t)snprintf(many + off, sizeof many - off, "\r\n");
    CHECK(off < sizeof many);
    CHECK(parse(many, &r) == 431);
}

static void test_percent_decode(void)
{
    char out[64];
    CHECK(http_percent_decode("/a%20b", 6, out, sizeof out) == 4);
    CHECK_STR(out, "/a b");
    CHECK(http_percent_decode("%2e%2E", 6, out, sizeof out) == 2);
    CHECK_STR(out, "..");
    CHECK(http_percent_decode("%5c", 3, out, sizeof out) == 1);
    CHECK_STR(out, "\\");
    CHECK(http_percent_decode("a+b", 3, out, sizeof out) == 3); /* '+' is literal in paths */
    CHECK_STR(out, "a+b");
    CHECK(http_percent_decode("%zz", 3, out, sizeof out) == -1);
    CHECK(http_percent_decode("%4", 2, out, sizeof out) == -1);
    CHECK(http_percent_decode("abc%", 4, out, sizeof out) == -1);
    CHECK(http_percent_decode("a%00b", 5, out, sizeof out) == -1); /* encoded NUL */
    CHECK(http_percent_decode("abcdef", 6, out, 4) == -1);          /* overflow */
    CHECK(http_percent_decode("abc", 3, out, 4) == 3);              /* exact fit */
    CHECK(http_percent_decode("", 0, out, 1) == 0);
    CHECK(http_percent_decode("/x", 1, out, sizeof out) == 1);      /* honours inlen */
    CHECK_STR(out, "/");
}

static int sanitize(const char *in, char *out, int *trailing)
{
    return fs_sanitize_path(in, out, 256, trailing);
}

static void test_sanitize(void)
{
    char out[256];
    int t = -1;

    CHECK(sanitize("/", out, &t) == 0);
    CHECK_STR(out, "/");
    CHECK(t == 1);
    CHECK(sanitize("/index.html", out, &t) == 0);
    CHECK_STR(out, "/index.html");
    CHECK(t == 0);
    CHECK(sanitize("//a///b/./c.txt", out, &t) == 0);
    CHECK_STR(out, "/a/b/c.txt");
    CHECK(sanitize("/docs/", out, &t) == 0);
    CHECK_STR(out, "/docs");
    CHECK(t == 1);
    CHECK(sanitize("/a b/ünïcode.txt", out, &t) == 0); /* decoded UTF-8 is fine */

    /* traversal and friends */
    CHECK(sanitize("/..", out, &t) == 403);
    CHECK(sanitize("/../etc/passwd", out, &t) == 403);
    CHECK(sanitize("/a/../../b", out, &t) == 403);
    CHECK(sanitize("/a/..", out, &t) == 403);
    CHECK(sanitize("/..\\windows", out, &t) == 403);    /* backslash */
    CHECK(sanitize("/a\\b", out, &t) == 403);
    CHECK(sanitize("/C:/Windows", out, &t) == 403);     /* drive letter */
    CHECK(sanitize("/file.txt::$DATA", out, &t) == 403); /* NTFS stream */
    CHECK(sanitize("/.git/config", out, &t) == 403);    /* dotfiles */
    CHECK(sanitize("/.env", out, &t) == 403);
    CHECK(sanitize("/index.html.", out, &t) == 403);    /* trailing dot */
    CHECK(sanitize("/index.html ", out, &t) == 403);    /* trailing space */
    CHECK(sanitize("/a\x01" "b", out, &t) == 403);      /* control char */
    CHECK(sanitize("/con", out, &t) == 403);            /* device names */
    CHECK(sanitize("/docs/NUL.txt", out, &t) == 403);
    CHECK(sanitize("/com1", out, &t) == 403);
    CHECK(sanitize("/LPT9.log", out, &t) == 403);
    CHECK(sanitize("/conin$", out, &t) == 403);
    CHECK(sanitize("/a*b", out, &t) == 403);            /* wildcards */
    CHECK(sanitize("/console.html", out, &t) == 0);     /* only exact device names */
    CHECK(sanitize("/com10", out, &t) == 0);
    CHECK(sanitize("relative", out, &t) == 400);

    /* output buffer too small */
    CHECK(fs_sanitize_path("/abcdef", out, 4, &t) == 414);
    CHECK(fs_sanitize_path("/ab", out, 4, &t) == 0);
}

static void test_mime(void)
{
    CHECK_STR(mime_type_for("/index.html"), "text/html; charset=utf-8");
    CHECK_STR(mime_type_for("/INDEX.HTM"), "text/html; charset=utf-8");
    CHECK_STR(mime_type_for("www/style.css"), "text/css; charset=utf-8");
    CHECK_STR(mime_type_for("app.js"), "text/javascript; charset=utf-8");
    CHECK_STR(mime_type_for("/img/photo.JPEG"), "image/jpeg");
    CHECK_STR(mime_type_for("/a.tar.gz"), "application/gzip");
    CHECK_STR(mime_type_for("/data.json"), "application/json");
    CHECK_STR(mime_type_for("/noext"), "application/octet-stream");
    CHECK_STR(mime_type_for("/dir.d/noext"), "application/octet-stream");
    CHECK_STR(mime_type_for("/trailing."), "application/octet-stream");
    CHECK_STR(mime_type_for("/x.unknownext"), "application/octet-stream");
}

static void test_dates(void)
{
    char buf[HTTP_DATE_LEN];
    time_t t = 0;
    CHECK(http_format_date((time_t)784111777, buf) == 0);
    CHECK_STR(buf, "Sun, 06 Nov 1994 08:49:37 GMT");
    CHECK(http_parse_date("Sun, 06 Nov 1994 08:49:37 GMT", &t) == 0);
    CHECK(t == (time_t)784111777);
    CHECK(http_parse_date("Thu, 01 Jan 1970 00:00:00 GMT", &t) == 0);
    CHECK(t == 0);
    CHECK(http_parse_date("Tue, 29 Feb 2028 23:59:59 GMT", &t) == 0); /* leap day */
    CHECK(http_format_date(t, buf) == 0);
    CHECK_STR(buf, "Tue, 29 Feb 2028 23:59:59 GMT");
    CHECK(http_parse_date("Sunday, 06-Nov-94 08:49:37 GMT", &t) == -1); /* RFC 850: ignored */
    CHECK(http_parse_date("Sun, 06 Foo 1994 08:49:37 GMT", &t) == -1);
    CHECK(http_parse_date("garbage", &t) == -1);
    CHECK_STR(http_reason(404), "Not Found");
    CHECK_STR(http_reason(431), "Request Header Fields Too Large");
    CHECK_STR(http_reason(999), "Unknown");
}

/* ---- queue ---- */

static job_t make_job(int n)
{
    job_t j;
    memset(&j, 0, sizeof j);
    j.fd = (sock_t)n;
    return j;
}

static void test_queue_basic(void)
{
    queue_t q;
    job_t j;
    int i;

    CHECK(queue_init(&q, 0) == -1);
    CHECK(queue_init(&q, 3) == 0);
    for (i = 1; i <= 3; i++) {
        j = make_job(i);
        CHECK(queue_try_push(&q, &j) == 1);
    }
    j = make_job(4);
    CHECK(queue_try_push(&q, &j) == 0); /* full -> back-pressure */
    CHECK(queue_depth(&q) == 3);

    CHECK(queue_pop(&q, &j) == 1 && j.fd == 1); /* FIFO order */
    j = make_job(4);
    CHECK(queue_try_push(&q, &j) == 1);         /* wraps around the ring */
    CHECK(queue_pop(&q, &j) == 1 && j.fd == 2);
    CHECK(queue_pop(&q, &j) == 1 && j.fd == 3);

    queue_close(&q);
    j = make_job(5);
    CHECK(queue_try_push(&q, &j) == -1);        /* closed: no new work */
    CHECK(queue_push(&q, &j) == -1);
    CHECK(queue_pop(&q, &j) == 1 && j.fd == 4); /* ...but queued work drains */
    CHECK(queue_pop(&q, &j) == 0);
    queue_destroy(&q);
}

#define PRODUCERS 4
#define CONSUMERS 4
#define PER_PRODUCER 20000

typedef struct {
    queue_t           *q;
    int                base;
    unsigned long long sum;
    long               count;
} qt_arg_t;

static void *producer(void *p)
{
    qt_arg_t *a = (qt_arg_t *)p;
    int i;
    for (i = 1; i <= PER_PRODUCER; i++) {
        job_t j = make_job(a->base + i);
        if (queue_push(a->q, &j) != 1)
            break; /* blocking push exercises the not_full condition */
    }
    return NULL;
}

static void *consumer(void *p)
{
    qt_arg_t *a = (qt_arg_t *)p;
    job_t j;
    while (queue_pop(a->q, &j) == 1) {
        a->sum += (unsigned long long)j.fd;
        a->count++;
    }
    return NULL;
}

static void test_queue_threads(void)
{
    queue_t q;
    pthread_t pt[PRODUCERS], ct[CONSUMERS];
    qt_arg_t pa[PRODUCERS], ca[CONSUMERS];
    unsigned long long expect = 0, got = 0;
    long count = 0;
    int i, ok = 1;

    CHECK(queue_init(&q, 8) == 0); /* tiny capacity forces lots of waiting */
    for (i = 0; i < CONSUMERS; i++) {
        memset(&ca[i], 0, sizeof ca[i]);
        ca[i].q = &q;
        ok &= pthread_create(&ct[i], NULL, consumer, &ca[i]) == 0;
    }
    for (i = 0; i < PRODUCERS; i++) {
        memset(&pa[i], 0, sizeof pa[i]);
        pa[i].q = &q;
        pa[i].base = i * PER_PRODUCER;
        ok &= pthread_create(&pt[i], NULL, producer, &pa[i]) == 0;
    }
    CHECK(ok);
    if (!ok)
        return; /* cannot join threads that were not created reliably */
    for (i = 0; i < PRODUCERS; i++)
        pthread_join(pt[i], NULL);
    queue_close(&q);
    for (i = 0; i < CONSUMERS; i++) {
        pthread_join(ct[i], NULL);
        got += ca[i].sum;
        count += ca[i].count;
    }
    /* every value 1..P*N exactly once: sum = n(n+1)/2 */
    expect = (unsigned long long)PRODUCERS * PER_PRODUCER;
    expect = expect * (expect + 1) / 2;
    CHECK(count == (long)PRODUCERS * PER_PRODUCER);
    CHECK(got == expect);
    queue_destroy(&q);
}

/* ------------------------------------------------------------------ */

int main(void)
{
    struct {
        const char *name;
        void (*fn)(void);
    } tests[] = {
        {"find_header_end", test_find_header_end},
        {"parse_valid", test_parse_valid},
        {"parse_keepalive", test_parse_keepalive},
        {"parse_errors", test_parse_errors},
        {"percent_decode", test_percent_decode},
        {"sanitize_path", test_sanitize},
        {"mime", test_mime},
        {"dates", test_dates},
        {"queue_basic", test_queue_basic},
        {"queue_threads", test_queue_threads},
    };
    size_t i, n = sizeof tests / sizeof tests[0];

    for (i = 0; i < n; i++) {
        int before = g_failures;
        tests[i].fn();
        /* cppcheck cannot see that fn() updates g_failures through the pointer. */
        /* cppcheck-suppress knownConditionTrueFalse */
        printf("%-18s %s\n", tests[i].name, g_failures == before ? "ok" : "FAILED");
    }
    printf("\n%d checks in %zu groups, %d failed\n", g_checks, n, g_failures);
    return g_failures == 0 ? 0 : 1;
}
