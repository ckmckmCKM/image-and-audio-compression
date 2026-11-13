# 图片与音频压缩桌面端

Windows 10/11 x64 本地批量压缩工具。独立桌面窗口，支持 PNG/JPG/JPEG、MP3/OGG/WAV；图片和音频可混合处理。提供本地图片三档压缩、Tinify 图片压缩、音频 128/96/64 kbps、覆盖备份和另存输出。

## 直接使用

从本仓库的 GitHub **Releases** 下载：

- `MediaCompressor-Setup-<版本>-x64.exe`：双击安装后，从桌面快捷方式打开。
- `MediaCompressor-Portable-<版本>-x64.exe`：免安装单文件，双击即可打开；首次启动需解压内置组件，请稍等。

最终用户只需要一个 EXE，无需下载源码、安装 Node.js/npm、浏览器或音频编码器。本地压缩无需联网；Tinify 模式需要用户自己的 API Key。

## 拉取源码后重新生成 EXE

仓库包含 Node.js、FFmpeg/FFprobe，以及 `vendor/` 中的完整 Windows x64 构建依赖分卷。无需 Git LFS、系统 Node.js/npm 或额外下载安装依赖。

1. 在 Windows x64 上完整拉取仓库。
2. 双击根目录的 **`生成桌面版.cmd`**。
3. 在 `dist/` 获取安装版、免安装版和 `SHA256SUMS.txt`。

命令行方式：

```powershell
.\runtime\node.exe tools/build-desktop.cjs
```

构建会校验依赖 SHA-256，按需还原 `node_modules/` 和 `.build-cache/`。保留充足磁盘空间，建议将源码放在较短路径下。更新依赖的方法见 [离线依赖说明](vendor/README.md)。

## GitHub 自动发布

只有推送 `v<版本>` 标签会触发 `.github/workflows/build-windows.yml`，普通分支 push 和 PR 不触发。标签必须与 `package.json` 的版本完全一致，例如当前版本为 `1.2.0`：

```powershell
git push origin main
git tag v1.2.0
git push origin v1.2.0
```

工作流在 Windows runner 上使用仓库内的依赖构建，运行压缩测试和打包程序的桌面测试，再将两个 EXE 和 SHA-256 清单上传到对应 GitHub Release，同时保留 30 天 Actions 构建产物。GitHub Actions 自身的 checkout、上传和 Release 操作需要联网；依赖恢复及 EXE 打包无需下载 npm 包或打包工具。

发布其他版本时，先修改 `package.json` 的 `version`，用 `npm install --package-lock-only --ignore-scripts` 更新 lock 文件，再刷新离线依赖清单/分卷并验证。提交这些文件后推送匹配的版本标签。无需配置第三方发布服务；工作流使用仓库自带的 `GITHUB_TOKEN`，仓库或组织策略需允许工作流创建 Release。

## 数据位置

桌面版的设置、报告和备份保存在 `%APPDATA%\MediaCompressor\` 下，默认另存目录为 Windows 文档目录中的 `图片与音频压缩`。升级、重新打包或移动免安装 EXE 不会改变该数据目录。覆盖前会先备份；文件完成后可点击“打开备份目录”查看。

## 开发与测试

```powershell
# 仅还原依赖
.\runtime\node.exe tools/build-desktop.cjs --restore-only
# 开发模式打开桌面窗口
.\runtime\node.exe node_modules/electron/cli.js .
# 压缩逻辑及 HTTP 测试
.\runtime\node.exe --test test/*.test.cjs
# 测试实际打包的桌面程序
.\runtime\node.exe tools/smoke-desktop.cjs dist/win-unpacked/MediaCompressor.exe
```

原有 `启动图片压缩.cmd` / `停止图片压缩.cmd` 仍可启动和停止浏览器版本，浏览器版的数据保存在源码目录下。

详细操作见 [使用说明](使用说明.md)，模块和处理流程见 [架构文档](架构文档.md)，许可证及来源见 [第三方组件](第三方组件.md)。
