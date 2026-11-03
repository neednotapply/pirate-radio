#
# dreampi: DreamPi for the Slate. A Sega Dreamcast dials a USB voice modem
# plugged into the router and gets online, as with a DreamPi on a Raspberry
# Pi: through DreamPi's servers over a PPP link here, or through Flycast's
# DCNet.
#
# src/dreampi.c is MIT (a port of DreamPi's modem code, MIT); src/dcnet.c is
# GPL-2.0-or-later (from Flycast).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=dreampi
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT GPL-2.0-or-later

include $(INCLUDE_DIR)/package.mk

define Package/dreampi
  SECTION:=net
  CATEGORY:=Network
  TITLE:=DreamPi: get a Dreamcast online through a USB modem
  URL:=https://github.com/Kazade/dreampi
  DEPENDS:=+ppp +dnsmasq +kmod-usb-acm +uclient-fetch +nftables
endef

define Package/dreampi/description
  Answers a Sega Dreamcast's dial-up modem with a USB voice modem (the
  modems DreamPi uses: Conexant RD02-D400 / Dell NW147, Zoom 3095, ...) and
  gets it online. The modem plays a dial tone, hears the number dialled and
  answers; the call then runs over PPP on this router with DreamPi's DNS
  servers and its fixes for retired game servers, or goes to Flycast's DCNet
  (dial *69 first, or make it the default). Runs while a modem is plugged in.
  The Dreamcast still needs a line voltage inducer between it and the modem.
endef

define Package/dreampi/conffiles
/etc/config/dreampi
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/dreampi $(PKG_BUILD_DIR)/dreampi.c -lm
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/dcnet $(PKG_BUILD_DIR)/dcnet.c
endef

define Package/dreampi/install
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/usr/libexec/dreampi $(1)/usr/share/dreampi
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/dreampi $(1)/usr/sbin/dreampi
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/dcnet $(1)/usr/sbin/dcnet
	$(INSTALL_BIN) ./files/call.sh $(1)/usr/libexec/dreampi/call
	$(INSTALL_BIN) ./files/dcnow.sh $(1)/usr/libexec/dreampi/dcnow
	$(INSTALL_BIN) ./files/nat.sh $(1)/usr/libexec/dreampi/nat
	$(INSTALL_DATA) ./files/lib.sh $(1)/usr/share/dreampi/lib.sh
	$(INSTALL_DATA) ./files/modems $(1)/usr/share/dreampi/modems
	$(INSTALL_DATA) ./files/dnat.txt $(1)/usr/share/dreampi/dnat.txt
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/uci-defaults $(1)/etc/hotplug.d/tty
	$(INSTALL_CONF) ./files/dreampi.config $(1)/etc/config/dreampi
	$(INSTALL_BIN) ./files/dreampi.init $(1)/etc/init.d/dreampi
	$(INSTALL_BIN) ./files/dreampi.defaults $(1)/etc/uci-defaults/90-dreampi
	$(INSTALL_DATA) ./files/dreampi.hotplug $(1)/etc/hotplug.d/tty/30-dreampi
endef

# On a running router: the firewall zone and DNS settings, then answer if a
# modem is already plugged in. The uci-defaults script also runs on a fresh
# boot.
define Package/dreampi/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	[ -f /etc/uci-defaults/90-dreampi ] && ( . /etc/uci-defaults/90-dreampi ) >/dev/null 2>&1
	/etc/init.d/dreampi enable
	/etc/init.d/dreampi start
}
exit 0
endef

$(eval $(call BuildPackage,dreampi))
