'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const executable = path.resolve(process.argv[2] || 'dist/win-unpacked/MediaCompressor.exe');
  await fs.access(executable);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'media-desktop-smoke-'));
  const root = path.join(temporary, '首次启动用户数据');
  console.log('桌面端测试目录：' + root);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--smoke-test'], {
      env: { ...process.env, MEDIA_COMPRESSOR_SMOKE_DIR: root },
      stdio: 'inherit', windowsHide: true,
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('桌面端测试超过 120 秒')); }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('桌面进程退出码：' + code)); });
  });
  const result = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
  if (!result.ok || !result.packaged) throw new Error(JSON.stringify(result));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
