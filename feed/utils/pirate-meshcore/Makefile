#
# pirate-meshcore: a MeshCore radio plugged into the router's USB port, for
# the Pirate Radio UI's Messenger tab: its contacts and channels, messages
# to and from them and their delivery, its adverts and settings, and its
# GPS's position for the Wi-Fi survey; on ubus as pirate.meshcore
# (src/pirate-meshcore.c). It speaks MeshCore's companion protocol over USB,
# after MeshCore's own documentation and firmware (MIT); the code is this
# project's own (MIT).
#

include $(TOPDIR)/rules.mk

PKG_NAME:=pirate-meshcore
PKG_VERSION:=0.4.0
PKG_RELEASE:=1

PKG_LICENSE:=MIT

include $(INCLUDE_DIR)/package.mk

define Package/pirate-meshcore
  SECTION:=utils
  CATEGORY:=Utilities
  TITLE:=A MeshCore radio on the USB port, for the Pirate Radio UI
  URL:=https://github.com/meshcore-dev/MeshCore
  DEPENDS:=+libubus +libubox +kmod-usb-acm
endef

define Package/pirate-meshcore/description
  Plugged into the router's USB port, a MeshCore radio running a companion
  build for USB (such as LilyGo's T-Echo) is the Pirate Radio UI's
  Messenger: its contacts and channels, messages to and from them with
  their delivery, its adverts, name and GPS, as MeshCore's app has them on
  a phone. Messages are kept on the router. With its GPS on, the radio's
  position tags the Wi-Fi survey's sightings. Idle until one is plugged in.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Configure
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CPPFLAGS) $(TARGET_CFLAGS) -Wall -Wextra $(TARGET_LDFLAGS) \
		-o $(PKG_BUILD_DIR)/pirate-meshcore $(PKG_BUILD_DIR)/pirate-meshcore.c -lubus -lubox
endef

define Package/pirate-meshcore/install
	# Its rpcd ACL comes with the UI (pirate-radio-ui), which uses it
	$(INSTALL_DIR) $(1)/usr/sbin $(1)/etc/init.d $(1)/lib/upgrade/keep.d
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/pirate-meshcore $(1)/usr/sbin/pirate-meshcore
	$(INSTALL_BIN) ./files/pirate-meshcore.init $(1)/etc/init.d/pirate-meshcore
	# The messages, kept through a flash that keeps settings
	$(INSTALL_DATA) ./files/pirate-meshcore.keep $(1)/lib/upgrade/keep.d/pirate-meshcore
endef

$(eval $(call BuildPackage,pirate-meshcore))
