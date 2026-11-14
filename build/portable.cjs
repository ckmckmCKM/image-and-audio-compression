'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

async function inventory(directory, relative = '') {
  const files = [];
  const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
  for (const entry of entries) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(directory, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error('免安装包不接受符号链接：' + name);
  }
  return files.sort();
}

function literal(value) {
  if (/[\r\n]/.test(value)) throw new Error('NSIS 参数不能包含换行');
  return value.replace(/\$/g, () => '$$').replace(/"/g, '$\\"');
}

async function buildPortable(context) {
  const root = path.resolve(__dirname, '..');
  const directory = path.join(context.outDir, 'win-unpacked');
  const files = await inventory(directory);
  const hash = crypto.createHash('sha256');
  for (const name of files) {
    hash.update(name.replace(/\\/g, '/') + '\0');
    for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
    hash.update('\0');
  }
  const version = require(path.join(root, 'package.json')).version;
  const cacheId = version + '-' + hash.digest('hex').slice(0, 24);
  const output = path.join(context.outDir, `MediaCompressor_${version}.exe`);
  const checks = path.join(context.outDir, 'portable-cache-checks.nsh');
  await fs.writeFile(checks, files.map(name => `IfFileExists "$cacheDir\\${literal(name)}" 0 cache_invalid`).join('\n') + '\n');
  const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
  const nsis = await getMakeNsisPath(context.configuration.toolsets?.nsis);
  const defines = {
    APP_DIR: directory, OUTPUT_FILE: output, APP_ICON: path.join(root, 'build/icon.ico'),
    CACHE_ID: cacheId, CACHE_CHECKS: checks, VERSION: version,
    WINDOWS_VERSION: version.split('-')[0] + '.0',
  };
  console.log('正在生成免安装版（持久组件缓存）：' + cacheId);
  await new Promise((resolve, reject) => {
    const child = spawn(nsis.path, ['-WX', '-INPUTCHARSET', 'UTF8', ...Object.entries(defines).map(([key, value]) => `-D${key}=${literal(value)}`), path.join(root, 'build/portable.nsi')], {
      cwd: root, env: { ...process.env, ...nsis.env }, windowsHide: true, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('免安装版编译失败：' + code)));
  });
  await fs.writeFile(path.join(context.outDir, 'portable-cache.json'), JSON.stringify({ cacheId, version, files, executable: path.basename(output) }, null, 2) + '\n');
  // Remove only this app's obsolete distribution files after the new EXE succeeds.
  for (const name of await fs.readdir(context.outDir)) {
    const obsolete = name !== path.basename(output) && (
      /^MediaCompressor-(Setup|Portable)-.*\.exe(?:\.blockmap)?$/.test(name)
      || /^MediaCompressor_.*\.exe$/.test(name)
      || /^图片与音频压缩_.*\.exe$/.test(name)
      || name === 'latest.yml');
    if (obsolete) await fs.unlink(path.join(context.outDir, name));
  }
  return [output];
}
module.exports = buildPortable;
