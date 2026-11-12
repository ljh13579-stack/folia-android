# Folia Android 适配 — 进度记录（2026-10-16）

> 本文档记录 Capacitor 安卓适配的当前进度，供下次会话直接续作。
> 技术路线：Capacitor 混合方案（复用 Web 前端，内嵌 API shim，SAF 本地曲库）。
> 功能范围：在线搜索+播放（网易云/酷狗）、全屏沉浸式歌词动画、本地音乐库。
> 许可证约束：folia-major 为 AGPL-3.0，本适配版本必须同样以 AGPL-3.0 发布。

## 已完成

### 1. Capacitor 工程骨架
- `capacitor.config.ts`：appId `top.izuna.foliamajor`，webDir `dist`，`CapacitorHttp.enabled=true`（原生 OkHttp 替换 fetch，全局绕开 WebView CORS），https scheme + cleartext，StatusBar 不叠加 WebView。
- `android/` 已生成；`AndroidManifest.xml` 已加网络/媒体/前台服务权限与 `network_security_config.xml`（允许明文流量）。
- `src/mobile/platform.ts`：`isNativeMobile() / isAndroid() / isElectronRuntime() / getFoliaPlatform()`。

### 2. 网易云内嵌后端 shim（替代 Node 后端，APK 自包含）
- `src/mobile/neteaseShim/crypto.ts`：weapi（AES-CBC×2 + BigInt 裸 RSA）、eapi（MD5 + AES-ECB）、linuxapi 常量齐全；APP_CONF.encrypt=true 时默认 crypto 解析为 eapi，encryptResponse=false（响应是明文 JSON）。
- `src/mobile/neteaseShim/request.ts`：createNcmRequest 完整移植（OS_MAP、UA、设备 ID、匿名 token、cookie 处理、`harvestSetCookies` 从原生通道读 Set-Cookie、SPECIAL_STATUS_CODES）。
- `src/mobile/neteaseShim/routes.ts`：40 个路由。未移植 xeapi（X25519/AES-GCM）：register/anonimous 走 weapi，song/url/v1 走经典 eapi，scrobble/v1 打桩成功。
- `src/mobile/neteaseShim/index.ts`：fetch 拦截器，三分支——`https://folia-ncm.local`（网易云 shim）、`/api/lyric-proxy`（白名单直连，含 u.y.qq.com 客户端伪装）、`/api/generate-theme*`、`/api/segment-lyrics` 等 AI 端点（配置了远程 API Origin 则转发，否则 503 走前端既有降级）。
- `src/index.tsx` 最先安装 shim；`src/services/netease.ts` 的 `getApiBase()` 原生分支返回 shim origin；`kugouTransport.ts` 原生分支报 configured:true（匿名搜索 + legacy playInfo 经 lyric-proxy 可用），支持 localStorage `folia.mobile.kugouApiBase` 覆盖。

### 3. 本地音乐库（SAF 方案，本次会话主体）
- `src/mobile/localFs/safPlugin.ts`：Kotlin/Java 插件 `FoliaFs` 的 JS 类型（pickDirectory/scanTree/readFileRange/checkPermission，区间读取 base64 返回）。
- `src/mobile/localFs/safHandles.ts`：模拟 File System Access API——
  - `SafLazyBlob`/`SafLazyFile`：不持字节，`slice` 返回懒 Blob，`arrayBuffer/text` 走原生区间读取（strtok3 只用 `slice().arrayBuffer()`，故元数据解析全程按需读）；>8 MiB 自动分块（插件硬上限 32 MiB）；`materialize()` 全量物化。
  - `SafDirectoryHandle`/`SafFileHandle`：values/getDirectoryHandle/getFileHandle/queryPermission/requestPermission/isSameEntry；首次访问子项才触发一次整树 scanTree（扫描结果按父路径分桶共享）。
  - 描述符持久化用 localStorage `folia.mobile.safDirHandles`（句柄不能结构化克隆）。
- `src/services/db.ts`：`saveDirHandles/getDirHandles` 原生分支——存取 SAF 描述符、读取时重建句柄（`deleteDirHandle` 复用这两个函数，自动兼容）。
- `src/services/localMusicService.ts`：
  - `getImportDirectoryHandle` 原生分支走 `FoliaFs.pickDirectory()`；
  - `getAccessibleFileHandle` 校验 `getFile` 是否为函数（SAF 句柄入库后结构化克隆退化为普通对象，会话恢复后落到从描述符重建的恢复路径）；
  - `getAudioFromFile` 对 SafLazyFile 先 materialize 再建 blob URL。
- `src/workers/metadataParserCore.ts`：从 metadataParser.worker.ts 抽出的纯解析逻辑（worker 已改为薄封装）。`localMetadataWorkerClient.parseEmbeddedMetadataAsync` 对 SafLazyFile 改走主线程解析（无法结构化克隆进 worker）；**FLAC + includeCover 时先 materialize**（repairFlacMetadata 修复路径会把 slice 结果拼进新 Blob，懒 Blob 无真实字节会拼出空数据）。
- `src/services/localLibraryAvailability.ts`：原生分支直接 supported:true。

### 4. 本地封面（Capacitor 分支）
- `/__folia_cover/` 由 PWA Service Worker 回答，但 WebView 资源加载被 Capacitor 本地服务器接管、不经 SW → 不可靠。
- `localCoverBinaryStore.ts` 新增导出 `readLocalCoverBinary(assetId)`（OPFS 读 Blob）。
- `localCoverAssetUrl.ts` 原生分支：OPFS 读取 + blob URL 缓存（LRU 300 条，淘汰时 revokeObjectURL）；同步签名不变，未水合返回 null 并后台补水，完成后以 250ms 合并广播 `folia-local-music-updated` 触发一次重渲染（与封面迁移完成同一事件，有先例）。

### 5. 构建配置
- `index.html`：viewport 加 `viewport-fit=cover`。
- `vite.config.ts`：`CAPACITOR=true` 时 base 改 `'./'` 且不注册 VitePWA 插件（plugins 数组用条件展开）。

### 6. Android 原生侧
- `android/.../FoliaFsPlugin.java`（新建，Java 而非 Kotlin——app 模块未应用 kotlin 插件）：pickDirectory（ACTION_OPEN_DOCUMENT_TREE + takePersistableUriPermission）、scanTree（DocumentFile 递归，单目录不可读跳过）、readFileRange（FileChannel 定位读，>32 MiB 拒绝）、checkPermission（查 persistedUriPermissions）。
- `MainActivity.java`：`onCreate` 中 `super.onCreate` 前 `registerPlugin(FoliaFsPlugin.class)`。
- `android/app/build.gradle`：加 `androidx.documentfile:documentfile:1.1.0`（注意：用 PowerShell 写的，文件可能带 UTF-8 BOM，Gradle 一般可容忍）。

### 7. Android 原生侧（后台播放）
- `android/.../FoliaPlaybackService.java`（新建）：前台服务（`foregroundServiceType="mediaPlayback"`）持有 `MediaSessionCompat`，用 `NotificationCompat.MediaStyle` 发布系统媒体通知与锁屏控件；通知栏播放/暂停/上一首/下一首按钮以显式 action 复用服务自身（不额外注册 BroadcastReceiver）；系统媒体按键经 `ActionListener` 回传；封面从 http(s) URL 异步拉取，失败静默降级。
- `android/.../FoliaPlaybackPlugin.java`（新建）：Capacitor 插件 `FoliaPlayback`——`start` 拉起前台服务、`updateState` 推送元数据/状态/进度、`stop` 停止服务；系统按键以 `remoteAction` 事件转发到 Web 层。
- `MainActivity.java`：`registerPlugin(FoliaPlaybackPlugin.class)`；Android 13+ 启动时请求 `POST_NOTIFICATIONS`。
- `AndroidManifest.xml`：新增 `<service ... foregroundServiceType="mediaPlayback">`。
- `android/app/build.gradle`：加 `androidx.media:media:1.7.0`。
- Web 侧：`src/mobile/playback/playbackServicePlugin.ts`（插件类型）、`src/mobile/playback/useAndroidPlaybackService.ts`（仅 Android 生效，由 `useMediaSessionBridge` 调用，复用其入参与 play/pause/prev/next ref，播放中每 4s 刷新进度）。浏览器/Electron 仍走原生 `navigator.mediaSession` 路径，互不影响。

### 8. 文档
- `docs/android-build.md`（新建）：构建步骤（`CAPACITOR=true` 构建 → `cap sync` → `gradlew assembleDebug`）、运行时配置（远程 API Origin、酷狗 `folia.mobile.kugouApiBase`、通知权限）、权限说明、已知限制与常见问题。
- `README.md`「关于移动端」新增指向该文档的入口。

## 验证结果（本地）

- `npx tsc --noEmit`：**exit 0**。修复 2 处类型错误：`src/mobile/neteaseShim/request.ts` 的 `crypto` 判空（改为 `options.crypto || 'eapi'`）；`src/mobile/localFs/safHandles.ts` 中 `SafLazyBlob`/`SafLazyFile` 的 `stream()` 返回类型（`ReadableStream<Uint8Array<ArrayBuffer>>`）。
- `npx vite build`（Web 产物）：**exit 0**，与 Capacitor 共用同一份源码 bundle（含 neteaseShim）。
- `$env:CAPACITOR='true'; npx vite build`：本会话所在沙箱禁止写 dot 路径（`node_modules/.vite-temp`）与删除既有 `dist/`，Capacitor 构建无法在受限环境中跑完 —— 请在正常环境手动执行。
- `npx cap sync android` 与 `cd android; ./gradlew assembleDebug`：**需要 Android SDK，本机未安装，未验证** —— 请在装有 SDK 的环境手动执行。


## 待办

1. **手动验证**：`CAPACITOR=true` 构建、`npx cap sync android`、`android/` 的 `gradlew assembleDebug`（需要 Android SDK；本机未安装，未验证）。
2. **后台播放真机走查**：验证通知栏/锁屏/蓝牙按键控制、切后台继续播放、Android 13+ 通知权限首次请求。原生代码本机无法编译，需在装好 SDK 的环境编译后修正可能的编译问题（本次为静态编写，未编译）。
3. **酷狗音源**：当前只有匿名搜索 + legacy playInfo；自建后端可通过 localStorage `folia.mobile.kugouApiBase` 配置。
4. 可能的打磨：edge-to-edge 导航栏安全区（目前 StatusBar 不叠加，够用）、大曲库 scanTree 性能（DocumentFile 递归是逐目录 IPC，千级文件可接受）。

## 关键架构决策（速查）

- **前端从不直连 music.163.com**——shim 在假 origin 下重放官方 NeteaseCloudMusicApiEnhanced 的加密与路由，与 Electron 内嵌 Node 服务器架构同构。
- **CORS 全局解法**：CapacitorHttp 原生通道，不是靠代理。
- **SAF 适配策略**：模拟 File System Access API 接口，让 localMusicService 的导入/快照/恢复逻辑几乎零改动；差异（懒加载、持久化、FLAC 物化）收敛在 safHandles.ts 与三个小分支里。
