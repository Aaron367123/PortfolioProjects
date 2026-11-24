/*
 * net.h - thin socket portability layer (Winsock2 on Windows, BSD sockets
 * elsewhere).
 *
 * Together with platform.h this is the only part of the code base that knows
 * which operating system it is running on: every `#ifdef _WIN32` lives in
 * net.c or platform.c. The rest of the program sees an integer `sock_t` and a
 * handful of small functions that behave the same on every platform.
 */
#ifndef TINYHTTPD_NET_H
#define TINYHTTPD_NET_H

#include <stddef.h>
#include <stdint.h>

/*
 * A socket handle. Windows uses an unsigned pointer-sized SOCKET, POSIX uses
 * an int file descriptor; intptr_t can hold both, and INVALID_SOCKET (~0)
 * and -1 both map to the value -1.
 */
typedef intptr_t sock_t;
#define SOCK_INVALID ((sock_t)-1)

/* Size of a buffer able to hold any numeric IPv4/IPv6 address string. */
#define NET_ADDRSTR_LEN 64

/* Start/stop the socket library (WSAStartup on Windows, SIGPIPE off on POSIX). */
int  net_init(void);
void net_cleanup(void);

/* Last socket error code (WSAGetLastError() or errno) and helpers. */
int         net_last_error(void);
const char *net_strerror(int err, char *buf, size_t len);

/*
 * Create a listening TCP socket bound to addr:port. Port 0 asks the OS for a
 * free port; the port actually bound is written to *bound_port.
 */
sock_t net_listen(const char *addr, int port, int backlog, int *bound_port);

/* Accept one connection; the peer's numeric address is written to `peer`. */
sock_t net_accept(sock_t listener, char *peer, size_t peer_len);

/* Connect to host:port (tries every address getaddrinfo returns). */
sock_t net_connect(const char *host, int port);

/* Wait up to timeout_ms for the socket to become readable.
 * Returns 1 = readable (or EOF/error pending), 0 = timeout, -1 = error. */
int net_wait_readable(sock_t s, int timeout_ms);

/* recv() that retries on EINTR. Returns bytes read, 0 on orderly EOF,
 * -1 on error (inspect net_last_error()). */
long net_recv(sock_t s, void *buf, size_t len);

/* Send the whole buffer (loops over partial writes). 0 = ok, -1 = error. */
int net_send_all(sock_t s, const void *buf, size_t len);

/* Per-socket receive/send timeouts in milliseconds (0 = no timeout). */
int net_set_timeouts(sock_t s, int recv_ms, int send_ms);

/* Disable Nagle's algorithm so small responses are not delayed. */
int net_set_nodelay(sock_t s);

void net_close(sock_t s);

/*
 * "Lingering close": half-close our side, then read and discard whatever the
 * peer still sends for at most max_ms. Closing a socket that still has unread
 * input makes the kernel send RST, which can destroy the error response we
 * just wrote before the client reads it (e.g. after a 431 for huge headers).
 */
void net_graceful_close(sock_t s, int max_ms);

#endif /* TINYHTTPD_NET_H */
