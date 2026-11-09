#
# readsb (wiedehopf's fork) built with the RTL-SDR and SoapySDR backends, so it
# can decode ADS-B from a HackRF (--device-type soapysdr --soapy-device
# driver=hackrf). Installed as /usr/bin/readsb-soapy under a distinct package
# name, so it does not collide with OpenWrt's RTL-only readsb (Mictronics
# 3.9.0, which has no SoapySDR). pirate-radio uses this only for the HackRF
# ADS-B path; dump1090 still handles the RTL-SDR, and readsb writes the same
# aircraft.json so the map is unchanged.
#
# This is free software, licensed under the GNU General Public License v3.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=readsb-soapy
PKG_VERSION:=3.16.21
PKG_RELEASE:=1

# Release tarball (like rtl433-soapy); the git proto failed to fetch in CI.
PKG_SOURCE:=readsb-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/wiedehopf/readsb/tar.gz/v$(PKG_VERSION)?
PKG_HASH:=skip
# The tarball unpacks to readsb-<version>, not readsb-soapy-<version>.
PKG_BUILD_DIR:=$(BUILD_DIR)/readsb-$(PKG_VERSION)

PKG_MAINTAINER:=pirate-radio
PKG_LICENSE:=GPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE

# readsb bundles its own argp.c, so no argp-standalone is needed. SoapySDR
# headers for the backend.
PKG_BUILD_DEPENDS:=librtlsdr soapysdr
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

define Package/readsb-soapy
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=ADS-B / Mode S decoder (readsb, RTL-SDR + SoapySDR/HackRF)
  DEPENDS:=+librtlsdr +libsoapysdr +libusb-1.0 +zlib +libzstd
  URL:=https://github.com/wiedehopf/readsb
endef

define Package/readsb-soapy/description
  wiedehopf's readsb (a maintained dump1090 successor) built with the RTL-SDR
  and SoapySDR backends, so it can decode ADS-B from a HackRF (--device-type
  soapysdr --soapy-device driver=hackrf). Writes dump1090-compatible
  aircraft.json. Installed as /usr/bin/readsb-soapy.
endef

# readsb is a plain GNU Makefile that adds its -D version macros with CFLAGS +=,
# so passing CFLAGS= on the make line would clobber them (dropping
# READSB_SHORT_VERSION and failing to compile). Inject the cross flags through
# CC instead; readsb's own CFLAGS then survive. READSB_SHORT_VERSION comes from
# a `version` file, which the tarball lacks, so write one. Build only readsb
# (not the ncurses viewadsb, via DISABLE_INTERACTIVE).
define Build/Prepare
	$(call Build/Prepare/Default)
	echo "$(PKG_VERSION)" > $(PKG_BUILD_DIR)/version
endef

define Build/Compile
	+$(MAKE) $(PKG_JOBS) -C $(PKG_BUILD_DIR) \
		CC="$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_CPPFLAGS)" \
		PKG_CONFIG="$(PKG_CONFIG)" \
		OPTIMIZE="" \
		RTLSDR=yes \
		SOAPYSDR=yes \
		DISABLE_INTERACTIVE=yes \
		readsb
endef

define Package/readsb-soapy/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/readsb $(1)/usr/bin/readsb-soapy
endef

$(eval $(call BuildPackage,readsb-soapy))
