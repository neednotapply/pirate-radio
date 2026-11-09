#
# rtl_433 built with SoapySDR, so it can decode ISM-band sensors from a HackRF
# (-d driver=hackrf). Installed as /usr/bin/rtl_433-soapy under a distinct
# package name, so it does not collide with OpenWrt's RTL-only rtl_433 (which
# pirate-radio still uses for the RTL-SDR ISM path). Based on OpenWrt's
# utils/rtl_433 Makefile (GPL-2.0-or-later).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=rtl433-soapy
PKG_VERSION:=25.02
PKG_RELEASE:=1

PKG_SOURCE:=rtl_433-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/merbanan/rtl_433/tar.gz/$(PKG_VERSION)?
PKG_HASH:=5a409ea10e6d3d7d4aa5ea91d2d6cc92ebb2d730eb229c7b37ade65458223432
# The tarball unpacks to rtl_433-<version>, not rtl433-soapy-<version>.
PKG_BUILD_DIR:=$(BUILD_DIR)/rtl_433-$(PKG_VERSION)

PKG_MAINTAINER:=pirate-radio
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=COPYING

PKG_BUILD_DEPENDS:=soapysdr
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk

define Package/rtl433-soapy
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=ISM-band receiver rtl_433 with SoapySDR (HackRF)
  DEPENDS:=+librtlsdr +rtl-sdr +libtool-bin +libsoapysdr
  URL:=https://github.com/merbanan/rtl_433
endef

define Package/rtl433-soapy/description
  rtl_433 built with SoapySDR enabled, so it can decode 433/868/915 MHz
  ISM-band sensors from a HackRF (-d driver=hackrf) as well as an RTL-SDR.
  Installed as /usr/bin/rtl_433-soapy.
endef

CMAKE_OPTIONS += \
	-DFORCED_GIT_DIR=$(PKG_BUILD_DIR)/.git \
	-DENABLE_SOAPYSDR=ON \
	-DENABLE_OPENSSL=OFF

define Package/rtl433-soapy/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/rtl_433 $(1)/usr/bin/rtl_433-soapy
endef

$(eval $(call BuildPackage,rtl433-soapy))
