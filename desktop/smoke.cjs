'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { FFMPEG, runProcess } = require('../lib/audio.cjs');

async function runSmoke({ window, backend, root }) {
  const inputs = path.join(root, '中文素材');
  await fs.mkdir(inputs, { recursive: true });
  const png = path.join(inputs, '透明图片.png');
  const jpeg = path.join(inputs, '照片.jpg');
  await sharp({ create: { width: 320, height: 240, channels: 4, background: '#9876ab88' } }).png({ compressionLevel: 0 }).toFile(png);
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#4a5b6c' } }).jpeg({ quality: 100 }).toFile(jpeg);
  for (const [name, codec, bitrate] of [['音乐.mp3', 'libmp3lame', '320k'], ['音效.ogg', 'libvorbis', '256k'], ['保留.wav', 'pcm_s16le', null]]) {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'anoisesrc=color=white:amplitude=0.15:sample_rate=44100:duration=2:seed=17', '-ac', '2', '-c:a', codec];
    if (bitrate) args.push('-b:a', bitrate);
    args.push(path.join(inputs, name));
    await runProcess(FFMPEG, args);
  }
  const originals = new Map(await Promise.all((await fs.readdir(inputs)).map(async name => [name, await fs.readFile(path.join(inputs, name))])));
  const output = path.join(root, '测试输出');
  const page = code => window.webContents.executeJavaScript(code);
  await page(`(async () => {
    await refresh();
    document.getElementById('paths').value = ${JSON.stringify(inputs)};
    document.getElementById('add-paths').click();
  })()`);
  async function until(check) {
    for (let i = 0; i < 600; i++) {
      const value = await check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('桌面端测试等待超时');
  }
  await until(() => page(`document.getElementById('file-count').textContent === '5 个' && !document.getElementById('start').disabled`));
  await page(`(() => {
    document.getElementById('mode').value = 'high';
    document.querySelector('input[value="saveAs"]').click();
    document.getElementById('output-dir').value = ${JSON.stringify(output)};
    document.getElementById('start').click();
  })()`);
  await until(() => backend.getJob()?.status === 'completed');
  await until(() => page(`document.getElementById('progress-title').textContent === '批次完成' && !document.getElementById('download-report').disabled`));
  const saved = backend.getJob();
  assert.equal(saved.processed, 5);
  assert.equal(saved.results.filter(item => item.status === 'error').length, 0);
  assert.ok(saved.results.some(item => item.kind === 'audio' && item.optimized));
  assert.ok(saved.results.some(item => item.kind === 'image' && item.optimized));
  assert.ok(saved.results.some(item => item.reason === 'wav-preserved'));
  for (const result of saved.results) {
    assert.deepEqual(await fs.readFile(result.path), originals.get(path.basename(result.path)));
    assert.ok((await fs.stat(result.output)).size > 0);
  }
  const reportFile = path.join(root, '下载报告.json');
  const downloaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('报告下载超时')), 10000);
    window.webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(reportFile);
      item.once('done', (_downloadEvent, status) => {
        clearTimeout(timer);
        status === 'completed' ? resolve() : reject(new Error('报告下载失败：' + status));
      });
    });
  });
  await page(`document.getElementById('download-report').click()`);
  await downloaded;
  assert.equal(JSON.parse(await fs.readFile(reportFile, 'utf8')).id, saved.id);
  await page(`document.querySelector('input[value="overwrite"]').click(); document.getElementById('start').click()`);
  await until(() => backend.getJob()?.id !== saved.id && backend.getJob()?.status === 'completed');
  await backend.stop();
  const overwritten = backend.getJob();
  assert.equal(overwritten.results.filter(item => item.status === 'error').length, 0);
  for (const result of overwritten.results.filter(item => item.optimized)) {
    assert.ok(result.backup.startsWith(root));
    assert.deepEqual(await fs.readFile(result.backup), originals.get(path.basename(result.path)));
  }
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({
    ok: true, packaged: require('electron').app.isPackaged,
    versions: { electron: process.versions.electron, node: process.versions.node },
    checks: ['renderer-loaded', 'mixed-media-save-as', 'originals-preserved', 'report-download', 'overwrite-backups', 'ffmpeg-ffprobe', 'sharp-native'],
  }, null, 2));
}
module.exports = { runSmoke };
