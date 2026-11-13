'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sharp = require('sharp');

// 与 Cocos 图片压缩器一致，读取、编码及结果校验均允许原尺寸大图。
const SHARP_INPUT_OPTIONS = { failOn: 'error', limitInputPixels: false };

const MODES = new Set(['lossless', 'high', 'extreme', 'tinify']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.wav']);
const hash = buffer => crypto.createHash('sha256').update(buffer).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

function pngOptions(mode) {
  if (mode === 'high') return { compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: true, quality: 85, colours: 256, dither: 1 };
  if (mode === 'extreme') return { compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: true, quality: 65, colours: 128, dither: 0.8 };
  return { compressionLevel: 9, adaptiveFiltering: true, effort: 10, palette: false };
}

async function collectImages(paths, extensions = IMAGE_EXTENSIONS) {
  if (!Array.isArray(paths) || paths.length > 5000) throw new Error('请选择文件或文件夹。');
  const entries = [], failures = [], seen = new Set();
  async function visit(file, root) {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        const children = await fs.readdir(file, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) await visit(path.join(file, child.name), root || file);
      } else if (stat.isFile() && extensions.has(path.extname(file).toLowerCase())) {
        const real = await fs.realpath(file);
        const key = process.platform === 'win32' ? real.toLowerCase() : real;
        if (seen.has(key)) return;
        seen.add(key);
        entries.push({ id: crypto.randomUUID(), path: real, name: path.basename(real), relative: root ? path.join(path.basename(root), path.relative(root, file)) : path.basename(real), bytes: stat.size, kind: AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()) ? 'audio' : 'image' });
      }
    } catch (error) { failures.push({ path: file, error: error.code === 'ENOENT' ? '路径不存在' : '无法读取该路径：' + error.message }); }
  }
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    await visit(path.resolve(raw.trim()), null);
  }
  return { entries, failures };
}

async function collectMedia(paths) {
  return collectImages(paths, new Set(Array.from(IMAGE_EXTENSIONS).concat(Array.from(AUDIO_EXTENSIONS))));
}

function outputNames(entries) {
  const used = new Set();
  return entries.map(entry => {
    const parsed = path.parse(entry.relative);
    let name = entry.relative, count = 2;
    while (used.has(name.toLowerCase())) name = path.join(parsed.dir, `${parsed.name}_${count++}${parsed.ext}`);
    used.add(name.toLowerCase());
    return name;
  });
}

async function tinifyEncode(buffer, extension, key, { fetchImpl = fetch, signal } = {}) {
  if (!key || /[\r\n]/.test(key)) throw new Error('请先填写 Tinify API Key。');
  const authorization = 'Basic ' + Buffer.from('api:' + key).toString('base64');
  async function request(url, init) {
    const timeout = AbortSignal.timeout(120000);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    return fetchImpl(url, { ...init, signal: combined, redirect: 'error' });
  }
  const response = await request('https://api.tinify.com/shrink', {
    method: 'POST', headers: { Authorization: authorization, 'Content-Type': extension === '.png' ? 'image/png' : 'image/jpeg' }, body: buffer,
  });
  if (response.status !== 201) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Tinify 压缩失败 (${response.status})：${body.message || '请检查 API Key、配额和网络。'}`);
  }
  let url;
  try { url = new URL(response.headers.get('location')); } catch { throw new Error('Tinify 未返回有效的下载地址。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.tinify.com' || url.username || url.password) throw new Error('Tinify 下载地址无效。');
  const downloaded = await request(url.toString(), { headers: { Authorization: authorization } });
  if (downloaded.status !== 200) throw new Error(`Tinify 下载失败 (${downloaded.status})。`);
  return { buffer: Buffer.from(await downloaded.arrayBuffer()), compressionCount: response.headers.get('compression-count') || '' };
}

async function encode(original, extension, mode, options = {}) {
  if (!MODES.has(mode)) throw new Error('不支持的压缩方式。');
  const before = await sharp(original, SHARP_INPUT_OPTIONS).metadata();
  if (!['png', 'jpeg'].includes(before.format) || (before.pages || 1) > 1) throw new Error('仅支持静态 PNG、JPG、JPEG 图片。');
  if ((extension === '.png') !== (before.format === 'png')) throw new Error('图片内容与扩展名不一致。');
  const tiny = mode === 'tinify' ? await tinifyEncode(original, extension, options.apiKey, options) : null;
  const buffer = tiny ? tiny.buffer : extension === '.png'
    ? await sharp(original, SHARP_INPUT_OPTIONS).png(pngOptions(mode)).toBuffer()
    : await sharp(original, SHARP_INPUT_OPTIONS).rotate().jpeg({ quality: mode === 'extreme' ? 60 : mode === 'high' ? 80 : 90, mozjpeg: true }).toBuffer();
  const after = await sharp(buffer, SHARP_INPUT_OPTIONS).metadata();
  const swaps = !tiny && extension !== '.png' && [5, 6, 7, 8].includes(before.orientation);
  if (after.format !== before.format || after.width !== (swaps ? before.height : before.width)
    || after.height !== (swaps ? before.width : before.height)) throw new Error('压缩后的图片格式、尺寸或透明通道异常，已停止保存。');
  // 调色板编码可去掉全为 255 的冗余 Alpha；真实透明图片仍禁止丢失透明信息。
  if (extension === '.png' && before.hasAlpha && !after.hasAlpha
    && !(await sharp(original, SHARP_INPUT_OPTIONS).stats()).isOpaque) {
    throw new Error('压缩后的图片格式、尺寸或透明通道异常，已停止保存。');
  }
  await sharp(buffer, SHARP_INPUT_OPTIONS).raw().toBuffer();
  return { buffer: buffer.length < original.length ? buffer : original, optimized: buffer.length < original.length, compressionCount: tiny?.compressionCount || '' };
}

async function retryCopy(from, to, flags) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.copyFile(from, to, flags); return; }
    catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'UNKNOWN', 'ETXTBSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function processImage(entry, options) {
  const original = await fs.readFile(entry.path);
  const result = await encode(original, path.extname(entry.path).toLowerCase(), options.mode, options);
  return saveResult(entry, original, result, options);
}

async function saveResult(entry, original, result, options) {
  if (options.signal?.aborted) throw new Error('已取消，未保存当前文件。');
  const destination = options.overwrite ? entry.path : path.resolve(options.outputRoot, options.relative);
  if (!options.overwrite && (!inside(options.outputRoot, destination) || destination.toLowerCase() === entry.path.toLowerCase())) throw new Error('输出路径与原文件冲突。');
  let backup = '';
  if (options.overwrite && !result.optimized) return { originalBytes: original.length, finalBytes: original.length, optimized: false, output: entry.path, backup, compressionCount: result.compressionCount, ...result.details };
  if (options.overwrite) {
    if (hash(await fs.readFile(entry.path)) !== hash(original)) throw new Error('压缩期间原文件发生变化，请重新添加后再试。');
    backup = path.resolve(options.backupRoot, options.relative);
    if (!inside(options.backupRoot, backup)) throw new Error('备份路径无效。');
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, original, { flag: 'wx' });
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'media-compressor-'));
  try {
    const file = path.join(temporary, 'encoded');
    await fs.writeFile(file, result.buffer);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (options.signal?.aborted) throw new Error('已取消，未保存当前文件。');
    if (options.overwrite && hash(await fs.readFile(entry.path)) !== hash(original)) throw new Error('保存前原文件发生变化，未覆盖。');
    await retryCopy(file, destination, options.overwrite ? 0 : require('node:fs').constants.COPYFILE_EXCL);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return { originalBytes: original.length, finalBytes: result.buffer.length, optimized: result.optimized, output: destination, backup, compressionCount: result.compressionCount, ...result.details };
}

module.exports = { MODES, IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, collectImages, collectMedia, outputNames, encode, pngOptions, tinifyEncode, processImage, saveResult, inside };
