#
# pirate-bluetooth: a Bluetooth dongle on the router's USB port, for the
# Pirate Radio UI's Bluetooth page: what it hears of the Bluetooth devices
# around, on ubus as pirate.bluetooth (src/pirate-bluetooth.c). It only
# listens (a passive scan). It speaks HCI to the kernel's adapter through an
# HCI socket and needs none of BlueZ; the code is this project's own (MIT).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-bluetooth
PKG_VERSION:=0.1.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/pirate-bluetooth
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=A Bluetooth dongle on the USB port, for the Pirate Radio UI
  DEPENDS:=+libubus +libubox +kmod-btusb
endef

define Package/pirate-bluetooth/description
  Plugged into the router's USB port, a Bluetooth dongle listens for the
  Bluetooth devices around, and the Pirate Radio UI's Bluetooth page shows
  them: each with its name, what kind of thing it is, who made it and how
  strongly it is heard. A small daemon has the kernel's adapter scan
  passively (it asks nothing of the devices it hears, and cannot be found
  itself) while a page looks, and passes what the adapter reports to the
  page as it is, on ubus as pirate.bluetooth; the page makes devices of it.
  Idle until a dongle is plugged in and a page looks.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall -Wextra $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/pirate-bluetooth $(PKG_BUILD_DIR)/pirate-bluetooth.c -lubus -lubox
endef

define Package/pirate-bluetooth/install
	# Its rpcd ACL comes with the UI (pirate-radio-ui), which uses it
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/etc/init.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/pirate-bluetooth $(1)/usr/sbin/pirate-bluetooth
	$(INSTALL_BIN) ./files/pirate-bluetooth.init $(1)/etc/init.d/pirate-bluetooth
endef

$(eval $(call BuildPackage,pirate-bluetooth))
