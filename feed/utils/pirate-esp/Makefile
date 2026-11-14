#
# pirate-esp: an ESP32 board on the router's USB port, for the Pirate Radio
# UI (src/pirate-esp.c). For now, the flasher: it says what chip a board has
# and writes firmware to it, from the router, through the loader in the
# chip's ROM. The protocol is Espressif's, after esptool's documentation and
# source (GPL-2.0-or-later); the code is this project's own (MIT).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-esp
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/pirate-esp
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=An ESP32 board on the USB port, flashed from the router
  URL:=https://docs.espressif.com/projects/esptool/
  DEPENDS:=+kmod-usb-acm +kmod-usb-serial-cp210x +kmod-usb-serial-ch341
endef

define Package/pirate-esp/description
  Plugged into the router's USB port, an ESP32 board (the first ESP32, or
  an S2, S3, C2, C3, C5, C6, C61, H2 or P4; on the chip's own USB or through
  a USB-to-serial chip) is told apart by its chip and MAC address, and
  firmware is written to it and checked, from the router, as esptool would
  from a computer. Nothing runs until it is asked.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall -Wextra $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/pirate-esp $(PKG_BUILD_DIR)/pirate-esp.c
endef

define Package/pirate-esp/install
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/pirate-esp $(1)/usr/sbin/pirate-esp
endef

$(eval $(call BuildPackage,pirate-esp))
