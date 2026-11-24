/*
 * fileserve.c - static file handler and request-path sanitiser.
 *
 * Security model: the decoded path is split into segments and every segment
 * is checked against an allow-list style set of rules *before* it is joined
 * to the document root. Nothing is ever resolved with "..", so there is no
 * way to climb out of the root, regardless of how the dots were encoded.
 */
#include "fileserve.h"
#include "mime.h"
#include "platform.h"
#include "response.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

/* ASCII case-insensitive comparison of a segment prefix with a word. */
static int word_eq(const char *s, size_t n, const char *word)
{
    size_t i;
    if (strlen(word) != n)
        return 0;
    for (i = 0; i < n; i++) {
        char c = s[i];
        if (c >= 'a' && c <= 'z')
            c = (char)(c - 32);
        if (c != word[i])
            return 0;
    }
    return 1;
}

/*
 * Windows maps these names to devices in *every* directory, with any
 * extension: "/docs/con.txt" would open the console, "/nul" the null device.
 * We refuse them on all platforms so behaviour is identical everywhere.
 */
static int is_device_name(const char *seg, size_t n)
{
    static const char *const names[] = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"};
    size_t base = 0, i;
    while (base < n && seg[base] != '.')
        base++; /* "con.txt" -> "con" */
    for (i = 0; i < sizeof names / sizeof names[0]; i++)
        if (word_eq(seg, base, names[i]))
            return 1;
    if (base == 4 && seg[3] >= '0' && seg[3] <= '9' &&
        (word_eq(seg, 3, "COM") || word_eq(seg, 3, "LPT")))
        return 1;
    return 0;
}

/* Is one path segment (no '/') safe to use as a file or directory name? */
static int segment_ok(const char *seg, size_t n)
{
    size_t i;
    if (seg[0] == '.')
        return 0; /* "..", and hidden files such as .git or .env */
    if (seg[n - 1] == '.' || seg[n - 1] == ' ')
        return 0; /* Windows silently strips these: "index.html." == "index.html" */
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)seg[i];
        if (c < 0x20 || c == 0x7f)
            return 0; /* control characters */
        if (strchr("\\:*?\"<>|", c) != NULL)
            return 0; /* '\' is a separator on Windows; ':' = drives/streams; wildcards */
    }
    return !is_device_name(seg, n);
}

int fs_sanitize_path(const char *decoded, char *out, size_t outsz, int *trailing_slash)
{
    const char *p = decoded;
    size_t o = 0;

    if (outsz < 2)
        return 414;
    if (decoded[0] != '/')
        return 400;
    *trailing_slash = decoded[strlen(decoded) - 1] == '/';

    while (*p) {
        const char *seg;
        size_t n;
        while (*p == '/')
            p++; /* collapse "//" */
        seg = p;
        while (*p && *p != '/')
            p++;
        n = (size_t)(p - seg);
        if (n == 0 || (n == 1 && seg[0] == '.'))
            continue; /* empty segment or "/./" */
        if (!segment_ok(seg, n))
            return 403;
        if (o + 1 + n + 1 > outsz)
            return 414;
        out[o++] = '/';
        memcpy(out + o, seg, n);
        o += n;
    }
    if (o == 0)
        out[o++] = '/'; /* the root itself */
    out[o] = '\0';
    return 0;
}

static int send_error(sock_t fd, int status, int keep_alive, int head_only,
                      unsigned long long *body_sent, int *io_err)
{
    if (resp_send_error(fd, status, keep_alive, head_only, NULL, body_sent) != 0)
        *io_err = 1;
    return status;
}

/* "/docs" is a directory: send the client to "/docs/" so relative links work. */
static int send_redirect(sock_t fd, const http_request_t *req, int keep_alive, int head_only,
                         unsigned long long *body_sent, int *io_err)
{
    static const char body[] = "301 Moved Permanently\n";
    char extra[HTTP_MAX_URI * 2 + 32];
    resp_head_t h;
    int n = snprintf(extra, sizeof extra, "Location: %.*s/%s%s\r\n", (int)req->path_len,
                     req->path, req->query != NULL ? "?" : "",
                     req->query != NULL ? req->query : "");
    if (n < 0 || (size_t)n >= sizeof extra)
        return send_error(fd, 414, keep_alive, head_only, body_sent, io_err);
    memset(&h, 0, sizeof h);
    h.status = 301;
    h.content_type = "text/plain; charset=utf-8";
    h.content_length = sizeof body - 1;
    h.keep_alive = keep_alive;
    h.extra = extra; /* the path only contains validated visible ASCII: no header injection */
    if (resp_send_simple(fd, &h, body, sizeof body - 1, head_only, body_sent) != 0)
        *io_err = 1;
    return 301;
}

int fs_serve(sock_t fd, const char *docroot, const http_request_t *req, int keep_alive,
             char *buf, size_t bufcap, unsigned long long *body_sent, int *io_err)
{
    char decoded[HTTP_MAX_URI + 1], canon[HTTP_MAX_URI + 1], full[FS_MAX_PATH];
    int head_only = req->method == HTTP_HEAD, trailing = 0, rc, n;
    plat_fileinfo_t fi;
    resp_head_t h;
    FILE *fp;
    unsigned long long remaining;
    size_t used;

    *body_sent = 0;
    *io_err = 0;

    /* 1. decode, 2. sanitise, 3. join to the root. Order matters: checking
     *    before decoding would let "%2e%2e" slip through as "..". */
    if (http_percent_decode(req->path, req->path_len, decoded, sizeof decoded) < 0)
        return send_error(fd, 400, keep_alive, head_only, body_sent, io_err);
    rc = fs_sanitize_path(decoded, canon, sizeof canon, &trailing);
    if (rc != 0)
        return send_error(fd, rc, keep_alive, head_only, body_sent, io_err);
    /* The root maps to docroot itself: no trailing slash (Windows _stat
     * rejects "dir/"). */
    n = snprintf(full, sizeof full, "%s%s", docroot, strcmp(canon, "/") == 0 ? "" : canon);
    if (n < 0 || (size_t)n >= sizeof full)
        return send_error(fd, 414, keep_alive, head_only, body_sent, io_err);

    rc = plat_stat(full, &fi);
    if (rc != PLAT_OK)
        return send_error(fd, rc == PLAT_EACCES ? 403 : 404, keep_alive, head_only, body_sent,
                          io_err);
    if (fi.is_dir) {
        if (!trailing)
            return send_redirect(fd, req, keep_alive, head_only, body_sent, io_err);
        if ((size_t)n + sizeof "/index.html" > sizeof full)
            return send_error(fd, 414, keep_alive, head_only, body_sent, io_err);
        memcpy(full + n, "/index.html", sizeof "/index.html");
        rc = plat_stat(full, &fi);
        if (rc != PLAT_OK) /* no directory listings */
            return send_error(fd, rc == PLAT_EACCES ? 403 : 404, keep_alive, head_only,
                              body_sent, io_err);
    }
    if (!fi.is_regular)
        return send_error(fd, 404, keep_alive, head_only, body_sent, io_err);

    /* Conditional GET: unchanged since the client's copy -> 304, no body. */
    if (req->if_modified_since != NULL) {
        time_t since;
        if (http_parse_date(req->if_modified_since, &since) == 0 && fi.mtime <= since) {
            memset(&h, 0, sizeof h);
            h.status = 304;
            h.no_length = 1;
            h.last_modified = fi.mtime;
            h.keep_alive = keep_alive;
            if (resp_send_simple(fd, &h, NULL, 0, 1, body_sent) != 0)
                *io_err = 1;
            return 304;
        }
    }

    errno = 0;
    fp = fopen(full, "rb");
    if (fp == NULL)
        return send_error(fd, errno == EACCES ? 403 : 404, keep_alive, head_only, body_sent,
                          io_err);

    memset(&h, 0, sizeof h);
    h.status = 200;
    h.content_type = mime_type_for(full);
    h.content_length = fi.size;
    h.last_modified = fi.mtime;
    h.keep_alive = keep_alive;
    n = resp_format_head(buf, bufcap, &h);
    if (n < 0) {
        fclose(fp);
        return send_error(fd, 500, 0, head_only, body_sent, io_err);
    }

    /* Stream the file: the first chunk shares the buffer with the head, so
     * small files go out in a single send(). Memory use is O(bufcap), not
     * O(file size). */
    used = (size_t)n;
    remaining = head_only ? 0 : fi.size;
    for (;;) {
        size_t want = bufcap - used, got = 0;
        if (want > remaining)
            want = (size_t)remaining;
        if (want > 0)
            got = fread(buf + used, 1, want, fp);
        used += got;
        remaining -= got;
        if (used > 0 && net_send_all(fd, buf, used) != 0) {
            *io_err = 1;
            break;
        }
        *body_sent += got;
        used = 0;
        if (remaining == 0)
            break;
        if (got < want) {
            /* The file shrank or a read failed after we promised
             * Content-Length bytes: the only honest option is to drop the
             * connection so the client sees a truncated response. */
            *io_err = 1;
            break;
        }
    }
    fclose(fp);
    return 200;
}
