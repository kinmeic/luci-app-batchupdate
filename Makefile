#
# Copyright (C) 2026 luci-app-batchupdate authors
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Batch Package Updater
LUCI_DESCRIPTION:=One-click upgrade of all upgradable packages with a configurable blacklist.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

PKG_LICENSE:=MIT

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
