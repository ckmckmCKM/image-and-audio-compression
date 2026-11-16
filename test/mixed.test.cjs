'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../server.cjs');
const { createAudio } = require('./audio-fixtures.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-mixed-test-'));
  const app = await createApp({ root });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + app.server.address().port; app.setUrl(url);
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  async function api(route, data) {
    const response = await fetch(url + '/api/' + route, { method: data ? 'POST' : 'GET', headers: { 'X-Tool-Token': app.token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function done() {
    for (let i = 0; i < 500; i++) {
      const job = (await api('state')).body.job;
      if (job?.status !== 'running') {
        return job;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Mixed batch timed out');
  }
  return { root, api, done };
}

test('one mixed queue processes images, MP3, OGG and preserved WAV; damaged audio does not stop the batch', async t => {
  const { root, api, done } = await setup(t);
  const input = path.join(root, '混合素材'); await fs.mkdir(input);
  await sharp({ create: { width: 90, height: 90, channels: 4, background: '#aabcffaa' } }).png({ compressionLevel: 0 }).toFile(path.join(input, '图片.png'));
  await createAudio(input, '高码率.mp3');
  await createAudio(input, '环境.ogg', { codec: 'libvorbis', bitrate: 256 });
  await createAudio(input, '低码率.mp3', { bitrate: 64 });
  await createAudio(input, '保持.wav', { codec: 'pcm_s16le' });
  await fs.writeFile(path.join(input, '损坏.mp3'), 'damaged');
  await fs.writeFile(path.join(input, '图片.png.meta'), 'metadata');
  const before = new Map();
  for (const name of await fs.readdir(input)) before.set(name, await fs.readFile(path.join(input, name)));
  const added = (await api('add', { paths: [input] })).body;
  assert.equal(added.entries.length, 6);
  assert.equal(added.entries.filter(e => e.kind === 'audio').length, 5);
  assert.equal((await api('start', { mode: 'high', audioBitrate: 999, destination: 'overwrite' })).status, 400);
  assert.equal((await api('start', { mode: 'high', destination: 'saveAs', outputDir: path.join(root, 'output') })).status, 200);
  const job = await done();
  assert.equal(job.audioBitrate, 128); assert.equal(job.status, 'completed'); assert.equal(job.processed, 6);
  assert.equal(job.results.filter(r => r.status === 'optimized').length, 3);
  assert.equal(job.results.filter(r => r.status === 'skipped').length, 2);
  assert.equal(job.results.filter(r => r.status === 'error').length, 1);
  for (const [name, original] of before) assert.deepEqual(await fs.readFile(path.join(input, name)), original);
  for (const result of job.results.filter(r => r.status === 'skipped')) assert.deepEqual(await fs.readFile(result.output), before.get(path.basename(result.path)));
  const report = (await api('report')).body;
  assert.equal(report.audioBitrate, 128);
  assert.ok(report.results.some(r => r.reason === 'wav-preserved'));
});

test('compression defaults to high image mode with both types enabled', async () => {
  const html = await fs.readFile(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<option value="high" selected>高压缩<\/option>/);
  assert.match(html, /id="compress-images" type="checkbox" checked/);
  assert.match(html, /id="compress-audio" type="checkbox" checked/);
});

test('unchecking a type skips those files without copying or overwriting', async t => {
  const { root, api, done } = await setup(t);
  const input = path.join(root, '素材'); await fs.mkdir(input);
  const image = path.join(input, '图片.png');
  await sharp({ create: { width: 40, height: 40, channels: 3, background: '#3366aa' } }).png({ compressionLevel: 0 }).toFile(image);
  const audio = await createAudio(input, '声音.mp3', { bitrate: 256 });
  const beforeImage = await fs.readFile(image);
  const beforeAudio = await fs.readFile(audio);
  await api('add', { paths: [input] });
  const rejected = await api('start', { compressImages: false, compressAudio: false, destination: 'overwrite' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /勾选/);

  const outputDir = path.join(root, 'output');
  assert.equal((await api('start', { mode: 'tinify', audioBitrate: 128, compressImages: false, compressAudio: true, destination: 'saveAs', outputDir })).status, 200);
  let job = await done();
  const skippedImage = job.results.find(r => r.kind === 'image');
  const compressedAudio = job.results.find(r => r.kind === 'audio');
  assert.equal(skippedImage.status, 'skipped');
  assert.equal(skippedImage.reason, 'compression-off');
  assert.equal(skippedImage.output, undefined);
  assert.equal(compressedAudio.status, 'optimized');
  assert.equal(job.audioBitrate, 128);
  assert.deepEqual(await fs.readFile(image), beforeImage);
  const written = [];
  async function walk(dir) {
    for (const name of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) await walk(full); else written.push(name.name);
    }
  }
  await walk(job.outputRoot);
  assert.deepEqual(written.filter(name => name.endsWith('.png')), []);
  assert.ok(written.some(name => name.endsWith('.mp3')));

  await api('clear', {});
  await api('add', { paths: [input] });
  assert.equal((await api('start', { mode: 'high', audioBitrate: 999, compressImages: true, compressAudio: false, destination: 'overwrite' })).status, 200);
  job = await done();
  const skippedAudio = job.results.find(r => r.kind === 'audio');
  assert.equal(job.results.find(r => r.kind === 'image').status, 'optimized');
  assert.equal(skippedAudio.status, 'skipped');
  assert.equal(skippedAudio.reason, 'compression-off');
  assert.equal(skippedAudio.backup, undefined);
  assert.equal(job.audioBitrate, null);
  assert.deepEqual(await fs.readFile(audio), beforeAudio);
  assert.notDeepEqual(await fs.readFile(image), beforeImage);
});

test('audio-only batches do not require or call Tinify even if image mode is Tinify', async t => {
  const { root, api, done } = await setup(t);
  const file = await createAudio(root, 'audio.mp3', { bitrate: 64 });
  await api('add', { paths: [file] });
  assert.equal((await api('start', { mode: 'tinify', audioBitrate: 128, destination: 'overwrite' })).status, 200);
  const job = await done(); assert.equal(job.results[0].reason, 'bitrate-low');
});
