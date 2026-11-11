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
# the source for the real radios is built as well, with a stand-in for the
# library behind it (fake_soapy.c: a HackRF and an RTL-SDR that are not
# there, behind a driver as unforgiving as the HackRF's own), and
# test_radio.py holds the bridge to what a driver can be asked.
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

san=-fsanitize=address,undefined
strict=-fno-sanitize-recover=undefined
sanitized=
if [ "${SANITIZE:-1}" != 0 ] &&
	printf 'int main(void) { return 0; }\n' | $cc "$san" "$strict" -x c - -o "$build/san-check" > /dev/null 2>&1; then
	sanitized="$san $strict"
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

# The real radios' source (source_soapy.c), with fake_soapy.c where the
# SoapySDR library would be: under the sanitizers, where there are any.
if printf '#include <SoapySDR/Device.h>\n' | $cc -E -x c - > /dev/null 2>&1; then
	mkdir "$build/radio"
	cp "$src"/*.c "$src"/*.h "$here/fake_soapy.c" "$build/radio/"
	# shellcheck disable=SC2086
	(cd "$build/radio" && $cc -std=c99 -Wall -Wextra -O1 -g -fno-omit-frame-pointer $sanitized -DWITH_SOAPY \
		-o pirate-websdr main.c ws.c json.c source_sim.c source_soapy.c fake_soapy.c -lm)
	python3 "$here/test_radio.py" --bin "$build/radio/pirate-websdr" "$@"
else
	echo "ok - websdr radio: the real radios' source, with a stand-in for SoapySDR # SKIP (no SoapySDR headers here)"
fi

if [ -n "$sanitized" ]; then
	echo "# again, with the address and undefined-behaviour sanitizers"
	make -s -C "$build/san" SOAPY=0 CC="$cc" CFLAGS="-O1 -g -fno-omit-frame-pointer $san $strict" LDFLAGS="$san"
	python3 "$here/test_bridge.py" --bin "$build/san/pirate-websdr" "$@"
fi
