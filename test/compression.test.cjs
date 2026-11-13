'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const vm = require('node:vm');
const { encode, collectImages, outputNames, processImage, tinifyEncode } = require('../lib/compression.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-tool-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rgba = Buffer.alloc(128 * 96 * 4);
  for (let i = 0; i < 128 * 96; i++) { rgba[i * 4] = i % 128 * 2; rgba[i * 4 + 1] = Math.floor(i / 128) * 2; rgba[i * 4 + 2] = 97; rgba[i * 4 + 3] = i % 5 ? 255 : 0; }
  const png = await sharp(rgba, { raw: { width: 128, height: 96, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const jpg = await sharp(rgba, { raw: { width: 128, height: 96, channels: 4 } }).jpeg({ quality: 100 }).toBuffer();
  return { root, png, jpg };
}

test('all local modes preserve format, visual dimensions and transparency; lossless PNG preserves pixels', async t => {
  const { png, jpg } = await fixture(t);
  for (const mode of ['lossless', 'high', 'extreme']) {
    for (const [original, extension, format] of [[png, '.png', 'png'], [jpg, '.jpg', 'jpeg'], [jpg, '.jpeg', 'jpeg']]) {
      const result = await encode(original, extension, mode);
      assert.ok(result.buffer.length <= original.length);
      const meta = await sharp(result.buffer).metadata();
      assert.equal(meta.width, 128); assert.equal(meta.height, 96); assert.equal(meta.format, format);
      if (extension === '.png') assert.equal(meta.hasAlpha, true);
      if (mode === 'lossless' && extension === '.png') assert.deepEqual(await sharp(result.buffer).raw().toBuffer(), await sharp(original).raw().toBuffer());
    }
  }
  const rotated = await sharp(jpg).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toBuffer();
  const result = await encode(rotated, '.jpg', 'high');
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.width, 96); assert.equal(meta.height, 128);
});

test('recursive collection handles Unicode, duplicates, nonimages and same-name outputs', async t => {
  const { root, png } = await fixture(t);
  await fs.mkdir(path.join(root, '图片/子目录'), { recursive: true });
  await fs.writeFile(path.join(root, '图片/子目录/纸条.PNG'), png);
  await fs.writeFile(path.join(root, '图片/子目录/纸条.PNG.meta'), 'metadata');
  const found = await collectImages([path.join(root, '图片'), path.join(root, '图片/子目录/纸条.PNG'), path.join(root, 'missing')]);
  assert.equal(found.entries.length, 1); assert.equal(found.failures.length, 1);
  assert.equal(found.entries[0].relative, path.join('图片', '子目录', '纸条.PNG'));
  assert.deepEqual(outputNames([{ relative: 'a.png' }, { relative: 'a.png' }, { relative: 'a_2.png' }]), ['a.png', 'a_2.png', 'a_2_2.png']);
});

test('palette PNG compression accepts a redundant fully opaque Alpha channel', async () => {
  const original = await sharp({ create: { width: 128, height: 96, channels: 4, background: '#bd8855ff' } })
    .png({ compressionLevel: 0 }).toBuffer();
  assert.equal((await sharp(original).metadata()).hasAlpha, true);
  for (const mode of ['high', 'extreme']) {
    const result = await encode(original, '.png', mode);
    assert.equal(result.optimized, true);
    const after = await sharp(result.buffer).metadata();
    assert.equal(after.width, 128); assert.equal(after.height, 96);
    assert.equal((await sharp(result.buffer).stats()).isOpaque, true);
  }
});

test('Tinify output that removes real transparency is still rejected', async () => {
  const original = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#bd885580' } }).png().toBuffer();
  const opaque = await sharp(original).removeAlpha().png().toBuffer();
  let calls = 0;
  await assert.rejects(encode(original, '.png', 'tinify', { apiKey: 'fake-key', fetchImpl: async () => {
    return ++calls === 1
      ? new Response('', { status: 201, headers: { location: 'https://api.tinify.com/output/test' } })
      : new Response(opaque, { status: 200 });
  } }), /透明通道/);
});

test('large-image metadata, encode and output validation all bypass the default pixel limit', async () => {
  // 不分配数 GB 的像素，模拟解码器在任一阶段遗漏大图选项时的真实报错。
  const original = Buffer.alloc(20), compressed = Buffer.alloc(10);
  const mockSharp = (buffer, options) => {
    if (options?.limitInputPixels !== false) throw new Error('Input image exceeds pixel limit');
    return { metadata: async () => ({ format: 'png', width: 30000, height: 20000, hasAlpha: false }),
      png() { return this; }, raw() { return this; }, toBuffer: async () => compressed };
  };
  const module = { exports: {} };
  const source = await fs.readFile(path.join(__dirname, '../lib/compression.cjs'), 'utf8');
  vm.runInNewContext(source, { require: name => name === 'sharp' ? mockSharp : require(name), module, Buffer });
  const result = await module.exports.encode(original, '.png', 'high');
  assert.equal(result.optimized, true);
});

test('save-as leaves originals/meta intact; overwrite makes exact backups; cancellation never writes', async t => {
  const { root, png } = await fixture(t);
  const input = path.join(root, '原图.png'); await fs.writeFile(input, png);
  await fs.writeFile(input + '.meta', 'original-uuid');
  const entry = { path: input };
  const options = { mode: 'high', relative: '子目录/原图.png', outputRoot: path.join(root, 'out'), backupRoot: path.join(root, 'backup') };
  const saved = await processImage(entry, options);
  assert.ok(saved.optimized); assert.deepEqual(await fs.readFile(input), png); assert.ok((await fs.stat(saved.output)).size < png.length);
  const overwritten = await processImage(entry, { ...options, overwrite: true });
  assert.deepEqual(await fs.readFile(overwritten.backup), png);
  assert.ok((await fs.stat(input)).size < png.length);
  assert.equal(await fs.readFile(input + '.meta', 'utf8'), 'original-uuid');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(processImage(entry, { ...options, relative: 'cancelled.png', signal: controller.signal }), /取消/);
  await assert.rejects(fs.stat(path.join(options.outputRoot, 'cancelled.png')), { code: 'ENOENT' });
  await assert.rejects(processImage(entry, { ...options, relative: '../escaped.png' }), /输出路径/);
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  const unchanged = await encode(tiny, '.png', 'lossless'); assert.ok(unchanged.buffer.length <= tiny.length);
});

test('Tinify sends correct MIME/auth, validates URLs and propagates quota/errors without real paid calls', async t => {
  const { png } = await fixture(t); let count = 0;
  const requests = [];
  const result = await tinifyEncode(png, '.png', 'fake-key', { fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    return ++count === 1 ? new Response('', { status: 201, headers: { location: 'https://api.tinify.com/output/example', 'compression-count': '9' } }) : new Response(png, { status: 200 });
  } });
  assert.deepEqual(result.buffer, png); assert.equal(result.compressionCount, '9');
  assert.equal(requests[0].headers['Content-Type'], 'image/png');
  assert.equal(requests[0].headers.Authorization, 'Basic ' + Buffer.from('api:fake-key').toString('base64'));
  assert.ok(requests[0].body.equals(png));
  await assert.rejects(tinifyEncode(png, '.png', '', {}), /API Key/);
  await assert.rejects(tinifyEncode(png, '.png', 'key', { fetchImpl: async () => new Response('', { status: 201, headers: { location: 'https://other.example/test' } }) }), /下载地址/);
  await assert.rejects(tinifyEncode(png, '.png', 'key', { fetchImpl: async () => new Response(JSON.stringify({ message: 'quota exceeded' }), { status: 429 }) }), /429.*quota/);
});
