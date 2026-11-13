'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function measure(executable) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'media-startup-'));
  const root = path.join(temporary, '首次启动用户数据');
  const started = performance.now();
  let startupMs = null, monitoring = false;
  const timer = setInterval(async () => {
    if (monitoring || startupMs !== null) return;
    monitoring = true;
    if (await fs.stat(path.join(root, '中文素材')).catch(() => null)) startupMs = Math.round(performance.now() - started);
    monitoring = false;
  }, 25);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--smoke-test'], {
        env: { ...process.env, MEDIA_COMPRESSOR_SMOKE_DIR: root },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const timeout = setTimeout(() => {
        // A portable launcher owns an Electron process tree; terminate only this test's tree.
        if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill();
        reject(new Error('启动测试超时：' + output));
      }, 180000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', async code => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error('进程退出码 ' + code + ': ' + output + await fs.readFile(path.join(root, 'portable-error.txt'), 'utf8').catch(() => '') + '; ' + root));
      });
    });
    const result = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
    if (!result.ok || !result.packaged || startupMs === null) throw new Error(JSON.stringify(result));
    return { startupMs, totalMs: Math.round(performance.now() - started), root, checks: result.checks };
  } finally { clearInterval(timer); }
}

async function main() {
  const executable = path.resolve(process.argv[2]);
  const repetitions = Number(process.argv[3] || 2);
  for (let i = 0; i < repetitions; i++) {
    console.log(JSON.stringify({ executable, launch: i + 1, ...await measure(executable) }));
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { measure };
