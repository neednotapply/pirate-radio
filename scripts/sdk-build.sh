#!/bin/sh
# Runs in the openwrt/sdk container (cwd /builder): compiles the packages of
# the feed mounted at /feed and copies them to /out.

set -eu

# OpenWrt's GitHub mirrors, at the commits this SDK was built from; only the
# base and packages feeds are needed.
sed -E \
	-e 's#https://git.openwrt.org/openwrt/openwrt.git#https://github.com/openwrt/openwrt.git#' \
	-e 's#https://git.openwrt.org/feed/packages.git#https://github.com/openwrt/packages.git#' \
	-e '/^src-git (luci|routing|telephony|video) /d' \
	feeds.conf.default > feeds.conf
echo "src-link slatesdr /feed" >> feeds.conf

quiet() {
	"$@" > /tmp/step.log 2>&1 || { cat /tmp/step.log; exit 1; }
}
quiet ./scripts/feeds update -a
quiet ./scripts/feeds install -a -p slatesdr

cat > .config <<-CONFIG
	CONFIG_ALL_NONSHARED=n
	CONFIG_ALL_KMODS=n
	CONFIG_ALL=n
	CONFIG_PACKAGE_libfftw3f=m
	CONFIG_PACKAGE_libhackrf=m
	CONFIG_PACKAGE_hackrf=m
	CONFIG_PACKAGE_libsoapysdr=m
	CONFIG_PACKAGE_soapysdr-util=m
	CONFIG_PACKAGE_soapy-hackrf=m
	CONFIG_PACKAGE_soapy-rtlsdr=m
	CONFIG_PACKAGE_soapy-remote-server=m
	CONFIG_PACKAGE_slate-sdr=m
	CONFIG_PACKAGE_slate-ui=m
	CONFIG_PACKAGE_dreampi=m
CONFIG
quiet make defconfig

for p in fftw3f hackrf soapysdr soapy-hackrf soapy-rtlsdr soapy-remote dreampi; do
	echo "-- $p"
	make -j"$(nproc)" "package/$p/compile"
done

# slate-sdr and the slate-ui package (UI + its backends) are scripts only:
# package them without building their run-time dependencies, which the
# ImageBuilder takes from OpenWrt's repository.
for p in slate-sdr slate-ui; do
	echo "-- $p"
	quiet make -C "package/feeds/slatesdr/$p" TOPDIR="$PWD" compile
done

cp bin/packages/*/slatesdr/*.apk /out/
ls -l /out
