# Windows x64 离线构建依赖

本目录将完整的 npm 运行/构建依赖、Electron Windows 运行时、electron-builder 使用的打包工具和许可证保存为 48 MiB 分卷。无需 Git LFS，所有分卷都应提交到 Git；请保留全部分卷和 `manifest.json`。

## 在拉取仓库后构建

在 Windows x64 上双击根目录的 `生成桌面版.cmd`，或运行：

```powershell
.\runtime\node.exe tools/build-desktop.cjs
```

构建脚本先校验 `package-lock.json`、依赖分卷、解压工具以及内置 Node.js/FFmpeg/FFprobe 的 SHA-256，然后恢复 `node_modules/` 与 `.build-cache/electron-builder/`。构建过程不执行 `npm install`，不需要系统 Node.js/npm 或联网下载 Electron/NSIS。

产物位于 `dist/`，包含免安装版 `MediaCompressor_<版本>.exe` 和校验文件。`node_modules/`、`.build-cache/` 与 `dist/` 是恢复或生成目录，不直接提交。

## 维护者更新依赖

只有更新依赖时才需要联网，并需要可用的 npm：

1. 修改依赖后运行 `npm install`，确保 `package-lock.json` 更新；如安装跳过了 Electron 下载，执行 `runtime\node.exe node_modules/electron/install.js`。
2. 使用仓库缓存目录完成一次构建，以收集所有打包工具：

   ```powershell
   $env:ELECTRON_BUILDER_CACHE = Join-Path $PWD '.build-cache/electron-builder'
   .\runtime\node.exe node_modules/electron-builder/cli.js --config build/electron-builder.cjs --win --x64 --publish never
   ```

3. 执行 `runtime\node.exe tools/vendor-dependencies.cjs` 重新生成分卷与清单。
4. 执行正常的离线构建、测试和桌面测试，提交新的 lock 文件、清单及全部分卷；删除过期分卷。

分卷中每个组件的许可证保留在原目录内。7zip-bin 包装模块的 MIT 许可证见 `bin/7ZIP-LICENSE.txt`；`bin/7za.exe` 的 7-Zip 21.07 许可证见 `bin/7ZIP-BINARY-LICENSE.txt` 和 `bin/COPYING.LGPL`，原始源码可从 [7-Zip 21.07](https://sourceforge.net/projects/sevenzip/files/7-Zip/21.07/) 获取。音频和 Node.js 的许可证位于根目录 `runtime/`。该依赖包只用于 Windows x64，不适用于 macOS/Linux 构建。
