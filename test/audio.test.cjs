'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { processAudio, probeAudio, runProcess } = require('../lib/audio.cjs');
const { createAudio } = require('./audio-fixtures.cjs');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-audio-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('MP3/Vorbis/Opus: 128/96/64 kbps preserve codec, duration, sample rate and channels', async t => {
  const root = await setup(t);
  for (const [name, codec, sampleRate] of [['高码率.mp3', 'libmp3lame', 44100], ['环境.ogg', 'libvorbis', 44100], ['对话.ogg', 'libopus', 48000]]) {
    const file = await createAudio(root, name, { codec, bitrate: codec === 'libmp3lame' ? 320 : 256, sampleRate });
    const original = await fs.readFile(file), before = await probeAudio(file);
    for (const bitrate of [128, 96, 64]) {
      const result = await processAudio({ path: file }, { audioBitrate: bitrate, overwrite: false, outputRoot: path.join(root, 'out'), relative: bitrate + '-' + name });
      assert.ok(result.optimized, codec + ' ' + bitrate + ' should shrink');
      const after = await probeAudio(result.output);
      assert.equal(after.codec, before.codec); assert.equal(after.sampleRate, sampleRate); assert.equal(after.channels, 2);
      assert.ok(Math.abs(after.duration - before.duration) <= 0.12);
      assert.equal(result.targetBitrate, bitrate * 1000);
      assert.ok(Math.abs(after.bitrate - bitrate * 1000) <= 1500, 'reported target bitrate matches encoded bitrate');
      assert.deepEqual(await fs.readFile(file), original);
      const again = await processAudio({ path: result.output }, { audioBitrate: bitrate, overwrite: true });
      assert.equal(again.reason, 'bitrate-low', 'already encoded target should not be re-encoded');
    }
  }
});

test('low bitrate MP3/OGG and WAV are preserved byte for byte, including save-as copies', async t => {
  const root = await setup(t);
  const files = [
    await createAudio(root, '低码率.mp3', { bitrate: 96, channels: 1 }),
    await createAudio(root, '目标码率.mp3', { bitrate: 128 }),
    await createAudio(root, '低码率.ogg', { codec: 'libvorbis', bitrate: 64 }),
    await createAudio(root, '原样.wav', { codec: 'pcm_s16le', sampleRate: 22050, channels: 1 }),
  ];
  for (const file of files) {
    const original = await fs.readFile(file);
    const result = await processAudio({ path: file }, { overwrite: false, outputRoot: path.join(root, 'out'), relative: path.basename(file) });
    assert.equal(result.reason, file.endsWith('.wav') ? 'wav-preserved' : 'bitrate-low');
    assert.equal(result.optimized, false); assert.deepEqual(await fs.readFile(result.output), original);
    const kept = await processAudio({ path: file }, { overwrite: true });
    assert.equal(kept.backup, ''); assert.deepEqual(await fs.readFile(file), original);
  }
});

test('audio overwrite backs up originals, preserves meta, and rejects invalid audio/bitrate', async t => {
  const root = await setup(t);
  for (const [filename, codec] of [['配音.mp3', 'libmp3lame'], ['背景.ogg', 'libvorbis']]) {
    const file = await createAudio(root, filename, { codec, bitrate: 256 });
    const original = await fs.readFile(file);
    await fs.writeFile(file + '.meta', 'keep-original-uuid');
    const result = await processAudio({ path: file }, { audioBitrate: 128, overwrite: true, backupRoot: path.join(root, 'backup'), relative: filename });
    assert.deepEqual(await fs.readFile(result.backup), original);
    assert.ok((await fs.stat(file)).size < original.length);
    assert.equal(await fs.readFile(file + '.meta', 'utf8'), 'keep-original-uuid');
  }
  const invalid = path.join(root, 'invalid.mp3'); await fs.writeFile(invalid, 'not audio');
  await assert.rejects(processAudio({ path: invalid }, { overwrite: true }));
  await assert.rejects(processAudio({ path: invalid }, { audioBitrate: 999, overwrite: true }), /码率/);
  assert.equal(await fs.readFile(invalid, 'utf8'), 'not audio');
});

test('cancellation terminates active child processes and never modifies audio', async t => {
  const root = await setup(t);
  const controller = new AbortController();
  const waiting = runProcess(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(waiting, /取消/);
  const file = await createAudio(root, '取消.mp3');
  const original = await fs.readFile(file);
  await assert.rejects(processAudio({ path: file }, { overwrite: true, audioBitrate: 128, signal: controller.signal }));
  assert.deepEqual(await fs.readFile(file), original);
});
