/*
 * platform.h - non-socket OS differences: monotonic clock, UTC time
 * conversion, file metadata, Ctrl-C handling, sleeping.
 *
 * Like net.h, this keeps every `#ifdef _WIN32` inside platform.c.
 */
#ifndef TINYHTTPD_PLATFORM_H
#define TINYHTTPD_PLATFORM_H

#include <stdint.h>
#include <time.h>

/* Monotonic high-resolution clock in nanoseconds (QueryPerformanceCounter on
 * Windows, clock_gettime(CLOCK_MONOTONIC) elsewhere). Only differences between
 * two readings are meaningful. */
uint64_t plat_now_ns(void);

/* Thread-safe gmtime (gmtime_s / gmtime_r). Returns 0 on success. */
int plat_gmtime(time_t t, struct tm *out);

/* Result categories for plat_stat(). */
enum { PLAT_OK = 0, PLAT_ENOENT = -1, PLAT_EACCES = -2, PLAT_EOTHER = -3 };

typedef struct {
    int      is_dir;
    int      is_regular;
    uint64_t size;   /* 64-bit even on Windows (uses _stat64) */
    time_t   mtime;  /* last modification, seconds since the Unix epoch */
} plat_fileinfo_t;

/* stat() a path. Returns PLAT_OK or one of the negative PLAT_E* codes. */
int plat_stat(const char *path, plat_fileinfo_t *info);

/*
 * Call `on_stop` when the user asks the process to stop: SIGINT/SIGTERM on
 * POSIX (via sigaction, so it runs in signal context) and Ctrl-C / Ctrl-Break
 * / console close on Windows (SetConsoleCtrlHandler, runs on its own thread).
 * The callback must therefore only do async-signal-safe work such as storing
 * to a lock-free atomic flag. Returns 0 on success.
 */
int plat_install_stop_handler(void (*on_stop)(void));

void plat_sleep_ms(int ms);

#endif /* TINYHTTPD_PLATFORM_H */
