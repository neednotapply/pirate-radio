#
# pirate-radio: receiver jobs for a GL-AR750S with an RTL-SDR and a HackRF on
# USB, logging to the microSD card.
#
# This is free software, licensed under the MIT license.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-radio
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/pirate-radio
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=SDR receiver jobs (ADS-B, ISM, AIS, sweeps, IQ, Wi-Fi spectral) to microSD
  DEPENDS:=+rtl-sdr +rtl_433 +dump1090 +rtl-ais +hackrf \
	+soapy-remote-server +soapy-hackrf +soapy-rtlsdr +soapysdr-util \
	+iw +block-mount +uhttpd +jsonfilter
  PKGARCH:=all
endef

define Package/pirate-radio/description
  Runs receivers on an RTL-SDR and a HackRF from /etc/config/pirate-radio:
  a SoapySDR network server, rtl_tcp, ADS-B (dump1090), ISM sensors
  (rtl_433), AIS (rtl_ais), spectrum sweeps (rtl_power, hackrf_sweep),
  SigMF raw IQ recording and the Wi-Fi radios' spectral scan, writing to
  the microSD card. Status page at /cgi-bin/pirate-radio.
endef

define Package/pirate-radio/conffiles
/etc/config/pirate-radio
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/pirate-radio/install
	$(INSTALL_DIR) $(1)/etc/config $(1)/etc/init.d $(1)/etc/uci-defaults $(1)/etc/sysctl.d
	$(INSTALL_CONF) ./files/pirate-radio.config $(1)/etc/config/pirate-radio
	$(INSTALL_BIN) ./files/pirate-radio.init $(1)/etc/init.d/pirate-radio
	$(INSTALL_DIR) $(1)/etc/hotplug.d/usb
	$(INSTALL_DATA) ./files/pirate-radio.hotplug $(1)/etc/hotplug.d/usb/20-pirate-radio
	$(INSTALL_BIN) ./files/pirate-radio.migrate $(1)/etc/uci-defaults/10-pirate-radio-migrate
	$(INSTALL_BIN) ./files/pirate-radio.defaults $(1)/etc/uci-defaults/90-pirate-radio
	$(INSTALL_DATA) ./files/pirate-radio.sysctl $(1)/etc/sysctl.d/20-pirate-radio.conf
	$(INSTALL_DIR) $(1)/usr/libexec $(1)/usr/sbin $(1)/usr/share/pirate-radio
	$(INSTALL_BIN) ./files/job.sh $(1)/usr/libexec/pirate-radio-job
	$(INSTALL_BIN) ./files/pirate-radio.cli $(1)/usr/sbin/pirate-radio
	$(INSTALL_DATA) ./files/lib.sh $(1)/usr/share/pirate-radio/lib.sh
	$(INSTALL_DIR) $(1)/www/cgi-bin
	$(INSTALL_BIN) ./files/status.cgi $(1)/www/cgi-bin/pirate-radio
	$(INSTALL_DIR) $(1)/mnt/sdcard
	$(INSTALL_DATA) ./files/NO-SD-CARD.txt $(1)/mnt/sdcard/NO-SD-CARD.txt
endef

$(eval $(call BuildPackage,pirate-radio))
