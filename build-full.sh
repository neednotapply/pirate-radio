#!/bin/sh
# Full OpenWrt source build of the pirate-radio firmware for the GL-AR750S
# (NOR/NAND), with the kernel and Wi-Fi drivers rebuilt for spectral scan.
# Takes about 40 minutes on 4 cores and 20 GB of disk. Needs OpenWrt's build
# prerequisites (https://openwrt.org/docs/guide-developer/toolchain/install-buildsystem)
# and must not run as root.
# Output: out/firmware-full/*-sysupgrade.bin
#
#   ./build-full.sh                 configure and build
#   ./build-full.sh --config-only   configure and check the configuration

set -eu

: "${OPENWRT_VERSION:=25.12.6}"
here=$(cd "$(dirname "$0")" && pwd)
src="${OPENWRT_DIR:-$here/build/openwrt}"

if [ ! -d "$src/.git" ]; then
	git clone --depth 1 --branch "v$OPENWRT_VERSION" https://github.com/openwrt/openwrt.git "$src"
fi
cd "$src"

# The release's feeds, from OpenWrt's GitHub mirrors, plus ours.
sed -E \
	-e 's#https://git.openwrt.org/feed/packages.git#https://github.com/openwrt/packages.git#' \
	-e '/^src-git (luci|routing|telephony|video) /d' \
	feeds.conf.default > feeds.conf
echo "src-link pirateradio $here/feed" >> feeds.conf
./scripts/feeds update -a
./scripts/feeds install -a

cp "$here/config/full.config" .config
sed 's/#.*//' "$here/config/packages.txt" | xargs -n 1 | sed 's/.*/CONFIG_PACKAGE_&=y/' >> .config
# PIRATE_EXTRAS=1 adds the optional "complete"-build extras (see packages-extra.txt).
if [ "${PIRATE_EXTRAS:-0}" = 1 ]; then
	sed 's/#.*//' "$here/config/packages-extra.txt" | xargs -n 1 | sed 's/.*/CONFIG_PACKAGE_&=y/' >> .config
fi
make defconfig

# defconfig drops what it cannot satisfy; stop rather than build without it.
for opt in CONFIG_KERNEL_RELAY=y CONFIG_PACKAGE_ATH_SPECTRAL=y \
	CONFIG_PACKAGE_kmod-ath10k=y CONFIG_PACKAGE_ath10k-firmware-qca9887=y \
	CONFIG_PACKAGE_kmod-ath9k=y CONFIG_PACKAGE_pirate-radio=y CONFIG_PACKAGE_pirate-radio-ui=y \
	CONFIG_PACKAGE_dreampi=y CONFIG_PACKAGE_pirate-flipper=y \
	CONFIG_PACKAGE_kmod-rt2800-usb=y CONFIG_PACKAGE_kmod-usb-acm=y \
	CONFIG_PACKAGE_kmod-wireguard=y CONFIG_PACKAGE_kmod-zram=y \
	CONFIG_PACKAGE_ksmbd-server=y CONFIG_PACKAGE_kmod-fs-ksmbd=y CONFIG_PACKAGE_wsdd2=y \
	CONFIG_PACKAGE_kmod-fs-ntfs3=y; do
	grep -qx "$opt" .config || { echo "make defconfig dropped $opt" >&2; exit 1; }
done
if grep -qx 'CONFIG_PACKAGE_kmod-ath10k-ct=y' .config; then
	echo "kmod-ath10k-ct is still selected" >&2
	exit 1
fi

if [ "${1:-}" = --config-only ]; then
	echo "Configuration OK: $src/.config"
	exit 0
fi

# Every step logs to logs/<step>/*.txt (BUILD_LOG). On failure, the failed
# steps and the end of their logs go to logs/failure.txt and stderr.
logs="$src/logs"
mkdir -p "$logs"
rm -f "$logs/failure.txt"

report_failure() {
	{
		echo "== $1 failed. Failed steps:"
		grep -o 'ERROR: [^ ]* failed to build' "$logs/make.log" | sort -u
		grep -o 'ERROR: [^ ]* failed to build' "$logs/make.log" | cut -d' ' -f2 | sort -u |
			while read -r step; do
				for f in "$logs/$step"/*.txt; do
					[ -f "$f" ] || continue
					echo "== ${f#"$logs"/} (last 40 lines)"
					tail -n 40 "$f"
				done
			done
		echo "== make output (last 30 lines)"
		tail -n 30 "$logs/make.log"
	} | tee "$logs/failure.txt" >&2
	exit 1
}

# run_make <what> <make arguments>: make with its output also in make.log
run_make() {
	what="$1"
	shift
	rm -f "$logs/make.rc"
	{ make BUILD_LOG=1 "$@" 2>&1 || echo $? > "$logs/make.rc"; } | tee "$logs/make.log"
	[ ! -s "$logs/make.rc" ] || report_failure "$what"
}

# dump1090 enables HackRF, SoapySDR and LimeSDR support when pkg-config finds
# them, and this build has the first two; its package declares only
# librtlsdr. ADS-B runs on the RTL-SDR, so keep those off.
export HACKRF=no SOAPYSDR=no LIMESDR=no

run_make "Download" download -j8
run_make "Build" -j"$(nproc)"

mkdir -p "$here/out/firmware-full"
cp bin/targets/ath79/nand/*glinet_gl-ar750s-nor-nand*sysupgrade.bin \
	bin/targets/ath79/nand/*glinet_gl-ar750s-nor-nand*.manifest \
	"$here/out/firmware-full/"
ls -l "$here/out/firmware-full/"
