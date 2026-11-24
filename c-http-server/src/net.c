/*
 * net.c - socket portability layer. See net.h.
 *
 * Differences papered over here:
 *   - library init:   WSAStartup()/WSACleanup()     vs  nothing (ignore SIGPIPE)
 *   - closing:        closesocket()                 vs  close()
 *   - error codes:    WSAGetLastError()/WSAE*       vs  errno/E*
 *   - timeouts:       DWORD milliseconds            vs  struct timeval
 *   - address reuse:  SO_EXCLUSIVEADDRUSE           vs  SO_REUSEADDR
 *   - waiting:        select() (no fd limit on Win) vs  poll() (no FD_SETSIZE limit)
 *   - send flags:     0                             vs  MSG_NOSIGNAL where available
 */
#ifdef _WIN32
#  ifndef _WIN32_WINNT
#    define _WIN32_WINNT 0x0601 /* Windows 7+: getaddrinfo, inet_ntop */
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
#  include <ws2tcpip.h>
typedef SOCKET native_sock;
typedef int    io_len;   /* Winsock lengths are int */
#  define SHUT_WR_FLAG SD_SEND
#else
#  include <errno.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <netinet/tcp.h>
#  include <poll.h>
#  include <signal.h>
#  include <sys/socket.h>
#  include <sys/time.h>
#  include <unistd.h>
typedef int    native_sock;
typedef size_t io_len;
#  define SHUT_WR_FLAG SHUT_WR
#endif

#include "net.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

#ifndef MSG_NOSIGNAL
#  define MSG_NOSIGNAL 0 /* Windows/macOS: SIGPIPE is handled elsewhere */
#endif

/* Convert between the portable handle and the native one. */
static native_sock to_native(sock_t s) { return (native_sock)s; }
static sock_t from_native(native_sock s)
{
#ifdef _WIN32
    return s == INVALID_SOCKET ? SOCK_INVALID : (sock_t)s;
#else
    return s < 0 ? SOCK_INVALID : (sock_t)s;
#endif
}

int net_init(void)
{
#ifdef _WIN32
    WSADATA wsa;
    return WSAStartup(MAKEWORD(2, 2), &wsa) == 0 ? 0 : -1;
#else
    /* Writing to a socket the peer has closed must return EPIPE, not kill us. */
    return signal(SIGPIPE, SIG_IGN) == SIG_ERR ? -1 : 0;
#endif
}

void net_cleanup(void)
{
#ifdef _WIN32
    WSACleanup();
#endif
}

int net_last_error(void)
{
#ifdef _WIN32
    return WSAGetLastError();
#else
    return errno;
#endif
}

const char *net_strerror(int err, char *buf, size_t len)
{
    if (len == 0)
        return buf;
#ifdef _WIN32
    DWORD n = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                             NULL, (DWORD)err, 0, buf, (DWORD)len, NULL);
    if (n == 0) {
        snprintf(buf, len, "socket error %d", err);
    } else {
        /* FormatMessage ends the text with "\r\n"; trim it. */
        while (n > 0 && (buf[n - 1] == '\r' || buf[n - 1] == '\n' || buf[n - 1] == ' '))
            buf[--n] = '\0';
    }
#else
    if (strerror_r(err, buf, len) != 0)
        snprintf(buf, len, "error %d", err);
#endif
    return buf;
}

static int set_reuse(native_sock s)
{
    int one = 1;
#ifdef _WIN32
    /* On Windows SO_REUSEADDR lets *another* process steal the port;
     * SO_EXCLUSIVEADDRUSE is the safe equivalent of the POSIX behaviour. */
    return setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&one, sizeof one);
#else
    /* Allow restarting the server while old connections sit in TIME_WAIT. */
    return setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
#endif
}

static int port_of(const struct sockaddr_storage *ss)
{
    if (ss->ss_family == AF_INET)
        return ntohs(((const struct sockaddr_in *)(const void *)ss)->sin_port);
    if (ss->ss_family == AF_INET6)
        return ntohs(((const struct sockaddr_in6 *)(const void *)ss)->sin6_port);
    return -1;
}

sock_t net_listen(const char *addr, int port, int backlog, int *bound_port)
{
    char portstr[16];
    struct addrinfo hints, *res = NULL, *ai;
    sock_t result = SOCK_INVALID;

    snprintf(portstr, sizeof portstr, "%d", port);
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_flags = AI_PASSIVE;
    if (getaddrinfo(addr, portstr, &hints, &res) != 0)
        return SOCK_INVALID;

    for (ai = res; ai != NULL; ai = ai->ai_next) {
        native_sock s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (from_native(s) == SOCK_INVALID)
            continue;
        if (set_reuse(s) != 0 || bind(s, ai->ai_addr, (int)ai->ai_addrlen) != 0 ||
            listen(s, backlog) != 0) {
            net_close(from_native(s));
            continue;
        }
        result = from_native(s);
        break;
    }
    freeaddrinfo(res);

    if (result != SOCK_INVALID && bound_port != NULL) {
        struct sockaddr_storage ss;
        socklen_t sl = sizeof ss;
        *bound_port = port;
        if (getsockname(to_native(result), (struct sockaddr *)&ss, &sl) == 0)
            *bound_port = port_of(&ss);
    }
    return result;
}

sock_t net_accept(sock_t listener, char *peer, size_t peer_len)
{
    struct sockaddr_storage ss;
    socklen_t sl = sizeof ss;
    native_sock c = accept(to_native(listener), (struct sockaddr *)&ss, &sl);
    sock_t s = from_native(c);

    if (peer != NULL && peer_len > 0) {
        if (s == SOCK_INVALID ||
            getnameinfo((struct sockaddr *)&ss, sl, peer, (socklen_t)peer_len, NULL, 0,
                        NI_NUMERICHOST) != 0)
            snprintf(peer, peer_len, "-");
    }
    return s;
}

sock_t net_connect(const char *host, int port)
{
    char portstr[16];
    struct addrinfo hints, *res = NULL, *ai;
    sock_t result = SOCK_INVALID;

    snprintf(portstr, sizeof portstr, "%d", port);
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, portstr, &hints, &res) != 0)
        return SOCK_INVALID;

    for (ai = res; ai != NULL; ai = ai->ai_next) {
        native_sock s = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (from_native(s) == SOCK_INVALID)
            continue;
        if (connect(s, ai->ai_addr, (int)ai->ai_addrlen) != 0) {
            net_close(from_native(s));
            continue;
        }
        result = from_native(s);
        break;
    }
    freeaddrinfo(res);
    return result;
}

int net_wait_readable(sock_t s, int timeout_ms)
{
#ifdef _WIN32
    fd_set rd;
    struct timeval tv;
    int r;
    FD_ZERO(&rd);
    FD_SET(to_native(s), &rd);
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    r = select(0, &rd, NULL, NULL, &tv);
    return r > 0 ? 1 : (r == 0 ? 0 : -1);
#else
    struct pollfd p;
    int r;
    p.fd = to_native(s);
    p.events = POLLIN;
    p.revents = 0;
    r = poll(&p, 1, timeout_ms);
    if (r < 0)
        return errno == EINTR ? 0 : -1; /* a signal is just an early timeout */
    return r > 0 ? 1 : 0;
#endif
}

long net_recv(sock_t s, void *buf, size_t len)
{
    if (len > INT_MAX)
        len = INT_MAX;
    for (;;) {
#ifdef _WIN32
        int n = recv(to_native(s), (char *)buf, (io_len)len, 0);
#else
        ssize_t n = recv(to_native(s), buf, (io_len)len, 0);
        if (n < 0 && errno == EINTR)
            continue;
#endif
        return n < 0 ? -1 : (long)n;
    }
}

int net_send_all(sock_t s, const void *buf, size_t len)
{
    const char *p = (const char *)buf;
    while (len > 0) {
        size_t chunk = len > INT_MAX ? INT_MAX : len;
#ifdef _WIN32
        int n = send(to_native(s), p, (io_len)chunk, 0);
#else
        ssize_t n = send(to_native(s), p, (io_len)chunk, MSG_NOSIGNAL);
        if (n < 0 && errno == EINTR)
            continue;
#endif
        if (n <= 0)
            return -1;
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

int net_set_timeouts(sock_t s, int recv_ms, int send_ms)
{
    int rc = 0;
#ifdef _WIN32
    DWORD r = (DWORD)recv_ms, w = (DWORD)send_ms;
    rc |= setsockopt(to_native(s), SOL_SOCKET, SO_RCVTIMEO, (const char *)&r, sizeof r);
    rc |= setsockopt(to_native(s), SOL_SOCKET, SO_SNDTIMEO, (const char *)&w, sizeof w);
#else
    struct timeval r, w;
    r.tv_sec = recv_ms / 1000;
    r.tv_usec = (recv_ms % 1000) * 1000;
    w.tv_sec = send_ms / 1000;
    w.tv_usec = (send_ms % 1000) * 1000;
    rc |= setsockopt(to_native(s), SOL_SOCKET, SO_RCVTIMEO, &r, sizeof r);
    rc |= setsockopt(to_native(s), SOL_SOCKET, SO_SNDTIMEO, &w, sizeof w);
#endif
    return rc == 0 ? 0 : -1;
}

int net_set_nodelay(sock_t s)
{
    int one = 1;
    return setsockopt(to_native(s), IPPROTO_TCP, TCP_NODELAY, (const char *)&one,
                      sizeof one) == 0 ? 0 : -1;
}

void net_close(sock_t s)
{
    if (s == SOCK_INVALID)
        return;
#ifdef _WIN32
    closesocket(to_native(s));
#else
    close(to_native(s));
#endif
}

void net_graceful_close(sock_t s, int max_ms)
{
    char sink[4096];
    int waited = 0;
    long drained = 0;

    if (s == SOCK_INVALID)
        return;
    shutdown(to_native(s), SHUT_WR_FLAG); /* send FIN after our response */
    /* Bounded both in idle time and in bytes, so a peer that keeps
     * streaming cannot pin the worker here. */
    while (waited < max_ms && drained < 1024L * 1024L) {
        long n;
        int r = net_wait_readable(s, 50);
        if (r < 0)
            break;
        if (r == 0) {
            waited += 50;
            continue;
        }
        n = net_recv(s, sink, sizeof sink);
        if (n <= 0)
            break; /* peer closed (or error): safe to close now */
        drained += n;
    }
    net_close(s);
}
