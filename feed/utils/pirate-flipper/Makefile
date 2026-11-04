#
# pirate-flipper: a Flipper Zero plugged into the router's USB port, for the
# Pirate Radio UI's Flipper tab: its screen and buttons, its files and its
# details, on ubus as pirate.flipper (src/pirate-flipper.c). It speaks the
# Flipper's RPC protocol as qFlipper does, after the message definitions in
# flipperzero-protobuf; the code is this project's own (MIT).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-flipper
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/pirate-flipper
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=A Flipper Zero on the USB port, for the Pirate Radio UI
  URL:=https://github.com/flipperdevices/flipperzero-protobuf
  DEPENDS:=+libubus +libubox +kmod-usb-acm
endef

define Package/pirate-flipper/description
  Plugged into the router's USB port, a Flipper Zero shows on the Pirate
  Radio UI's Flipper tab: its screen, live, with its buttons to press; its
  files on the SD card and inside, to download, upload, rename and delete;
  its firmware, battery and the rest of what it reports. A small daemon
  holds the Flipper's RPC session (as qFlipper does on a computer) and
  offers it on ubus as pirate.flipper. Idle until a Flipper is plugged in.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall -Wextra $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/pirate-flipper $(PKG_BUILD_DIR)/pirate-flipper.c -lubus -lubox
endef

define Package/pirate-flipper/install
	# Its rpcd ACL comes with the UI (pirate-radio-ui), which uses it
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/pirate-flipper $(1)/usr/sbin/pirate-flipper
	$(INSTALL_BIN) ./files/pirate-flipper.init $(1)/etc/init.d/pirate-flipper
endef

$(eval $(call BuildPackage,pirate-flipper))
