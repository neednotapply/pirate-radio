#
# AIS-catcher: marine AIS receiver, built with the RTL-SDR, HackRF and SoapySDR
# backends so it can decode ships from a HackRF. rtl_ais (RTL-only) still
# handles the RTL-SDR path; AIS-catcher is used for the HackRF path.
#
# This is free software, licensed under the GNU General Public License v3.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=ais-catcher
PKG_VERSION:=0.70
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/jvde-github/AIS-catcher.git
PKG_SOURCE_VERSION:=v$(PKG_VERSION)
PKG_MIRROR_HASH:=skip

PKG_MAINTAINER:=pirate-radio
PKG_LICENSE:=GPL-3.0-or-later
PKG_LICENSE_FILES:=LICENSE

PKG_BUILD_DEPENDS:=librtlsdr hackrf soapysdr
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk

define Package/ais-catcher
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=Marine AIS receiver (RTL-SDR + HackRF + SoapySDR)
  DEPENDS:=+libstdcpp +librtlsdr +libhackrf +libsoapysdr +libusb-1.0
  URL:=https://github.com/jvde-github/AIS-catcher
endef

define Package/ais-catcher/description
  AIS-catcher decodes marine AIS (161.975 / 162.025 MHz). This build enables
  the RTL-SDR, HackRF and SoapySDR backends and is headless (no embedded web
  UI, database, TLS, ZeroMQ or NMEA2000).
endef

# Headless, lean: no web viewer/API, no SQLite/SSL/ZMQ/PostgreSQL/NMEA2000, no
# SOXR/libsamplerate/zlib. Keep RTL-SDR, HackRF and SoapySDR; drop the other
# radios (no libs for them in this image).
CMAKE_OPTIONS += \
	-DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
	-DRTLSDR=ON \
	-DHACKRF=ON \
	-DSOAPYSDR=ON \
	-DAIRSPY=OFF \
	-DAIRSPYHF=OFF \
	-DSDRPLAY=OFF \
	-DHYDRASDR=OFF \
	-DWEBVIEWER=OFF \
	-DAPI=OFF \
	-DSQLITE=OFF \
	-DOPENSSL=OFF \
	-DZMQ=OFF \
	-DPSQL=OFF \
	-DNMEA2000=OFF \
	-DSOXR=OFF \
	-DSAMPLERATE=OFF \
	-DZLIB=OFF

define Package/ais-catcher/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/AIS-catcher $(1)/usr/bin/AIS-catcher
endef

$(eval $(call BuildPackage,ais-catcher))
