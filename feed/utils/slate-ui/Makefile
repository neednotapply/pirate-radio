#
# slate-ui: a cohesive web UI for the Slate, served by uhttpd and driven by
# the existing rpcd/ubus backend (Slate SDR + Network Recon). Static files
# only, no compiled code.
#
# This is free software, licensed under the MIT license.
#
# A plain package (no luci.mk): it needs no LuCI feed to build.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=slate-ui
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/slate-ui
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Slate web UI (the device's interface, over ubus)
  DEPENDS:=+uhttpd +uhttpd-mod-ubus +rpcd +tcpdump-mini +iw +slate-sdr \
	+ucode +ucode-mod-fs +ucode-mod-uci +arp-scan +arp-scan-database +nmap +ip-full
  PKGARCH:=all
endef

define Package/slate-ui/description
  The Slate's web interface: a lightweight single-page app served by uhttpd at
  the web root (/), talking to its rpcd/ubus backend with a root ubus session.
  One dashboard for the joined network, hosts, Wi-Fi survey, threats, GPS, the
  radios and the SDR jobs, plus the router basics, packet capture, passive
  handshake capture and firmware flashing. This package carries both the UI and
  its backends (slate-router, slate-recon, slate-sdr, capture, handshake and
  firmware); it is the device's interface in place of LuCI.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/slate-ui/install
	# The single-page app, served at the web root.
	$(INSTALL_DIR) $(1)/www
	$(INSTALL_DATA) ./files/index.html $(1)/www/index.html
	$(INSTALL_DATA) ./files/app.js $(1)/www/app.js
	$(INSTALL_DATA) ./files/style.css $(1)/www/style.css
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) ./files/slate-upload $(1)/www/cgi-bin/slate-upload
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/95-slate-ui $(1)/etc/uci-defaults/95-slate-ui
	$(INSTALL_BIN) ./root/etc/uci-defaults/95-slate-recon-gpsd $(1)/etc/uci-defaults/95-slate-recon-gpsd
	# GPS plug and play: gpsd only while a GPS is plugged in
	$(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/hotplug.d/tty
	$(INSTALL_BIN) ./root/etc/init.d/slate-gps $(1)/etc/init.d/slate-gps
	$(INSTALL_DATA) ./root/etc/hotplug.d/tty/20-slate-gps $(1)/etc/hotplug.d/tty/20-slate-gps
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/usr/libexec $(1)/usr/libexec/rpcd $(1)/usr/share/rpcd/acl.d
	$(INSTALL_BIN) ./root/usr/sbin/slate-gps $(1)/usr/sbin/slate-gps
	# Router basics
	$(INSTALL_BIN) ./root/usr/sbin/slate-router $(1)/usr/sbin/slate-router
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/luci.slate-router $(1)/usr/libexec/rpcd/luci.slate-router
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-slate-router.json $(1)/usr/share/rpcd/acl.d/luci-app-slate-router.json
	# Packet capture
	$(INSTALL_BIN) ./root/usr/sbin/slate-capture $(1)/usr/sbin/slate-capture
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/luci.slate-capture $(1)/usr/libexec/rpcd/luci.slate-capture
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-slate-capture.json $(1)/usr/share/rpcd/acl.d/luci-app-slate-capture.json
	# Passive handshake capture
	$(INSTALL_BIN) ./root/usr/sbin/slate-handshake $(1)/usr/sbin/slate-handshake
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/luci.slate-handshake $(1)/usr/libexec/rpcd/luci.slate-handshake
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-slate-handshake.json $(1)/usr/share/rpcd/acl.d/luci-app-slate-handshake.json
	# Firmware flasher
	$(INSTALL_BIN) ./root/usr/sbin/slate-firmware $(1)/usr/sbin/slate-firmware
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/luci.slate-firmware $(1)/usr/libexec/rpcd/luci.slate-firmware
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-slate-firmware.json $(1)/usr/share/rpcd/acl.d/luci-app-slate-firmware.json
	# SDR backend (folded in from luci-app-slate-sdr)
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/luci.slate-sdr $(1)/usr/libexec/rpcd/luci.slate-sdr
	$(INSTALL_BIN) ./root/usr/libexec/luci-slate-sdr-devices $(1)/usr/libexec/luci-slate-sdr-devices
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-slate-sdr.json $(1)/usr/share/rpcd/acl.d/luci-app-slate-sdr.json
	# Network recon backend (folded in from luci-app-slate-recon)
	$(INSTALL_BIN) ./root/usr/sbin/slate-recon $(1)/usr/sbin/slate-recon
	$(INSTALL_BIN) ./root/usr/sbin/slate-survey $(1)/usr/sbin/slate-survey
	$(INSTALL_BIN) ./root/usr/sbin/slate-threats $(1)/usr/sbin/slate-threats
	$(INSTALL_BIN) ./root/usr/sbin/slate-dashboard $(1)/usr/sbin/slate-dashboard
	$(INSTALL_BIN) ./root/usr/libexec/slate-survey-merge $(1)/usr/libexec/slate-survey-merge
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/luci.slate-recon $(1)/usr/libexec/rpcd/luci.slate-recon
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-slate-recon.json $(1)/usr/share/rpcd/acl.d/luci-app-slate-recon.json
endef

# On a running router: make sure uhttpd exposes /ubus (what the UI calls), then
# reload it. The uci-defaults script also runs on a fresh boot.
define Package/slate-ui/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	[ -f /etc/uci-defaults/95-slate-ui ] && ( . /etc/uci-defaults/95-slate-ui ) >/dev/null 2>&1
	/etc/init.d/rpcd reload >/dev/null 2>&1
	/etc/init.d/uhttpd reload >/dev/null 2>&1
}
exit 0
endef

$(eval $(call BuildPackage,slate-ui))
