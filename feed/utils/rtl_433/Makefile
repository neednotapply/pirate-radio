#
# rtl_433 built with SoapySDR support, so it can decode ISM-band sensors from a
# HackRF (driver=hackrf) as well as from an RTL-SDR. OpenWrt's own utils/rtl_433
# package builds with -DENABLE_SOAPYSDR=NO; this overrides it under the same
# name, with a higher release so the ImageBuilder and apk prefer this build.
# Based on OpenWrt's utils/rtl_433 Makefile (GPL-2.0-or-later).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=rtl_433
PKG_VERSION:=25.02
# Ahead of OpenWrt's release (its -r2) so apk picks this SoapySDR-enabled build
# over the stock RTL-only one in the ImageBuilder's package resolution.
PKG_RELEASE:=10

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/merbanan/rtl_433/tar.gz/$(PKG_VERSION)?
PKG_HASH:=5a409ea10e6d3d7d4aa5ea91d2d6cc92ebb2d730eb229c7b37ade65458223432

PKG_MAINTAINER:=pirate-radio
PKG_LICENSE:=GPL-2.0-or-later
PKG_LICENSE_FILES:=COPYING
PKG_CPE_ID:=cpe:/a:rtl_433_project:rtl_433

PKG_BUILD_DEPENDS:=soapysdr
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk

define Package/rtl_433
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Generic ISM-band data receiver (RTL-SDR + SoapySDR/HackRF)
  DEPENDS:=+librtlsdr +rtl-sdr +libtool-bin +libsoapysdr
  URL:=https://github.com/merbanan/rtl_433
endef

define Package/rtl_433/description
  rtl_433 (despite the name) is a generic data receiver for the 433.92 MHz,
  868 MHz, 315/345 MHz and 915 MHz ISM bands. This build enables SoapySDR, so
  it can receive from a HackRF (-d driver=hackrf) as well as an RTL-SDR.
endef

CMAKE_OPTIONS += \
	-DFORCED_GIT_DIR=$(PKG_BUILD_DIR)/.git \
	-DENABLE_SOAPYSDR=ON \
	-DENABLE_OPENSSL=OFF

# Only the binary; pirate-radio drives rtl_433 directly, so skip OpenWrt's
# rtl_433 init service, UCI config and /etc/rtl_433 flavor configs.
define Package/rtl_433/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(CP) $(PKG_INSTALL_DIR)/usr/bin/rtl_433 $(1)/usr/bin
endef

$(eval $(call BuildPackage,rtl_433))
