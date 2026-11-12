# 打包说明 · Folia 安卓版 → GitHub

打包时间：2026-11-12
来源目录：`D:\claude\folia-android`（Folia 的安卓 / Capacitor 适配工作副本）
上游项目：[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)，AGPL-3.0

这个包是**源码快照**，用来在另一台电脑上建 GitHub 仓库、继续开发或出包。

## 包里有什么

- **开发记录**：`开发记录.md`（时间线、移动端模块清单、原生侧、接入点、待办）、
  `ANDROID_ADAPTATION_PROGRESS.md`（最详细的进度原文）、`docs/android-build.md`（出包流程）
- **开发记录素材**：`开发记录素材/动画验证/`（播放页动画校验帧图与录屏）、
  `开发记录素材/安装包/app-debug.apk`（10-18 的 debug 包）
- 前端源码：`src/`（含 `src/mobile/` 移动端 21 个模块）、`index.html`、`package.json`、`package-lock.json`
- 安卓工程：`android/`（Capacitor）、`capacitor.config.ts`、`build-android.ps1`
- 原生模块：`native/`（含 `folia-mnn`）、`electron/`、`mods/`、`api/`、`api-ts/`
- 调试脚本：`scripts/`（CDP 截图、vocalmix 校验等）
- 手机效果截图：`phone-*.jpg`、`shot-*.png`
- 许可证与文档：`LICENSE`、`README.md`、`README.en.md`、`CONTRIBUTING*`

## 没打进去的（都是可再生成的）

| 排除项 | 大小 | 原因 |
| --- | --- | --- |
| `node_modules/` | ~1.1 GB | 另一台机器 `npm install` 重建 |
| `android/build/`、`android/app/build/`、`android/.gradle/`、`android/.kotlin/` | ~90 MB | Gradle 构建产物 |
| `android/capacitor-cordova-android-plugins/` | — | `npx cap sync` 生成 |
| `android/app/src/main/assets/public/` | 20 MB | `cap sync` 复制进去的 web 产物 |
| `dist/` | 18 MB | `npm run build` 生成 |
| `*.log`、`probe_root.txt` | — | 日志 / 临时文件 |

## 在另一台电脑上发布到 GitHub

前提：Node.js ≥ 24（`package.json` 里写死了 `>=24`），安卓出包还需要 JDK + Android SDK。

```bash
# 1. 解压后在 folia-android 目录里
cd folia-android

# 2. 安装依赖
npm install

# 3. 建仓库并首提交
git init -b main
git add -A
git commit -m "Folia 安卓版：Capacitor 适配与播放页调整"

# 4. 接到 GitHub（先在网页上建好空仓库，不要勾选 README）
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

先跑一遍确认能起来：

```bash
npm run dev                 # 网页端
npx cap sync android        # 同步 web 产物到安卓工程
```

## 注意

- 这个目录**原本不是 git 仓库**，没有历史，所以这里是从零一个首提交。要保留上游历史的话，应该改为 clone 上游再 rebase，而不是用这个快照。
- 上游是 **AGPL-3.0**：二次发布请保留 `LICENSE`，README 里注明 fork 自 `chthollyphile/folia-major`。
- `开发记录素材/` 有 50 MB 帧图和 apk，不想要的话删掉再提交，不影响编译。
- `scripts/*` 被上游 `.gitignore` 忽略，`git add -A` 不会带上。想把调试脚本也发上去就 `git add -f scripts/`，或者改 `.gitignore`。
- 密钥类文件没打进来（也确认过没有 `.env`、`*.jks`、`local.properties`），只有 `.env.example` / `deploy/docker/.env.example` 模板。
