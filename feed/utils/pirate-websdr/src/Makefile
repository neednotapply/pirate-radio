# pirate-websdr, by itself (the OpenWrt package's Makefile is one directory up).
#
#   make            with SoapySDR: the real radios, and the simulated one (--sim)
#   make SOAPY=0    without: the simulated radio only. Builds with any C99
#                   compiler on a POSIX system, for the tests (tests/websdr/).

SOAPY ?= 1

CC ?= cc
CFLAGS ?= -O2
WARN := -std=c99 -Wall -Wextra
LDLIBS := -lm

OBJS := main.o ws.o json.o source_sim.o
HDRS := clock.h json.h source.h ws.h

ifeq ($(SOAPY),1)
OBJS += source_soapy.o
DEFS := -DWITH_SOAPY
LDLIBS := -lSoapySDR $(LDLIBS)
else
DEFS :=
endif

all: pirate-websdr

pirate-websdr: $(OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

%.o: %.c $(HDRS)
	$(CC) $(CFLAGS) $(WARN) $(DEFS) -c -o $@ $<

clean:
	rm -f $(OBJS) source_soapy.o pirate-websdr

.PHONY: all clean
