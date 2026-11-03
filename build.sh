#!/bin/sh
# Builds the pirate-radio firmware for the GL-AR750S (NOR/NAND) with Docker,
# in about 15 minutes:
#   1. the OpenWrt SDK compiles the packages in feed/
#   2. the ImageBuilder puts them, OpenWrt's own packages and its release
#      kernel into a sysupgrade image.
# Output: out/firmware/*-sysupgrade.bin, out/packages/*.apk
#
# The release kernel has no Wi-Fi spectral scan; build-full.sh adds it.

set -eu

: "${OPENWRT_VERSION:=25.12.6}"
PROFILE=glinet_gl-ar750s-nor-nand
here=$(cd "$(dirname "$0")" && pwd)
out="$here/out"
packages=$(sed 's/#.*//' "$here/config/packages.txt" | xargs)
# PIRATE_EXTRAS=1 adds the optional "complete"-build extras (e.g. the MQTT
# broker) from config/packages-extra.txt. The lean default leaves them out.
if [ "${PIRATE_EXTRAS:-0}" = 1 ]; then
	packages="$packages $(sed 's/#.*//' "$here/config/packages-extra.txt" | xargs)"
fi

rm -rf "$out/packages" "$out/firmware"
mkdir -p "$out/packages" "$out/firmware"
# The containers build as their own user (uid 1000).
chmod 777 "$out/packages" "$out/firmware"

echo "== Packages (OpenWrt $OPENWRT_VERSION SDK)"
docker run --rm \
	-v "$here/feed:/feed:ro" -v "$here/scripts:/scripts:ro" -v "$out/packages:/out" \
	"openwrt/sdk:ath79-nand-v$OPENWRT_VERSION" sh /scripts/sdk-build.sh

echo "== Firmware (OpenWrt $OPENWRT_VERSION ImageBuilder)"
docker run --rm \
	-e PROFILE="$PROFILE" -e PACKAGES="$packages" \
	-v "$out/packages:/pkgs:ro" -v "$here/scripts:/scripts:ro" -v "$out/firmware:/out" \
	"openwrt/imagebuilder:ath79-nand-v$OPENWRT_VERSION" sh /scripts/ib-build.sh

echo
ls -l "$out/firmware/"*sysupgrade.bin
