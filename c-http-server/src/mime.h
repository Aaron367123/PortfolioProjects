/*
 * mime.h - Content-Type lookup by file extension.
 */
#ifndef TINYHTTPD_MIME_H
#define TINYHTTPD_MIME_H

/* Returns a static string such as "text/html; charset=utf-8".
 * Unknown or missing extensions map to "application/octet-stream". */
const char *mime_type_for(const char *path);

#endif /* TINYHTTPD_MIME_H */
