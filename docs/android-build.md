# Folia Android（Capacitor）构建与使用

> 本文档说明如何把 Folia Web 前端打包为可安装的 Android APK，以及该版本的能力边界。
> 技术路线见 [技术说明](technical.md)；适配进度见仓库根目录 `ANDROID_ADAPTATION_PROGRESS.md`。

## 概述

Android 版采用 **Capacitor 混合方案**：复用 Folia 的 Web 前端，把原本依赖 Node 后端的能力内嵌为浏览器侧 shim，因此 APK 自包含、无需常驻服务器。

- 后端 shim：网易云加密与路由在假 origin `https://folia-ncm.local` 下重放（`src/mobile/neteaseShim/`），网络请求经 `CapacitorHttp` 原生通道发出，全局绕开 WebView 的 CORS 限制。
- 本地音乐库：通过 SAF（Storage Access Framework）选取目录，代码层模拟 File System Access API，前端导入/快照/恢复逻辑几乎零改动（`src/mobile/localFs/`）。
- 本地封面：Service Worker 路由在 WebView 中不可用，改走 OPFS + blob URL（`localCoverAssetUrl.ts` 原生分支）。
- 后台播放：原生前台服务 + MediaSession（`FoliaPlaybackService` / `FoliaPlaybackPlugin`）。

功能范围：在线搜索与播放（网易云 / 酷狗）、全屏沉浸式歌词动画、本地音乐库。

## 许可证

`folia-major` 为 **AGPL-3.0**。任何基于本项目的 Android 分发版本都必须同样以 AGPL-3.0 发布，并保留版权与来源声明。详见根目录 `LICENSE`。

## 环境要求

| 依赖 | 版本 / 说明 |
| --- | --- |
| Node.js | `>= 24`（见 `package.json` 的 `engines`） |
| JDK | 17 或更高（Gradle / Android Gradle Plugin 要求） |
| Android SDK | Platform 36、Build-Tools 对应版本；设置 `ANDROID_HOME` / `ANDROID_SDK_ROOT` |
| Capacitor CLI | 已在 `devDependencies`（`@capacitor/cli`），用 `npx cap` 调用 |

## 构建步骤

```bash
# 1. 安装依赖
npm install

# 2. 生成 Capacitor 专用 Web 产物（相对 base、不注册 PWA Service Worker）
#    Windows PowerShell:
$env:CAPACITOR='true'; npx vite build
#    macOS / Linux / 或使用 cross-env（已内置）:
npx cross-env CAPACITOR=true vite build

# 3. 同步 Web 产物与插件到原生工程
npx cap sync android

# 4. 构建 APK
cd android
./gradlew assembleDebug          # Windows: .\gradlew.bat assembleDebug
```

产物路径：`android/app/build/outputs/apk/debug/app-debug.apk`。
发布版使用 `gradlew assembleRelease`，并配置好签名（`android/app/build.gradle` 中的 signingConfig）。

调试时也可在 `android/` 目录执行 `./gradlew installDebug`，或用 `npx cap open android` 打开 Android Studio。

## 运行时配置

- **远程 API Origin（AI 配色主题 / 歌词分词）**：这两类能力需要一个可访问的远程后端。若已有自部署实例，在应用的「设置」中填写其 Origin；未配置时前端会自动降级（返回 503 走既有降级路径）。
- **酷狗自建后端**：默认仅匿名搜索 + legacy playInfo。如自建了 KuGouMusicApi 后端，可在 WebView 控制台写入 `localStorage['folia.mobile.kugouApiBase'] = '<你的后端地址>'` 后重启应用。
- **通知权限**：Android 13（API 33）及以上，首次启动会请求通知权限，用于显示后台播放的系统媒体通知。

## 主题与配色

与 Web 版一致；本版本不启用 Folium 模组系统（仅桌面版可用）。

## 权限说明

`AndroidManifest.xml` 中声明的主要权限：

| 权限 | 用途 |
| --- | --- |
| `INTERNET` / `ACCESS_NETWORK_STATE` | 在线搜索与播放、封面/歌词加载 |
| `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK` | 后台播放前台服务 |
| `POST_NOTIFICATIONS` | 系统媒体通知（Android 13+） |
| `WAKE_LOCK` | 播放期间保持唤醒 |

本地音乐库通过 SAF 授权读取，不申请宽泛的存储权限。

## 已知限制

1. **scrobble（听歌打卡）**：接口已打桩为成功但不上报。
2. **AI 端点**：需要自部署远程后端并在应用中配置 Origin，否则相关功能不可用。
3. **转码格式**：`alac` / `ape` / `wma` 等需要转码的格式不支持（与原 Web 版一致）。
4. **自动扫描**：`FileSystemObserver` 在 WebView 不可用，本地曲库变更后需手动重新同步（`resyncAllFolders` 已适配 SAF）。
5. **后台播放封面**：系统媒体通知的封面仅支持可公开访问的 `http(s)` 图片；本地曲库的 blob URL 无法过桥给原生层，故不显示。
6. **大曲库扫描性能**：SAF 的 `DocumentFile` 递归是逐目录 IPC，千级文件规模可接受，超大曲库首次扫描会偏慢。

## 常见问题

- **构建时提示找不到 Android SDK**：确认已安装 SDK 且 `ANDROID_HOME`（或 `ANDROID_SDK_ROOT`）指向 SDK 根目录，并在 `android/local.properties` 写入 `sdk.dir=<路径>`。
- **首次 `gradlew` 下载缓慢**：Gradle 发行版与依赖来自境外源，可配置镜像或使用代理。
- **应用内页面空白**：确认第 2 步使用了 `CAPACITOR=true` 构建（该模式才会生成相对路径的产物）；普通 Web 产物使用绝对路径，无法在 APK 内加载。
- **后台播放无声**：确认已授予通知权限，且系统未对应用启用「电池优化 / 后台限制」。
