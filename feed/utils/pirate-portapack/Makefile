#
# pirate-portapack: a HackRF/PortaPack on Mayhem firmware, in its device
# (console) mode, plugged into the router's USB port, for the Pirate Radio
# UI's PortaPack tab: its screen and buttons, its files and its details, as
# hackrf.app (MayhemHub) shows them. On ubus as pirate.portapack
# (src/pirate-portapack.c). It speaks Mayhem's own serial command shell; the
# code is this project's own (GPL-2.0, as Mayhem and MayhemHub are).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-portapack
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-or-later

include $(INCLUDE_DIR)/package.mk

define Package/pirate-portapack
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=A PortaPack (Mayhem) on the USB port, for the Pirate Radio UI
  URL:=https://github.com/portapack-mayhem/MayhemHub
  DEPENDS:=+libubus +libubox +kmod-usb-acm
endef

define Package/pirate-portapack/description
  A HackRF with a PortaPack running Mayhem firmware, in its "device" (console)
  mode, plugged into the router's USB port, shows on the Pirate Radio UI's
  PortaPack tab: its screen, live, with its buttons and touch; its files on the
  SD card, to download, upload, make folders in and delete; its details; and a
  firmware updater, as hackrf.app (MayhemHub) has them on a computer. It can
  also switch the PortaPack into HackRF mode for the SDR jobs. A small daemon
  holds Mayhem's serial command shell and offers it on ubus as pirate.portapack.
  Idle until a PortaPack in device mode is plugged in.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall -Wextra $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/pirate-portapack $(PKG_BUILD_DIR)/pirate-portapack.c -lubus -lubox
endef

define Package/pirate-portapack/install
	# Its rpcd ACL comes with the UI (pirate-radio-ui), which uses it
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/pirate-portapack $(1)/usr/sbin/pirate-portapack
	$(INSTALL_BIN) ./files/pirate-portapack.init $(1)/etc/init.d/pirate-portapack
endef

$(eval $(call BuildPackage,pirate-portapack))
