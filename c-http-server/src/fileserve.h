/*
 * fileserve.h - mapping request paths to files under the document root.
 */
#ifndef TINYHTTPD_FILESERVE_H
#define TINYHTTPD_FILESERVE_H

#include "http.h"
#include "net.h"

#include <stddef.h>

#define FS_MAX_PATH 4096

/*
 * Turn a percent-DECODED request path into a canonical, safe relative path:
 * collapses "//" and "/./", and refuses anything that could escape the
 * document root or reach something that is not an ordinary file.
 *
 * Writes e.g. "/docs/index.html" into `out`; *trailing_slash tells whether
 * the original path ended in '/'. Returns 0 on success, or an HTTP status:
 *   400 path does not start with '/', 403 forbidden segment, 414 too long.
 */
int fs_sanitize_path(const char *decoded, char *out, size_t outsz, int *trailing_slash);

/*
 * Serve the file named by req->path from `docroot` (GET or HEAD), including
 * directory index.html, 301 for directories without a trailing slash, 304 for
 * If-Modified-Since, and 403/404 errors. The file is streamed in chunks
 * through `buf` (never loaded whole).
 *
 * Returns the status code sent. *io_err is set when the connection broke
 * mid-response (the caller must close it); *body_sent counts body bytes.
 */
int fs_serve(sock_t fd, const char *docroot, const http_request_t *req, int keep_alive,
             char *buf, size_t bufcap, unsigned long long *body_sent, int *io_err);

#endif /* TINYHTTPD_FILESERVE_H */
