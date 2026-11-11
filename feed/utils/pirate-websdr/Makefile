#
# pirate-websdr: the radio behind the web UI's Listen page. It passes the raw
# IQ samples of the HackRF or the RTL-SDR (through SoapySDR) to the browser
# over a WebSocket and takes the tuning back; the browser does the signal
# processing, which this router could not. DESIGN.md, beside this file, is
# the contract between it, the browser's side and the page.
#
# This is free software, licensed under the MIT license.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-websdr
PKG_VERSION:=0.1.1
PKG_RELEASE:=1

PKG_MAINTAINER:=pirate-radio
PKG_LICENSE:=MIT

PKG_BUILD_DEPENDS:=soapysdr
PKG_BUILD_PARALLEL:=1
# Plain MIPS32 code, not the denser and slower MIPS16 the target defaults to:
# the simulated radio (--sim), tried on the router itself, has a loop that
# runs once per sample.
PKG_BUILD_FLAGS:=no-mips16

include $(INCLUDE_DIR)/package.mk

define Package/pirate-websdr
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Radio samples to the browser over a WebSocket (web UI receiver)
  DEPENDS:=+libsoapysdr
endef

define Package/pirate-websdr/description
  The router's side of the receiver in the Pirate Radio web UI (its Listen
  page): a small daemon that opens the HackRF or the RTL-SDR through SoapySDR
  when a browser asks, sends it the raw 8-bit IQ samples over a WebSocket
  (port 8073) and takes tuning and gain back. No signal processing happens
  here. Installed as /usr/bin/pirate-websdr; pirate-radio runs it as its
  'websdr' job.
endef

# The sources are here, in src/, not fetched.
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
	$(MAKE) $(PKG_JOBS) -C $(PKG_BUILD_DIR) \
		CC="$(TARGET_CC)" \
		CFLAGS="$(TARGET_CFLAGS) $(TARGET_CPPFLAGS)" \
		LDFLAGS="$(TARGET_LDFLAGS)" \
		SOAPY=1
endef

define Package/pirate-websdr/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/pirate-websdr $(1)/usr/bin/pirate-websdr
endef

$(eval $(call BuildPackage,pirate-websdr))
