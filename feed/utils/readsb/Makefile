#
# readsb: Mode S / ADS-B decoder (wiedehopf's fork), built with the RTL-SDR and
# SoapySDR backends so it can decode ADS-B from a HackRF
# (--device-type soapysdr --device driver=hackrf). dump1090 (RTL-only) still
# handles the RTL-SDR path; readsb is used only for the HackRF path and writes
# the same aircraft.json, so the existing dump1090 map keeps working.
#
# This is free software, licensed under the GNU General Public License v2.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=readsb
PKG_VERSION:=3.16.21
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/wiedehopf/readsb.git
PKG_SOURCE_VERSION:=v$(PKG_VERSION)
PKG_MIRROR_HASH:=skip

PKG_MAINTAINER:=pirate-radio
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=LICENSE

PKG_BUILD_DEPENDS:=librtlsdr soapysdr
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

define Package/readsb
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=ADS-B / Mode S decoder (readsb, RTL-SDR + SoapySDR/HackRF)
  DEPENDS:=+librtlsdr +libsoapysdr +libusb-1.0 +zlib +libzstd
  URL:=https://github.com/wiedehopf/readsb
endef

define Package/readsb/description
  readsb is a Mode S / ADS-B decoder (a maintained dump1090 successor). This
  build enables the RTL-SDR and SoapySDR backends, so it can receive from a
  HackRF (--device-type soapysdr --device driver=hackrf). It writes
  dump1090-compatible aircraft.json.
endef

# readsb is a plain GNU Makefile. Build only readsb (not the ncurses viewadsb,
# via DISABLE_INTERACTIVE) with the RTL-SDR and SoapySDR backends. OPTIMIZE is
# cleared so it does not add host-specific -march flags over our target CFLAGS.
define Build/Prepare
	$(call Build/Prepare/Default)
	# The exported tree has no .git; give the Makefile a version to print.
	echo "$(PKG_VERSION)" > $(PKG_BUILD_DIR)/version
endef

define Build/Compile
	+$(MAKE) $(PKG_JOBS) -C $(PKG_BUILD_DIR) \
		CC="$(TARGET_CC)" \
		PKG_CONFIG="$(PKG_CONFIG)" \
		CFLAGS="$(TARGET_CFLAGS) $(TARGET_CPPFLAGS)" \
		LDFLAGS="$(TARGET_LDFLAGS)" \
		OPTIMIZE="" \
		RTLSDR=yes \
		SOAPYSDR=yes \
		DISABLE_INTERACTIVE=yes \
		readsb
endef

define Package/readsb/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/readsb $(1)/usr/bin/readsb
endef

$(eval $(call BuildPackage,readsb))
