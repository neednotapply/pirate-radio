#
# pirate-radio-ui: a cohesive web UI for the Slate, served by uhttpd and driven by
# the existing rpcd/ubus backend (Pirate Radio + Network Recon). Static files
# only, no compiled code.
#
# This is free software, licensed under the MIT license.
#
# A plain package (no luci.mk): it needs no LuCI feed to build.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-radio-ui
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/pirate-radio-ui
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Pirate Radio web UI (the device's interface, over ubus)
  DEPENDS:=+uhttpd +uhttpd-mod-ubus +rpcd +umdns +tcpdump-mini +iw +pirate-radio \
	+ucode +ucode-mod-fs +ucode-mod-uci +arp-scan +arp-scan-database +nmap +ip-full
  PKGARCH:=all
endef

define Package/pirate-radio-ui/description
  The Slate's web interface: a lightweight single-page app served by uhttpd at
  the web root (/), talking to its rpcd/ubus backend with a root ubus session.
  One dashboard for the joined network, hosts, Wi-Fi survey, threats, GPS, the
  radios and the SDR jobs, plus the router basics, packet capture, passive
  handshake capture and firmware flashing. This package carries both the UI and
  its backends (pirate-router, pirate-recon, pirate-radio, capture, handshake and
  firmware); it is the device's interface in place of LuCI.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/pirate-radio-ui/install
	# The single-page app, served at the web root.
	$(INSTALL_DIR) $(1)/www
	$(INSTALL_DATA) ./files/index.html $(1)/www/index.html
	$(INSTALL_DATA) ./files/app.js $(1)/www/app.js
	$(INSTALL_DATA) ./files/style.css $(1)/www/style.css
	# MCO Advanced's MCOimg decoder (MIT), loaded when the Messenger shows an image
	$(INSTALL_DIR) $(1)/www/mcoimg
	$(INSTALL_DATA) ./files/mcoimg/mcoimg-codec.global.js ./files/mcoimg/mcoimg-v3-codec.global.js \
		./files/mcoimg/mcoimg-browser.global.js ./files/mcoimg/LICENSE $(1)/www/mcoimg/
	# The version index.html loads app.js and style.css under, so browsers
	# take the new ones after an update (uhttpd sends no cache headers)
	cat ./files/app.js ./files/style.css | md5sum | cut -c1-12 > $(1)/www/ui-version
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) ./files/pirate-upload $(1)/www/cgi-bin/pirate-upload
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/95-pirate-radio-ui $(1)/etc/uci-defaults/95-pirate-radio-ui
	$(INSTALL_BIN) ./root/etc/uci-defaults/95-pirate-recon-gpsd $(1)/etc/uci-defaults/95-pirate-recon-gpsd
	# <hostname>.local on the router's DNS as well as mDNS (umdns)
	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_DATA) ./root/etc/hotplug.d/iface/30-pirate-local $(1)/etc/hotplug.d/iface/30-pirate-local
	# GPS plug and play: gpsd only while a GPS is plugged in
	$(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/hotplug.d/tty
	$(INSTALL_BIN) ./root/etc/init.d/pirate-gps $(1)/etc/init.d/pirate-gps
	$(INSTALL_DATA) ./root/etc/hotplug.d/tty/20-pirate-gps $(1)/etc/hotplug.d/tty/20-pirate-gps
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/usr/libexec $(1)/usr/libexec/rpcd $(1)/usr/share/rpcd/acl.d
	$(INSTALL_BIN) ./root/usr/sbin/pirate-gps $(1)/usr/sbin/pirate-gps
	# USB drives plug and play: mounted, and shared over SMB (ksmbd-server,
	# wsdd2) and to the Drives page while plugged in
	$(INSTALL_DIR) $(1)/etc/hotplug.d/block $(1)/lib/upgrade/keep.d
	$(INSTALL_BIN) ./root/etc/init.d/pirate-usb $(1)/etc/init.d/pirate-usb
	$(INSTALL_DATA) ./root/etc/hotplug.d/block/05-pirate-usb $(1)/etc/hotplug.d/block/05-pirate-usb
	$(INSTALL_DATA) ./root/etc/hotplug.d/block/20-pirate-usb-card $(1)/etc/hotplug.d/block/20-pirate-usb-card
	$(INSTALL_BIN) ./root/etc/uci-defaults/96-pirate-usb $(1)/etc/uci-defaults/96-pirate-usb
	$(INSTALL_DATA) ./root/lib/upgrade/keep.d/pirate-usb $(1)/lib/upgrade/keep.d/pirate-usb
	$(INSTALL_BIN) ./root/usr/sbin/pirate-usb $(1)/usr/sbin/pirate-usb
	$(INSTALL_BIN) ./root/usr/libexec/pirate-usb-list $(1)/usr/libexec/pirate-usb-list
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.usb $(1)/usr/libexec/rpcd/pirate.usb
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-usb.json $(1)/usr/share/rpcd/acl.d/pirate-usb.json
	# Router basics
	$(INSTALL_BIN) ./root/usr/sbin/pirate-router $(1)/usr/sbin/pirate-router
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.router $(1)/usr/libexec/rpcd/pirate.router
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-router.json $(1)/usr/share/rpcd/acl.d/pirate-router.json
	# Access: SSH's settings, keys and sessions, recent sign-ins, and the
	# terminal in the browser (ttyd, set up on first boot)
	$(INSTALL_BIN) ./root/usr/sbin/pirate-access $(1)/usr/sbin/pirate-access
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.access $(1)/usr/libexec/rpcd/pirate.access
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-access.json $(1)/usr/share/rpcd/acl.d/pirate-access.json
	$(INSTALL_BIN) ./root/etc/uci-defaults/96-pirate-terminal $(1)/etc/uci-defaults/96-pirate-terminal
	# Packet capture
	$(INSTALL_BIN) ./root/usr/sbin/pirate-capture $(1)/usr/sbin/pirate-capture
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.capture $(1)/usr/libexec/rpcd/pirate.capture
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-capture.json $(1)/usr/share/rpcd/acl.d/pirate-capture.json
	# Passive handshake capture
	$(INSTALL_BIN) ./root/usr/sbin/pirate-handshake $(1)/usr/sbin/pirate-handshake
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.handshake $(1)/usr/libexec/rpcd/pirate.handshake
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-handshake.json $(1)/usr/share/rpcd/acl.d/pirate-handshake.json
	# DreamPi page (the dreampi package does the work)
	$(INSTALL_BIN) ./root/usr/sbin/pirate-dreampi $(1)/usr/sbin/pirate-dreampi
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.dreampi $(1)/usr/libexec/rpcd/pirate.dreampi
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-dreampi.json $(1)/usr/share/rpcd/acl.d/pirate-dreampi.json
	# Phone page: an Android phone on the USB port. adb (USB debugging) reads
	# and switches its USB mode and reaches its files; the kmods for tethering
	# (cdc-ncm), MIDI (usb-audio) and the webcam (video-uvc) ride in the image
	# (config/packages.txt). pirate-phone-dl streams a pulled file; the usb
	# hotplug tidies up when the phone leaves.
	$(INSTALL_BIN) ./root/usr/sbin/pirate-phone $(1)/usr/sbin/pirate-phone
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.phone $(1)/usr/libexec/rpcd/pirate.phone
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-phone.json $(1)/usr/share/rpcd/acl.d/pirate-phone.json
	$(INSTALL_BIN) ./files/pirate-phone-dl $(1)/www/cgi-bin/pirate-phone-dl
	$(INSTALL_DIR) $(1)/etc/hotplug.d/usb
	$(INSTALL_DATA) ./root/etc/hotplug.d/usb/30-pirate-phone $(1)/etc/hotplug.d/usb/30-pirate-phone
	# Flipper page (the pirate-flipper package's daemon does the work; without
	# it the page says so, rather than being refused)
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-flipper.json $(1)/usr/share/rpcd/acl.d/pirate-flipper.json
	# Messenger page (the pirate-meshcore package's daemon does the work)
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-meshcore.json $(1)/usr/share/rpcd/acl.d/pirate-meshcore.json
	# PortaPack page (the pirate-portapack package's daemon does the work)
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-portapack.json $(1)/usr/share/rpcd/acl.d/pirate-portapack.json
	# Firmware flasher
	$(INSTALL_BIN) ./root/usr/sbin/pirate-firmware $(1)/usr/sbin/pirate-firmware
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.firmware $(1)/usr/libexec/rpcd/pirate.firmware
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-firmware.json $(1)/usr/share/rpcd/acl.d/pirate-firmware.json
	# SDR backend (folded in from pirate-sdr)
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.sdr $(1)/usr/libexec/rpcd/pirate.sdr
	$(INSTALL_BIN) ./root/usr/libexec/pirate-radio-devices $(1)/usr/libexec/pirate-radio-devices
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-sdr.json $(1)/usr/share/rpcd/acl.d/pirate-sdr.json
	# Network recon backend (folded in from pirate-recon)
	$(INSTALL_BIN) ./root/usr/sbin/pirate-recon $(1)/usr/sbin/pirate-recon
	$(INSTALL_BIN) ./root/usr/sbin/pirate-survey $(1)/usr/sbin/pirate-survey
	$(INSTALL_BIN) ./root/usr/sbin/pirate-threats $(1)/usr/sbin/pirate-threats
	$(INSTALL_BIN) ./root/usr/sbin/pirate-dashboard $(1)/usr/sbin/pirate-dashboard
	$(INSTALL_BIN) ./root/usr/libexec/pirate-survey-merge $(1)/usr/libexec/pirate-survey-merge
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/pirate.recon $(1)/usr/libexec/rpcd/pirate.recon
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/pirate-recon.json $(1)/usr/share/rpcd/acl.d/pirate-recon.json
endef

# On a running router: make sure uhttpd exposes /ubus (what the UI calls), then
# reload it. The uci-defaults script also runs on a fresh boot.
define Package/pirate-radio-ui/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	[ -f /etc/uci-defaults/95-pirate-radio-ui ] && ( . /etc/uci-defaults/95-pirate-radio-ui ) >/dev/null 2>&1
	/usr/sbin/pirate-access term_setup >/dev/null 2>&1
	/etc/init.d/rpcd reload >/dev/null 2>&1
	/etc/init.d/uhttpd reload >/dev/null 2>&1
}
exit 0
endef

$(eval $(call BuildPackage,pirate-radio-ui))
