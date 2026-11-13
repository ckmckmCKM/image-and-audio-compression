'use strict';
const path = require('node:path');
module.exports = {
  appId: 'com.local.mediacompressor',
  productName: '图片与音频压缩',
  executableName: 'MediaCompressor',
  directories: { output: 'dist', buildResources: 'build' },
  asar: true,
  asarUnpack: ['node_modules/@img/**/*', 'node_modules/sharp/**/*'],
  npmRebuild: false,
  electronDist: path.resolve(__dirname, '../node_modules/electron/dist'),
  files: ['desktop/**/*', 'server.cjs', 'lib/**/*', 'public/**/*', 'build/icon.png', 'package.json'],
  extraResources: [
    { from: 'runtime', to: 'runtime', filter: ['ffmpeg.exe', 'ffprobe.exe', 'FFMPEG-LICENSE.txt', 'FFMPEG-README.txt', 'AUDIO-SOURCES.json'] },
    { from: '使用说明.md', to: '使用说明.md' },
    { from: '第三方组件.md', to: '第三方组件.md' },
  ],
  win: { target: [{ target: 'dir', arch: ['x64'] }], icon: 'build/icon.ico' },
  afterAllArtifactBuild: require('./portable.cjs'),
};
