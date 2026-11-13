'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { run } = require('./build-desktop.cjs');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor');

async function describe(relative) {
  const data = await fs.readFile(path.join(root, relative));
  return { file: relative, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
}

async function main() {
  await fs.access(path.join(root, 'node_modules/electron/dist/electron.exe'));
  await fs.access(path.join(root, '.build-cache/electron-builder'));
  await fs.mkdir(path.join(vendor, 'bin'), { recursive: true });
  await fs.copyFile(path.join(root, 'node_modules/7zip-bin/win/x64/7za.exe'), path.join(vendor, 'bin/7za.exe'));
  await fs.copyFile(path.join(root, 'node_modules/7zip-bin/LICENSE.txt'), path.join(vendor, 'bin/7ZIP-LICENSE.txt'));
  for (const name of await fs.readdir(vendor)) {
    if (/^windows-build-deps\.7z\.\d+$/.test(name)) await fs.unlink(path.join(vendor, name));
  }
  await run(path.join(vendor, 'bin/7za.exe'), ['a', path.join(vendor, 'windows-build-deps.7z'), 'node_modules', '.build-cache/electron-builder', '-v48m', '-mx=5', '-bsp0', '-xr!node_modules/.cache']);
  const volumes = (await fs.readdir(vendor)).filter(name => /^windows-build-deps\.7z\.\d+$/.test(name)).sort();
  const manifest = {
    platform: 'win32-x64',
    electron: require('../node_modules/electron/package.json').version,
    electronBuilder: require('../node_modules/electron-builder/package.json').version,
    lockSha256: (await describe('package-lock.json')).sha256,
    tools: await Promise.all(['vendor/bin/7za.exe', 'vendor/bin/7ZIP-LICENSE.txt', 'vendor/bin/7ZIP-BINARY-LICENSE.txt', 'vendor/bin/COPYING.LGPL'].map(describe)),
    runtime: await Promise.all(['runtime/node.exe', 'runtime/ffmpeg.exe', 'runtime/ffprobe.exe'].map(describe)),
    volumes: await Promise.all(volumes.map(name => describe('vendor/' + name))),
  };
  await fs.writeFile(path.join(vendor, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`离线依赖包已更新：${volumes.length} 个分卷，每卷不超过 48 MiB。`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
