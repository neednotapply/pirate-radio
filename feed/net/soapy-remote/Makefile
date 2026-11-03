#
# SoapyRemote server: share the router's SDRs with SoapySDR clients on the
# network (SDR++, GQRX, CubicSDR, SDRangel, GNU Radio).
#
# This is free software, licensed under the GNU General Public License v2.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=soapy-remote
PKG_VERSION:=0.5.3
PKG_RELEASE:=1

PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/pothosware/SoapyRemote.git
PKG_SOURCE_VERSION:=baa92793181cd93e28b3dc926b744de4f67d2283
PKG_MIRROR_HASH:=b03323c5a46cac1f464080bf9ff90268b24ead9e861a4bfcaded15367d6b6a4d

PKG_LICENSE:=BSL-1.0
PKG_LICENSE_FILES:=LICENSE_1_0.txt

PKG_BUILD_DEPENDS:=soapysdr
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk

define Package/soapy-remote-server
  SECTION:=net
  CATEGORY:=Network
  TITLE:=SoapySDRServer (serve local SDRs over the network)
  URL:=https://github.com/pothosware/SoapyRemote
  DEPENDS:=+libsoapysdr +libpthread +librt
endef

define Package/soapy-remote-server/description
  SoapySDRServer makes this router's SDRs usable from any SoapySDR client
  on the network, on TCP port 55132. Samples cross the network in the
  device's native format, so the router does no sample conversion.
  Discovery over mDNS is not built; clients connect by address.
endef

# No Avahi (clients connect by address), and the router's init system is
# procd, not systemd. The upstream sysctl raises socket buffers to 100 MB,
# too much for a 128 MB router; pirate-radio sets its own limits.
CMAKE_OPTIONS += \
	-DENABLE_AVAHI=OFF \
	-DENABLE_SYSTEMD=OFF \
	-DENABLE_SYSCTL=OFF

define Package/soapy-remote-server/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_INSTALL_DIR)/usr/bin/SoapySDRServer $(1)/usr/bin/
endef

$(eval $(call BuildPackage,soapy-remote-server))
