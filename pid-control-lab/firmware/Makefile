# PID firmware library - host build of the unit + golden tests.
#   make test          (Linux/macOS)
#   mingw32-make test  (Windows, WinLibs GCC - see README "Windows build notes")
# make's built-in default CC is 'cc', which WinLibs doesn't ship; use gcc unless overridden.
ifeq ($(origin CC),default)
CC := gcc
endif
CFLAGS  ?= -std=c99 -Wall -Wextra -Wpedantic -Werror -Wshadow -Wconversion -Wdouble-promotion -O2
GOLDEN  := tests/golden/drone_clamp.csv tests/golden/motor_backcalc.csv tests/golden/heater_none.csv
TEST_BIN := test_pid$(if $(filter Windows_NT,$(OS)),.exe,)

.PHONY: all test test-double clean

all: $(TEST_BIN)

$(TEST_BIN): pid.c pid.h tests/test_pid.c
	$(CC) $(CFLAGS) -o $@ pid.c tests/test_pid.c

test: $(TEST_BIN)
	./$(TEST_BIN) $(GOLDEN)

# Same tests with pid_real_t = double (golden error drops to ~1e-7, limited by the 9-digit CSV).
test-double: pid.c pid.h tests/test_pid.c
	$(CC) $(CFLAGS) -DPID_USE_DOUBLE -o test_pid_double$(if $(filter Windows_NT,$(OS)),.exe,) pid.c tests/test_pid.c
	./test_pid_double$(if $(filter Windows_NT,$(OS)),.exe,) $(GOLDEN)

clean:
	$(RM) test_pid test_pid.exe test_pid_double test_pid_double.exe
