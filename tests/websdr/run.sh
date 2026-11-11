#!/bin/sh
# Builds pirate-websdr for this machine with its simulated radio only (no
# SoapySDR needed) and runs the protocol tests against it:
#
#   sh tests/websdr/run.sh [--only <part of a test's name>]
#
# Needs a C compiler, make and python3. With node there as well, the browser's
# side (the engine, tests/sdr/) is then run against the bridge just built.
# Where the compiler has them, the tests run a second time against a build
# with the address and undefined-behaviour sanitizers (SANITIZE=0 leaves that
# out). With SoapySDR's headers installed (Debian/Ubuntu: libsoapysdr-dev),
# the source for the real radios is compiled as well, as a check: nothing
# here can run it.
#
# Nothing is left behind in the repository: it builds in a temporary
# directory, and Python is told to write no bytecode.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
src=$here/../../feed/utils/pirate-websdr/src
build=$(mktemp -d)
trap 'rm -rf "$build" "$here/__pycache__"' EXIT
cc=${CC:-cc}
export PYTHONDONTWRITEBYTECODE=1

mkdir "$build/plain" "$build/san"
cp "$src"/*.c "$src"/*.h "$src"/Makefile "$build/plain/"
cp "$src"/*.c "$src"/*.h "$src"/Makefile "$build/san/"

make -s -C "$build/plain" SOAPY=0 CC="$cc" CFLAGS="-O2 -g"

if printf '#include <SoapySDR/Device.h>\n' | $cc -E -x c - > /dev/null 2>&1; then
	$cc -std=c99 -Wall -Wextra -O2 -DWITH_SOAPY -c -o "$build/soapy-check.o" "$src/source_soapy.c"
	echo "ok - websdr: source_soapy.c compiles against this machine's SoapySDR"
else
	echo "ok - websdr: source_soapy.c compiles # SKIP (no SoapySDR headers here)"
fi

python3 "$here/test_bridge.py" --bin "$build/plain/pirate-websdr" "$@"

# The other half against it: the receiver's engine (the browser's side,
# tests/sdr/), as the Listen page runs it, with this bridge for a radio: its
# simulated stations have to be heard as the tones they carry.
if command -v node > /dev/null 2>&1; then
	node "$here/../sdr/bridge.test.js" --bin "$build/plain/pirate-websdr"
else
	echo "ok - websdr: the engine against this bridge # SKIP (no node here)"
fi

san=-fsanitize=address,undefined
strict=-fno-sanitize-recover=undefined
if [ "${SANITIZE:-1}" != 0 ] &&
	printf 'int main(void) { return 0; }\n' | $cc "$san" "$strict" -x c - -o "$build/san-check" > /dev/null 2>&1; then
	echo "# again, with the address and undefined-behaviour sanitizers"
	make -s -C "$build/san" SOAPY=0 CC="$cc" CFLAGS="-O1 -g -fno-omit-frame-pointer $san $strict" LDFLAGS="$san"
	python3 "$here/test_bridge.py" --bin "$build/san/pirate-websdr" "$@"
fi
