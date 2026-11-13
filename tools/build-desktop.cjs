'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} 退出码：${code}`)));
  });
}

async function restore() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('离线构建需要 Windows x64。');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'vendor/manifest.json'), 'utf8'));
  if (hash(await fs.readFile(path.join(root, 'package-lock.json'))) !== manifest.lockSha256) {
    throw new Error('package-lock.json 与离线依赖不匹配。升级依赖后请重新生成 vendor 依赖包。');
  }
  for (const item of [...manifest.volumes, ...manifest.tools, ...manifest.runtime]) {
    const data = await fs.readFile(path.join(root, item.file));
    if (data.length !== item.bytes || hash(data) !== item.sha256) throw new Error('依赖校验失败：' + item.file);
  }
  const stampFile = path.join(root, '.build-cache/restored.json');
  const bundleHash = hash(Buffer.from(JSON.stringify(manifest)));
  const stamp = await fs.readFile(stampFile, 'utf8').catch(() => '');
  const required = ['node_modules/electron/dist/electron.exe', 'node_modules/electron-builder/cli.js', 'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node', '.build-cache/electron-builder'];
  const present = await Promise.all(required.map(file => fs.stat(path.join(root, file)).then(() => true, () => false)));
  if (stamp !== bundleHash || present.some(value => !value)) {
    console.log('正在还原仓库内的 Windows 构建依赖……');
    await fs.mkdir(path.join(root, '.build-cache'), { recursive: true });
    const staging = await fs.mkdtemp(path.join(root, '.build-cache/restore-'));
    try {
      await run(path.join(root, 'vendor/bin/7za.exe'), ['x', path.join(root, manifest.volumes[0].file), '-o' + staging, '-y', '-bsp0']);
      // 先完整解压，再替换目录；正在运行的工具占用旧库时，保留原目录并提示。
      for (const directory of ['node_modules', '.build-cache/electron-builder']) {
        const destination = path.join(root, directory);
        const previous = path.join(root, '.build-cache', 'previous-' + path.basename(directory) + '-' + crypto.randomUUID());
        const exists = await fs.stat(destination).then(() => true, () => false);
        if (exists) {
          try { await fs.rename(destination, previous); }
          catch (error) { throw new Error('无法替换旧依赖，请关闭使用本仓库的工具后重试：' + error.message); }
        }
        try { await fs.rename(path.join(staging, directory), destination); }
        catch (error) { if (exists) await fs.rename(previous, destination); throw error; }
        if (exists) await fs.rm(previous, { recursive: true, force: true }).catch(() => {
          console.log('旧依赖仍被进程占用，暂存于：' + previous);
        });
      }
      await fs.writeFile(stampFile, bundleHash);
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
  return manifest;
}

async function main() {
  await restore();
  if (process.argv.includes('--restore-only')) return;
  const env = { ...process.env,
    ELECTRON_BUILDER_CACHE: path.join(root, '.build-cache/electron-builder'),
    ELECTRON_BUILDER_COMPRESSION_LEVEL: '5', CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
  };
  // 为 electron-builder 的子进程提供仓库自带 Node.js，无需系统安装 Node/npm。
  env.PATH = [path.join(root, 'runtime'), path.join(root, 'node_modules/.bin'), env.PATH || env.Path || ''].join(path.delimiter);
  delete env.Path;
  await run(process.execPath, [path.join(root, 'node_modules/electron-builder/cli.js'), '--config', 'build/electron-builder.cjs', '--win', '--x64', '--publish', 'never'], { env });
  const outputs = (await fs.readdir(path.join(root, 'dist'))).filter(name => /^MediaCompressor-(Setup|Portable)-.*\.exe$/.test(name));
  const sums = await Promise.all(outputs.map(async name => `${hash(await fs.readFile(path.join(root, 'dist', name)))}  ${name}`));
  await fs.writeFile(path.join(root, 'dist/SHA256SUMS.txt'), sums.join('\n') + '\n');
  console.log('打包完成，安装版和免安装版位于 dist 文件夹。');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { restore, run };
