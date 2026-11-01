#
# slate-sdr: receiver jobs for a GL-AR750S with an RTL-SDR and a HackRF on
# USB, logging to the microSD card.
#
# This is free software, licensed under the MIT license.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=slate-sdr
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/slate-sdr
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=SDR receiver jobs (ADS-B, ISM, AIS, sweeps, IQ, Wi-Fi spectral) to microSD
  DEPENDS:=+rtl-sdr +rtl_433 +dump1090 +rtl-ais +hackrf \
	+soapy-remote-server +soapy-hackrf +soapy-rtlsdr +soapysdr-util \
	+iw +block-mount +uhttpd +jsonfilter
  PKGARCH:=all
endef

define Package/slate-sdr/description
  Runs receivers on an RTL-SDR and a HackRF from /etc/config/slate-sdr:
  a SoapySDR network server, rtl_tcp, ADS-B (dump1090), ISM sensors
  (rtl_433), AIS (rtl_ais), spectrum sweeps (rtl_power, hackrf_sweep),
  SigMF raw IQ recording and the Wi-Fi radios' spectral scan, writing to
  the microSD card. Status page at /cgi-bin/slate-sdr.
endef

define Package/slate-sdr/conffiles
/etc/config/slate-sdr
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/slate-sdr/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/uci-defaults $(1)/etc/sysctl.d
	$(INSTALL_CONF) ./files/slate-sdr.config $(1)/etc/config/slate-sdr
	$(INSTALL_BIN) ./files/slate-sdr.init $(1)/etc/init.d/slate-sdr
	$(INSTALL_DIR) $(1)/etc/hotplug.d/usb
	$(INSTALL_DATA) ./files/slate-sdr.hotplug $(1)/etc/hotplug.d/usb/20-slate-sdr
	$(INSTALL_BIN) ./files/slate-sdr.defaults $(1)/etc/uci-defaults/90-slate-sdr
	$(INSTALL_DATA) ./files/slate-sdr.sysctl $(1)/etc/sysctl.d/20-slate-sdr.conf
	$(INSTALL_DIR) $(1)/usr/libexec $(1)/usr/sbin $(1)/usr/share/slate-sdr
	$(INSTALL_BIN) ./files/job.sh $(1)/usr/libexec/slate-sdr-job
	$(INSTALL_BIN) ./files/slate-sdr.cli $(1)/usr/sbin/slate-sdr
	$(INSTALL_DATA) ./files/lib.sh $(1)/usr/share/slate-sdr/lib.sh
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) ./files/status.cgi $(1)/www/cgi-bin/slate-sdr
	$(INSTALL_DIR) $(1)/mnt/sdcard
	$(INSTALL_DATA) ./files/NO-SD-CARD.txt $(1)/mnt/sdcard/NO-SD-CARD.txt
endef

$(eval $(call BuildPackage,slate-sdr))
