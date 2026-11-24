# tinyhttpd - build with GNU make.
#   Linux/macOS:  make            Windows (MinGW-w64): mingw32-make
#
# Targets: all (default), test, integration, check, debug, test-asan,
#          cppcheck, clean.   Pass WERROR=1 to turn warnings into errors.

ifeq ($(origin CC),default)
  CC := gcc
endif

CSTD     := -std=c11
WARN     := -Wall -Wextra -Wpedantic -Wshadow -Wstrict-prototypes -Wformat=2
OPT      ?= -O2
CPPFLAGS += -Isrc
LDLIBS   :=

ifeq ($(WERROR),1)
  WARN += -Werror
endif

ifeq ($(OS),Windows_NT)
  # MinGW-w64 with POSIX threads (winpthreads). Linked statically so the
  # .exe files run without the MinGW runtime DLLs on PATH.
  SHELL    := cmd.exe
  EXE      := .exe
  LDLIBS   += -lws2_32
  LDFLAGS  += -static
  MKDIR     = if not exist $(subst /,\,$(1)) mkdir $(subst /,\,$(1))
  RMDIR     = if exist $(subst /,\,$(1)) rmdir /s /q $(subst /,\,$(1))
  RUN       = $(subst /,\,$(1))
  PYTHON   ?= python
else
  EXE      :=
  UNAME    := $(shell uname -s)
  # Expose POSIX APIs (getaddrinfo, clock_gettime, sigaction) under -std=c11.
  CPPFLAGS += -D_POSIX_C_SOURCE=200809L
  ifeq ($(UNAME),Darwin)
    CPPFLAGS += -D_DARWIN_C_SOURCE
  endif
  MKDIR     = mkdir -p $(1)
  RMDIR     = rm -rf $(1)
  RUN       = $(1)
  PYTHON   ?= python3
endif

CFLAGS  := $(CSTD) $(WARN) $(OPT) -pthread $(EXTRA_CFLAGS)
LDFLAGS += -pthread

BUILD   := build
COMMON  := src/net.c src/platform.c
CORE    := src/http.c src/mime.c src/queue.c src/fileserve.c src/response.c \
           src/stats.c src/log.c src/conn.c
HEADERS := $(wildcard src/*.h)

SERVER_BIN := $(BUILD)/server$(EXE)
BENCH_BIN  := $(BUILD)/bench$(EXE)
TESTS_BIN  := $(BUILD)/tests$(EXE)

.PHONY: all test integration check debug test-asan cppcheck clean

all: $(SERVER_BIN) $(BENCH_BIN) $(TESTS_BIN)

# The project is small, so each binary is compiled straight from its sources.
$(SERVER_BIN): src/server.c $(CORE) $(COMMON) $(HEADERS)
	@$(call MKDIR,$(BUILD))
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ src/server.c $(CORE) $(COMMON) $(LDFLAGS) $(LDLIBS)

$(BENCH_BIN): src/bench.c $(COMMON) $(HEADERS)
	@$(call MKDIR,$(BUILD))
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ src/bench.c $(COMMON) $(LDFLAGS) $(LDLIBS)

$(TESTS_BIN): tests/test_main.c $(CORE) $(COMMON) $(HEADERS)
	@$(call MKDIR,$(BUILD))
	$(CC) $(CPPFLAGS) $(CFLAGS) -o $@ tests/test_main.c $(CORE) $(COMMON) $(LDFLAGS) $(LDLIBS)

test: $(TESTS_BIN)
	$(call RUN,$(TESTS_BIN))

integration: $(SERVER_BIN)
	$(PYTHON) -E -P tests/integration.py --server $(SERVER_BIN)

check: test integration

# AddressSanitizer + UndefinedBehaviorSanitizer build (Linux/macOS only:
# MinGW-w64 GCC does not ship a working ASan runtime).
ASAN_FLAGS := -g -O1 -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined

ifeq ($(OS),Windows_NT)
debug test-asan:
	@echo ASan/UBSan builds are not supported with MinGW-w64 on Windows; run them on Linux.
else
debug: $(BUILD)/asan/server $(BUILD)/asan/tests

$(BUILD)/asan/server: src/server.c $(CORE) $(COMMON) $(HEADERS)
	@$(call MKDIR,$(BUILD)/asan)
	$(CC) $(CPPFLAGS) $(CSTD) $(WARN) $(ASAN_FLAGS) -pthread -o $@ src/server.c $(CORE) $(COMMON) -pthread $(ASAN_FLAGS)

$(BUILD)/asan/tests: tests/test_main.c $(CORE) $(COMMON) $(HEADERS)
	@$(call MKDIR,$(BUILD)/asan)
	$(CC) $(CPPFLAGS) $(CSTD) $(WARN) $(ASAN_FLAGS) -pthread -o $@ tests/test_main.c $(CORE) $(COMMON) -pthread $(ASAN_FLAGS)

test-asan: debug
	$(BUILD)/asan/tests
	$(PYTHON) -E -P tests/integration.py --server $(BUILD)/asan/server
endif

CPPCHECK ?= cppcheck
cppcheck:
	$(CPPCHECK) --std=c11 --enable=warning,style,performance,portability --inline-suppr \
	  --suppress=missingIncludeSystem --error-exitcode=1 --quiet -Isrc src tests

clean:
	@$(call RMDIR,$(BUILD))
