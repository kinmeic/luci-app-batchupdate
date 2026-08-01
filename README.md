# luci-app-batchupdate

[![Build and Release](https://github.com/kinmeic/luci-app-batchupdate/actions/workflows/build.yml/badge.svg)](https://github.com/kinmeic/luci-app-batchupdate/actions/workflows/build.yml)

OpenWrt LuCI 应用：一键批量升级所有可更新的软件包，并支持通过黑名单跳过指定软件包。

同时兼容 `opkg`（OpenWrt 23.05 及更早版本）和 `apk`（OpenWrt 24.10+ / snapshot），自动检测系统上可用的包管理器。

## 功能

- 列出所有可更新的软件包（包名 / 当前版本 / 可更新版本）
- **一键批量升级**：后台异步执行，页面实时显示进度、完整日志和结果统计（已升级 / 失败 / 跳过）
- 支持单独升级某个软件包
- **手动安装软件包**：根据系统包管理器上传 `.ipk` 或 `.apk` 到 `/tmp`，可选强制重装、降级和忽略空间检查参数，并直接查看安装结果
- **黑名单**：被拉黑的软件包在批量升级和单独升级时都会被跳过；可直接从软件包列表一键加入黑名单
- 刷新页面或中途离开后可自动接上正在进行中的升级任务
- 防止并发执行（目录锁 + PID 检测）
- 简体中文界面翻译

## 要求

- OpenWrt 21.02 或更新版本（基于 JavaScript 的新式 LuCI）
- `luci-base`
- 系统上有 `opkg` 或 `apk`

## 安装

### 方式一：从 GitHub Release 下载（推荐）

在 [Releases](https://github.com/kinmeic/luci-app-batchupdate/releases) 页面下载对应包管理器的安装包（包为架构无关，`all`，适用于所有设备）：

```sh
# opkg 系统（OpenWrt 24.10 及更早版本）
opkg install luci-app-batchupdate_*.ipk
opkg install luci-i18n-batchupdate-zh-cn_*.ipk   # 中文翻译

# apk 系统（OpenWrt 25.12 及更新版本 / snapshot）
apk add --allow-untrusted luci-app-batchupdate-*.apk
apk add --allow-untrusted luci-i18n-batchupdate-zh-cn-*.apk   # 中文翻译
```

### 方式二：用 OpenWrt SDK / buildroot 编译

```sh
# 将本仓库放入 buildroot 的 package 目录
cd /path/to/openwrt
git clone https://github.com/kinmeic/luci-app-batchupdate.git package/luci-app-batchupdate

make menuconfig   # 在 LuCI -> Applications 中选中 luci-app-batchupdate
make package/luci-app-batchupdate/compile
```

生成的安装包位于 `bin/packages/*/luci/`，拷贝到路由器上安装。

### 方式三：直接拷贝文件（手动安装）

```sh
# 在路由器上执行，假设仓库文件已上传到 /tmp/luci-app-batchupdate
cd /tmp/luci-app-batchupdate
cp -r root/* /
cp -r htdocs/luci-static/resources/view/batchupdate /www/luci-static/resources/view/

chmod +x /usr/bin/batchupdate
rm -rf /tmp/luci-modulecache /tmp/luci-indexcache*
/etc/init.d/rpcd restart
```

安装后在 LuCI 的 **系统 → 批量更新** 菜单中打开。

## 使用

- **刷新软件包列表**：后台执行 `opkg update` / `apk update` 并重新列出可更新的软件包
- **一键升级全部**：升级所有可更新的软件包（自动跳过黑名单），逐个升级以隔离失败，页面实时滚动日志
- **手动安装软件包**：上传与系统包管理器匹配的 `.ipk` / `.apk` 文件，选择所需安装参数后查看完整安装输出
- **加入 / 移出黑名单**：在软件包列表的行按钮上操作，或在黑名单面板中手动输入包名

## 配置

黑名单保存在 UCI 配置 `/etc/config/batchupdate` 中，也可以直接编辑：

```
config main 'main'
	list blacklist 'kmod-ath9k'
	list blacklist 'base-files'
```

修改后无需重启任何服务，下次升级时生效。

## 工作原理

```
LuCI JS 视图 (overview.js)
    │  fs.exec（ubus file.exec，受 rpcd ACL 控制）
    ▼
/usr/bin/batchupdate（后端 shell 脚本）
    ├── list       → 解析 opkg list-upgradable / apk list --upgradable，输出 JSON
    ├── start      → 后台执行：刷新列表 → 过滤黑名单 → 逐个升级，写状态/日志到 /tmp/batchupdate/
    ├── install    → 安装上传至 /tmp 的 ipk/apk，并校验允许的安装参数
    ├── refresh    → 后台刷新软件包列表
    ├── status/log → 供前端每 3 秒轮询进度
    └── blacklist  → 读写 UCI 黑名单
```

## 安全说明

- 所有后端调用都通过 `/usr/share/rpcd/acl.d/luci-app-batchupdate.json` 最小化授权，仅允许执行指定的命令组合
- 黑名单包名做了字符集校验（`[A-Za-z0-9._+-]`），杜绝注入
- 页面有醒目警告：**在运行中的系统上批量升级软件包存在风险**（尤其涉及 `base-files`、内核模块等核心包时可能导致系统不稳定甚至变砖），请谨慎操作并确保闪存剩余空间充足。建议把不想动的核心包加入黑名单

## 目录结构

```
├── Makefile                                    # OpenWrt 包定义（luci.mk）
├── htdocs/luci-static/resources/view/batchupdate/overview.js   # LuCI 前端视图
├── root/
│   ├── etc/config/batchupdate                  # UCI 配置（黑名单）
│   ├── usr/bin/batchupdate                     # 后端脚本（opkg/apk 自适应）
│   ├── usr/share/luci/menu.d/                  # 菜单注册
│   └── usr/share/rpcd/acl.d/                   # RPC 权限
└── po/
    ├── templates/batchupdate.pot               # 翻译模板
    └── zh_Hans/batchupdate.po                  # 简体中文翻译
```

## License

MIT，详见 [LICENSE](LICENSE)。
