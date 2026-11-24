/*
 * http.c - HTTP/1.x request parser (RFC 9112 subset) and helpers.
 *
 * The parser is a single forward pass over a buffer that already contains a
 * complete header block. It validates as it goes and returns the status code
 * the server should answer with on the first problem it finds, so the caller
 * never has to guess why a request was rejected.
 */
#include "http.h"
#include "platform.h"

#include <stdio.h>
#include <string.h>

/* ---- character classes (ASCII only; <ctype.h> is locale dependent) ---- */

static int is_digit(unsigned char c) { return c >= '0' && c <= '9'; }
static int is_alpha(unsigned char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
static int is_ows(unsigned char c) { return c == ' ' || c == '\t'; }
static unsigned char lower(unsigned char c) { return (c >= 'A' && c <= 'Z') ? (unsigned char)(c + 32) : c; }

/* RFC 9110 "tchar": the characters allowed in methods and header names. */
static int is_tchar(unsigned char c)
{
    return is_digit(c) || is_alpha(c) || (c != 0 && strchr("!#$%&'*+-.^_`|~", c) != NULL);
}

/* Visible ASCII, excluding space: allowed in a request-target. */
static int is_vchar(unsigned char c) { return c > 0x20 && c < 0x7f; }

int http_strcaseeq(const char *a, const char *b)
{
    while (*a && *b) {
        if (lower((unsigned char)*a) != lower((unsigned char)*b))
            return 0;
        a++;
        b++;
    }
    return *a == *b;
}

static int strncaseeq(const char *a, const char *b, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        if (lower((unsigned char)a[i]) != lower((unsigned char)b[i]))
            return 0;
        if (a[i] == '\0')
            return 1;
    }
    return 1;
}

/* ---- framing ---- */

long http_find_header_end(const char *buf, size_t len)
{
    size_t i;
    for (i = 0; i < len; i++) {
        if (buf[i] != '\n')
            continue;
        if (i + 1 < len && buf[i + 1] == '\n')
            return (long)(i + 2);
        if (i + 2 < len && buf[i + 1] == '\r' && buf[i + 2] == '\n')
            return (long)(i + 3);
    }
    return -1;
}

/* Consume a line ending (CRLF or bare LF) at *i. Returns 0 on success. */
static int eat_eol(const char *buf, size_t len, size_t *i)
{
    if (*i < len && buf[*i] == '\r')
        (*i)++;
    if (*i >= len || buf[*i] != '\n')
        return -1;
    (*i)++;
    return 0;
}

/* Does a comma-separated header value contain `token` (case-insensitive)? */
static int has_token(const char *value, const char *token)
{
    size_t tlen = strlen(token);
    const char *p = value;
    while (*p) {
        const char *start, *end;
        while (*p == ',' || is_ows((unsigned char)*p))
            p++;
        start = p;
        while (*p && *p != ',')
            p++;
        end = p;
        while (end > start && is_ows((unsigned char)end[-1]))
            end--;
        if ((size_t)(end - start) == tlen && strncaseeq(start, token, tlen))
            return 1;
    }
    return 0;
}

/* Split the target into path and query; handles origin- and absolute-form. */
static int split_target(http_request_t *req)
{
    const char *t = req->target;
    const char *q;

    if (t[0] != '/') {
        /* absolute-form ("http://host/path") must be accepted by servers. */
        const char *slash;
        if (!strncaseeq(t, "http://", 7))
            return -1;
        slash = strchr(t + 7, '/');
        if (slash == NULL) {
            req->path = "/";
            req->path_len = 1;
            req->query = NULL;
            return 0;
        }
        t = slash;
    }
    q = strchr(t, '?');
    req->path = t;
    req->path_len = q != NULL ? (size_t)(q - t) : strlen(t);
    req->query = q != NULL ? q + 1 : NULL;
    return 0;
}

int http_parse_request(char *buf, size_t len, http_request_t *req)
{
    size_t i = 0, start, target_len, h;
    int major, has_body = 0;
    const char *content_length = NULL, *method, *target;

    memset(req, 0, sizeof *req);
    req->method = HTTP_OTHER;

    /* ---- request-line: method SP request-target SP HTTP-version EOL ---- */
    start = i;
    while (i < len && is_tchar((unsigned char)buf[i]))
        i++;
    if (i == start || i >= len || buf[i] != ' ')
        return 400;
    buf[i++] = '\0';
    method = buf + start;

    start = i;
    while (i < len && is_vchar((unsigned char)buf[i]))
        i++;
    if (i == start || i >= len || buf[i] != ' ')
        return 400;
    target_len = i - start;
    buf[i++] = '\0';
    target = buf + start;

    if (len - i < 8 || memcmp(buf + i, "HTTP/", 5) != 0 ||
        !is_digit((unsigned char)buf[i + 5]) || buf[i + 6] != '.' ||
        !is_digit((unsigned char)buf[i + 7]))
        return 400;
    major = buf[i + 5] - '0';
    req->version_minor = buf[i + 7] - '0' >= 1 ? 1 : 0; /* 1.2+ is treated as 1.1 */
    i += 8;
    if (eat_eol(buf, len, &i) != 0)
        return 400;
    if (major != 1)
        return 505;
    /* The request line is well-formed: expose it (the access log uses it
     * even when a later check rejects the request). */
    req->method_str = method;
    req->target = target;
    if (target_len > HTTP_MAX_URI)
        return 414;

    /* ---- header fields: name ":" OWS value OWS EOL, until a blank line ---- */
    for (;;) {
        size_t vstart, vend;
        if (i >= len)
            return 400;
        if (buf[i] == '\r' || buf[i] == '\n') {
            if (eat_eol(buf, len, &i) != 0)
                return 400;
            break; /* blank line: end of headers */
        }
        if (is_ows((unsigned char)buf[i]))
            return 400; /* obsolete line folding is not allowed (RFC 9112 5.2) */

        start = i;
        while (i < len && is_tchar((unsigned char)buf[i]))
            i++;
        /* No whitespace between name and colon: that enables request smuggling. */
        if (i == start || i >= len || buf[i] != ':')
            return 400;
        buf[i++] = '\0';

        while (i < len && is_ows((unsigned char)buf[i]))
            i++;
        vstart = i;
        while (i < len && buf[i] != '\r' && buf[i] != '\n') {
            unsigned char c = (unsigned char)buf[i];
            if ((c < 0x20 && c != '\t') || c == 0x7f)
                return 400; /* control characters (incl. NUL) */
            i++;
        }
        vend = i;
        while (vend > vstart && is_ows((unsigned char)buf[vend - 1]))
            vend--;
        if (eat_eol(buf, len, &i) != 0)
            return 400; /* bare CR */
        buf[vend] = '\0';

        if (req->header_count == HTTP_MAX_HEADERS)
            return 431;
        req->headers[req->header_count].name = buf + start;
        req->headers[req->header_count].value = buf + vstart;
        req->header_count++;
    }

    /* ---- semantic checks on the headers we care about ---- */
    for (h = 0; h < req->header_count; h++) {
        const char *name = req->headers[h].name, *value = req->headers[h].value;
        if (http_strcaseeq(name, "Host")) {
            if (req->host != NULL)
                return 400; /* duplicate Host */
            req->host = value;
        } else if (http_strcaseeq(name, "Content-Length")) {
            const char *p = value;
            if (content_length != NULL || *p == '\0')
                return 400;
            for (; *p; p++)
                if (!is_digit((unsigned char)*p))
                    return 400;
            content_length = value;
            if (strspn(value, "0") != strlen(value))
                has_body = 1;
        } else if (http_strcaseeq(name, "Transfer-Encoding")) {
            has_body = 1;
        } else if (http_strcaseeq(name, "If-Modified-Since")) {
            req->if_modified_since = value;
        }
    }
    if (req->version_minor == 1 && req->host == NULL)
        return 400; /* Host is mandatory in HTTP/1.1 */

    if (strcmp(req->method_str, "GET") == 0)
        req->method = HTTP_GET;
    else if (strcmp(req->method_str, "HEAD") == 0)
        req->method = HTTP_HEAD;
    else
        return 405;

    if (split_target(req) != 0)
        return 400;
    if (has_body)
        return 400; /* GET/HEAD with a body: not supported, and unread bytes would desync us */

    /* Persistence: default on for 1.1, opt-in for 1.0. */
    req->keep_alive = req->version_minor == 1;
    for (h = 0; h < req->header_count; h++) {
        if (!http_strcaseeq(req->headers[h].name, "Connection"))
            continue;
        if (has_token(req->headers[h].value, "close"))
            req->keep_alive = 0;
        else if (has_token(req->headers[h].value, "keep-alive"))
            req->keep_alive = 1;
    }
    return 0;
}

const char *http_get_header(const http_request_t *req, const char *name)
{
    size_t i;
    for (i = 0; i < req->header_count; i++)
        if (http_strcaseeq(req->headers[i].name, name))
            return req->headers[i].value;
    return NULL;
}

/* ---- percent-decoding ---- */

static int hexval(unsigned char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    c = lower(c);
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    return -1;
}

long http_percent_decode(const char *in, size_t inlen, char *out, size_t outsz)
{
    size_t i, o = 0;
    if (outsz == 0)
        return -1;
    for (i = 0; i < inlen; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '%') {
            int hi, lo;
            if (i + 2 >= inlen)
                return -1; /* truncated escape like "%4" */
            hi = hexval((unsigned char)in[i + 1]);
            lo = hexval((unsigned char)in[i + 2]);
            if (hi < 0 || lo < 0)
                return -1;
            c = (unsigned char)(hi * 16 + lo);
            if (c == 0)
                return -1; /* %00 would truncate C strings: classic bypass trick */
            i += 2;
        } else if (c == 0) {
            return -1;
        }
        if (o + 1 >= outsz)
            return -1;
        out[o++] = (char)c;
    }
    out[o] = '\0';
    return (long)o;
}

/* ---- status codes ---- */

const char *http_reason(int status)
{
    switch (status) {
    case 200: return "OK";
    case 301: return "Moved Permanently";
    case 304: return "Not Modified";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 413: return "Content Too Large";
    case 414: return "URI Too Long";
    case 431: return "Request Header Fields Too Large";
    case 500: return "Internal Server Error";
    case 503: return "Service Unavailable";
    case 505: return "HTTP Version Not Supported";
    default:  return "Unknown";
    }
}

/* ---- dates (IMF-fixdate, RFC 9110 5.6.7) ---- */

static const char *const k_days[7] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
static const char *const k_months[12] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};

int http_format_date(time_t t, char out[HTTP_DATE_LEN])
{
    struct tm tm;
    if (plat_gmtime(t, &tm) != 0 || tm.tm_wday < 0 || tm.tm_wday > 6 || tm.tm_mon < 0 ||
        tm.tm_mon > 11) {
        out[0] = '\0';
        return -1;
    }
    /* Formatted by hand: strftime's %a/%b depend on the current locale. */
    snprintf(out, HTTP_DATE_LEN, "%s, %02d %s %04d %02d:%02d:%02d GMT", k_days[tm.tm_wday],
             tm.tm_mday, k_months[tm.tm_mon], tm.tm_year + 1900, tm.tm_hour, tm.tm_min,
             tm.tm_sec);
    return 0;
}

/* Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's algorithm).
 * Used instead of timegm(), which is non-standard and missing on Windows. */
static long long days_from_civil(int y, int m, int d)
{
    long long era;
    int yoe, doy, doe;
    y -= m <= 2;
    era = (y >= 0 ? y : y - 399) / 400;
    yoe = (int)(y - era * 400);
    doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static int parse_num(const char *s, int digits, int *out)
{
    int i, v = 0;
    for (i = 0; i < digits; i++) {
        if (!is_digit((unsigned char)s[i]))
            return -1;
        v = v * 10 + (s[i] - '0');
    }
    *out = v;
    return 0;
}

int http_parse_date(const char *s, time_t *out)
{
    /* "Sun, 06 Nov 1994 08:49:37 GMT" - fixed 29-character layout. */
    int day, year, hh, mm, ss, mon = -1, i;
    if (strlen(s) != 29 || s[3] != ',' || s[4] != ' ' || s[7] != ' ' || s[11] != ' ' ||
        s[16] != ' ' || s[19] != ':' || s[22] != ':' || strcmp(s + 25, " GMT") != 0)
        return -1;
    for (i = 0; i < 12; i++)
        if (memcmp(s + 8, k_months[i], 3) == 0)
            mon = i;
    if (mon < 0 || parse_num(s + 5, 2, &day) || parse_num(s + 12, 4, &year) ||
        parse_num(s + 17, 2, &hh) || parse_num(s + 20, 2, &mm) || parse_num(s + 23, 2, &ss))
        return -1;
    if (day < 1 || day > 31 || hh > 23 || mm > 59 || ss > 60 || year < 1970)
        return -1;
    *out = (time_t)(days_from_civil(year, mon + 1, day) * 86400LL + hh * 3600LL + mm * 60LL + ss);
    return 0;
}
