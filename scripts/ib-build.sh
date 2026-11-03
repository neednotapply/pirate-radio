#!/bin/sh
# Runs in the openwrt/imagebuilder container (cwd /builder): builds the
# sysupgrade image from the packages in /pkgs and OpenWrt's repository,
# into /out. Needs PROFILE and PACKAGES.

set -eu

cp /pkgs/*.apk packages/
make image PROFILE="$PROFILE" PACKAGES="$PACKAGES" EXTRA_IMAGE_NAME=pirate-radio \
	BIN_DIR=/builder/firmware
cp /builder/firmware/* /out/
ls -l /out
