/*
 * mime.c - extension -> Content-Type table.
 */
#include "mime.h"
#include "http.h"

#include <stddef.h>
#include <string.h>

typedef struct {
    const char *ext;
    const char *type;
} mime_entry_t;

/* A linear scan over ~35 entries is cheaper than hashing at this size. */
static const mime_entry_t k_mime[] = {
    {"html", "text/html; charset=utf-8"},
    {"htm", "text/html; charset=utf-8"},
    {"css", "text/css; charset=utf-8"},
    {"js", "text/javascript; charset=utf-8"},
    {"mjs", "text/javascript; charset=utf-8"},
    {"json", "application/json"},
    {"map", "application/json"},
    {"txt", "text/plain; charset=utf-8"},
    {"md", "text/markdown; charset=utf-8"},
    {"csv", "text/csv; charset=utf-8"},
    {"xml", "application/xml"},
    {"svg", "image/svg+xml"},
    {"png", "image/png"},
    {"jpg", "image/jpeg"},
    {"jpeg", "image/jpeg"},
    {"gif", "image/gif"},
    {"webp", "image/webp"},
    {"avif", "image/avif"},
    {"ico", "image/x-icon"},
    {"woff", "font/woff"},
    {"woff2", "font/woff2"},
    {"ttf", "font/ttf"},
    {"otf", "font/otf"},
    {"pdf", "application/pdf"},
    {"wasm", "application/wasm"},
    {"zip", "application/zip"},
    {"gz", "application/gzip"},
    {"tar", "application/x-tar"},
    {"mp3", "audio/mpeg"},
    {"wav", "audio/wav"},
    {"ogg", "audio/ogg"},
    {"mp4", "video/mp4"},
    {"webm", "video/webm"},
};

const char *mime_type_for(const char *path)
{
    const char *slash = strrchr(path, '/');
    const char *base = slash != NULL ? slash + 1 : path;
    const char *dot = strrchr(base, '.');
    size_t i;

    if (dot == NULL || dot == base || dot[1] == '\0')
        return "application/octet-stream"; /* no extension, or a dotfile */
    for (i = 0; i < sizeof k_mime / sizeof k_mime[0]; i++)
        if (http_strcaseeq(dot + 1, k_mime[i].ext))
            return k_mime[i].type;
    return "application/octet-stream";
}
