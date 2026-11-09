#!/bin/sh
# Run tests/rootfs-test.sh in OpenWrt's mips_24kc userland (QEMU user mode).
#
#   tests/run.sh <directory with the built .apk files>
#
# Needs docker and a binfmt_misc entry for big-endian MIPS (Debian/Ubuntu:
# apt install qemu-user-static). pirate-radio itself is taken from this tree,
# so the tests always cover the current scripts.

set -e

: "${OPENWRT_VERSION:=25.12.6}"
SDK_IMAGE="openwrt/sdk:ath79-nand-v$OPENWRT_VERSION"
ROOTFS_IMAGE="openwrt/rootfs:mips_24kc-v$OPENWRT_VERSION"

here=$(cd "$(dirname "$0")/.." && pwd)
pkgs=$(cd "${1:?usage: tests/run.sh <directory with .apk files>}" && pwd)
ov=$(mktemp -d)
trap 'rm -rf "$ov"' EXIT

# Unpacked as root, then handed back to the caller so the steps below (and
# the cleanup) can write to it. tests/fakemodem (a modem with a Dreamcast on
# the line, for the dreampi tests) and tests/fakeflipper (a Flipper Zero, for
# pirate-flipper's), tests/fakemeshcore (a MeshCore radio, for
# pirate-meshcore's) and tests/fakeportapack (a PortaPack on Mayhem firmware,
# for pirate-portapack's) are built with the SDK's compiler.
docker run --rm --user 0 -e OWNER="$(id -u):$(id -g)" \
	-v "$pkgs:/pkgs:ro" -v "$ov:/ov" -v "$here/tests:/tests:ro" "$SDK_IMAGE" sh -c '
	set -e
	for f in /pkgs/*.apk; do
		case "${f##*/}" in pirate-radio-* | pirate-radio-ui-*) continue ;; esac
		/builder/staging_dir/host/bin/apk extract --allow-untrusted --destination /ov "$f" > /dev/null
	done
	rm -rf /ov/lib/apk
	cc=$(find /builder/staging_dir -path "*/toolchain-*/bin/*-openwrt-linux-musl-gcc" | head -n 1)
	mkdir -p /ov/usr/bin
	STAGING_DIR=/builder/staging_dir "$cc" -O2 -Wall -o /ov/usr/bin/fakemodem /tests/fakemodem.c
	STAGING_DIR=/builder/staging_dir "$cc" -O2 -Wall -o /ov/usr/bin/fakeflipper /tests/fakeflipper.c
	STAGING_DIR=/builder/staging_dir "$cc" -O2 -Wall -o /ov/usr/bin/fakemeshcore /tests/fakemeshcore.c
	STAGING_DIR=/builder/staging_dir "$cc" -O2 -Wall -o /ov/usr/bin/fakeportapack /tests/fakeportapack.c
	chown -R "$OWNER" /ov'

f="$here/feed/utils/pirate-radio/files"
mkdir -p "$ov/etc/config" "$ov/etc/init.d" "$ov/usr/libexec" "$ov/usr/sbin" \
	"$ov/usr/share/pirate-radio" "$ov/www/cgi-bin" "$ov/mnt/sdcard"
cp "$f/pirate-radio.config" "$ov/etc/config/pirate-radio"
cp "$f/pirate-radio.init" "$ov/etc/init.d/pirate-radio"
cp "$f/job.sh" "$ov/usr/libexec/pirate-radio-job"
cp "$f/pirate-radio.cli" "$ov/usr/sbin/pirate-radio"
cp "$f/lib.sh" "$ov/usr/share/pirate-radio/lib.sh"
cp "$f/status.cgi" "$ov/www/cgi-bin/pirate-radio"
mkdir -p "$ov/etc/hotplug.d/usb" "$ov/etc/uci-defaults"
cp "$f/pirate-radio.hotplug" "$ov/etc/hotplug.d/usb/20-pirate-radio"
cp "$f/pirate-radio.migrate" "$ov/etc/uci-defaults/10-pirate-radio-migrate"
chmod 755 "$ov/etc/init.d/pirate-radio" "$ov/usr/libexec/pirate-radio-job" \
	"$ov/usr/sbin/pirate-radio" "$ov/www/cgi-bin/pirate-radio"

# The pirate-radio-ui package carries the whole web interface and its backends —
# router basics, network recon, SDR, packet capture, passive handshake capture
# and firmware — from this tree too. pirate-upload is the firmware-staging CGI
# (under files/); 95-pirate-recon-gpsd is the gpsd first-boot default.
u="$here/feed/utils/pirate-radio-ui/root"
mkdir -p "$ov/usr/libexec/rpcd" "$ov/usr/share/rpcd/acl.d" "$ov/etc/uci-defaults"
cp "$u/usr/sbin/pirate-router" "$u/usr/sbin/pirate-capture" "$u/usr/sbin/pirate-handshake" \
	"$u/usr/sbin/pirate-firmware" "$u/usr/sbin/pirate-recon" "$u/usr/sbin/pirate-survey" \
	"$u/usr/sbin/pirate-threats" "$u/usr/sbin/pirate-dashboard" "$ov/usr/sbin/"
cp "$u/usr/libexec/rpcd/pirate.router" "$u/usr/libexec/rpcd/pirate.capture" \
	"$u/usr/libexec/rpcd/pirate.handshake" "$u/usr/libexec/rpcd/pirate.firmware" \
	"$u/usr/libexec/rpcd/pirate.sdr" "$u/usr/libexec/rpcd/pirate.recon" "$ov/usr/libexec/rpcd/"
cp "$u/usr/libexec/pirate-radio-devices" "$u/usr/libexec/pirate-survey-merge" "$ov/usr/libexec/"
cp "$u/usr/share/rpcd/acl.d/pirate-router.json" "$u/usr/share/rpcd/acl.d/pirate-capture.json" \
	"$u/usr/share/rpcd/acl.d/pirate-handshake.json" "$u/usr/share/rpcd/acl.d/pirate-firmware.json" \
	"$u/usr/share/rpcd/acl.d/pirate-sdr.json" "$u/usr/share/rpcd/acl.d/pirate-recon.json" \
	"$ov/usr/share/rpcd/acl.d/"
cp "$u/etc/uci-defaults/95-pirate-recon-gpsd" "$ov/etc/uci-defaults/"
mkdir -p "$ov/etc/init.d" "$ov/etc/hotplug.d/tty"
cp "$u/usr/sbin/pirate-gps" "$ov/usr/sbin/"
cp "$u/etc/init.d/pirate-gps" "$ov/etc/init.d/"
cp "$u/etc/hotplug.d/tty/20-pirate-gps" "$ov/etc/hotplug.d/tty/"
chmod 755 "$ov/usr/sbin/pirate-gps" "$ov/etc/init.d/pirate-gps"
# The DreamPi page's backend (the dreampi package itself comes built, above)
cp "$u/usr/sbin/pirate-dreampi" "$ov/usr/sbin/"
cp "$u/usr/libexec/rpcd/pirate.dreampi" "$ov/usr/libexec/rpcd/"
cp "$u/usr/share/rpcd/acl.d/pirate-dreampi.json" "$ov/usr/share/rpcd/acl.d/"
# The Phone page's backend (an Android phone on the USB port)
cp "$u/usr/sbin/pirate-phone" "$ov/usr/sbin/"
cp "$u/usr/libexec/rpcd/pirate.phone" "$ov/usr/libexec/rpcd/"
cp "$u/usr/share/rpcd/acl.d/pirate-phone.json" "$ov/usr/share/rpcd/acl.d/"
chmod 755 "$ov/usr/sbin/pirate-phone" "$ov/usr/libexec/rpcd/pirate.phone"
# The Access and Terminal pages' backend
cp "$u/usr/sbin/pirate-access" "$ov/usr/sbin/"
cp "$u/usr/libexec/rpcd/pirate.access" "$ov/usr/libexec/rpcd/"
cp "$u/usr/share/rpcd/acl.d/pirate-access.json" "$ov/usr/share/rpcd/acl.d/"
cp "$u/etc/uci-defaults/96-pirate-terminal" "$ov/etc/uci-defaults/"
chmod 755 "$ov/usr/sbin/pirate-access" "$ov/usr/libexec/rpcd/pirate.access"
# The Flipper page's ACL (the pirate-flipper package itself comes built, above)
cp "$u/usr/share/rpcd/acl.d/pirate-flipper.json" "$ov/usr/share/rpcd/acl.d/"
# The Messenger page's ACL (the pirate-meshcore package comes built, above)
cp "$u/usr/share/rpcd/acl.d/pirate-meshcore.json" "$ov/usr/share/rpcd/acl.d/"
# The PortaPack page's ACL (the pirate-portapack package comes built, above)
cp "$u/usr/share/rpcd/acl.d/pirate-portapack.json" "$ov/usr/share/rpcd/acl.d/"
chmod 755 "$ov/usr/sbin/pirate-dreampi" "$ov/usr/libexec/rpcd/pirate.dreampi"
# USB drives plug and play (pirate-usb), its block hotplug hook and rpcd plugin
mkdir -p "$ov/etc/hotplug.d/block"
cp "$u/usr/sbin/pirate-usb" "$ov/usr/sbin/"
cp "$u/usr/libexec/pirate-usb-list" "$ov/usr/libexec/"
cp "$u/usr/libexec/rpcd/pirate.usb" "$ov/usr/libexec/rpcd/"
cp "$u/usr/share/rpcd/acl.d/pirate-usb.json" "$ov/usr/share/rpcd/acl.d/"
cp "$u/etc/hotplug.d/block/05-pirate-usb" "$ov/etc/hotplug.d/block/"
cp "$u/etc/hotplug.d/block/20-pirate-usb-card" "$ov/etc/hotplug.d/block/"
cp "$u/etc/uci-defaults/96-pirate-usb" "$ov/etc/uci-defaults/"
chmod 755 "$ov/usr/sbin/pirate-usb" "$ov/usr/libexec/pirate-usb-list" "$ov/usr/libexec/rpcd/pirate.usb"
cp "$here/feed/utils/pirate-radio-ui/files/pirate-upload" "$ov/www/cgi-bin/pirate-upload"
# The page, for the check that the ACL lets through every call it makes
cp "$here/feed/utils/pirate-radio-ui/files/app.js" "$ov/www/app.js"
# First boot (the hostname) and <hostname>.local on the router's DNS
cp "$here/feed/utils/pirate-radio-ui/files/95-pirate-radio-ui" "$ov/etc/uci-defaults/"
mkdir -p "$ov/etc/hotplug.d/iface"
cp "$u/etc/hotplug.d/iface/30-pirate-local" "$ov/etc/hotplug.d/iface/"
chmod 755 "$ov/usr/sbin/pirate-router" "$ov/usr/sbin/pirate-capture" "$ov/usr/sbin/pirate-handshake" \
	"$ov/usr/sbin/pirate-firmware" "$ov/usr/sbin/pirate-recon" "$ov/usr/sbin/pirate-survey" \
	"$ov/usr/sbin/pirate-threats" "$ov/usr/sbin/pirate-dashboard" \
	"$ov/usr/libexec/rpcd/pirate.router" "$ov/usr/libexec/rpcd/pirate.capture" \
	"$ov/usr/libexec/rpcd/pirate.handshake" "$ov/usr/libexec/rpcd/pirate.firmware" \
	"$ov/usr/libexec/rpcd/pirate.sdr" "$ov/usr/libexec/rpcd/pirate.recon" \
	"$ov/usr/libexec/pirate-radio-devices" "$ov/usr/libexec/pirate-survey-merge" \
	"$ov/www/cgi-bin/pirate-upload"

# The decoders and libraries OpenWrt itself packages come from its
# repository when online; offline, <directory> must hold them too.
docker run --rm -v "$ov:/ov:ro" -v "$here/tests:/tests:ro" "$ROOTFS_IMAGE" sh -c '
	if apk update > /dev/null 2>&1; then
		apk add rtl-sdr rtl_433 rtl-ais libstdcpp6 libusb-1.0-0 \
			ucode ucode-mod-fs ucode-mod-uci ubus > /tmp/apk.log 2>&1 ||
			{ echo "apk add failed:"; cat /tmp/apk.log; }
	else
		echo "(offline: testing with the given packages only)"
	fi
	cp -a /ov/. / && sh /tests/rootfs-test.sh'
