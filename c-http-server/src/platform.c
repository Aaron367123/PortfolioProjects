/*
 * platform.c - clock, time, file metadata and stop-signal portability.
 * See platform.h.
 */
#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#else
#  include <signal.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#endif

#include "platform.h"

#include <errno.h>
#include <string.h>

/* Set once before the handler is installed, only read afterwards. */
static void (*g_on_stop)(void);

uint64_t plat_now_ns(void)
{
#ifdef _WIN32
    LARGE_INTEGER freq, counter;
    uint64_t f, c;
    QueryPerformanceFrequency(&freq); /* cannot fail on XP and later */
    QueryPerformanceCounter(&counter);
    f = (uint64_t)freq.QuadPart;
    c = (uint64_t)counter.QuadPart;
    /* Split the multiplication to avoid overflowing 64 bits. */
    return (c / f) * 1000000000ULL + (c % f) * 1000000000ULL / f;
#else
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0)
        return 0;
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
#endif
}

int plat_gmtime(time_t t, struct tm *out)
{
#ifdef _WIN32
    return gmtime_s(out, &t) == 0 ? 0 : -1;
#else
    return gmtime_r(&t, out) != NULL ? 0 : -1;
#endif
}

static int map_errno(int e)
{
    if (e == ENOENT || e == ENOTDIR || e == ENAMETOOLONG)
        return PLAT_ENOENT;
    if (e == EACCES || e == EPERM)
        return PLAT_EACCES;
    return PLAT_EOTHER;
}

int plat_stat(const char *path, plat_fileinfo_t *info)
{
#ifdef _WIN32
    struct _stat64 st;
    if (_stat64(path, &st) != 0)
        return map_errno(errno);
    info->is_dir = (st.st_mode & _S_IFMT) == _S_IFDIR;
    info->is_regular = (st.st_mode & _S_IFMT) == _S_IFREG;
#else
    struct stat st;
    if (stat(path, &st) != 0)
        return map_errno(errno);
    info->is_dir = S_ISDIR(st.st_mode);
    info->is_regular = S_ISREG(st.st_mode);
#endif
    info->size = (uint64_t)st.st_size;
    info->mtime = (time_t)st.st_mtime;
    return PLAT_OK;
}

#ifdef _WIN32
static BOOL WINAPI console_handler(DWORD type)
{
    switch (type) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
        if (g_on_stop != NULL)
            g_on_stop();
        return TRUE; /* handled: do not run the default ExitProcess */
    default:
        return FALSE;
    }
}
#else
static void signal_handler(int sig)
{
    (void)sig;
    if (g_on_stop != NULL)
        g_on_stop();
}
#endif

int plat_install_stop_handler(void (*on_stop)(void))
{
    g_on_stop = on_stop;
#ifdef _WIN32
    return SetConsoleCtrlHandler(console_handler, TRUE) ? 0 : -1;
#else
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = signal_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0; /* no SA_RESTART: blocking calls return EINTR */
    if (sigaction(SIGINT, &sa, NULL) != 0 || sigaction(SIGTERM, &sa, NULL) != 0)
        return -1;
    return 0;
#endif
}

void plat_sleep_ms(int ms)
{
#ifdef _WIN32
    Sleep((DWORD)ms);
#else
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
    }
#endif
}
