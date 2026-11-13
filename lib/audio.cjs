'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { saveResult, processImage } = require('./compression.cjs');

const AUDIO_BITRATES = new Set([64, 96, 128]);
const RUNTIME = process.versions.electron && !process.defaultApp
  ? path.join(process.resourcesPath, 'runtime')
  : path.resolve(__dirname, '../runtime');
const FFMPEG = path.join(RUNTIME, 'ffmpeg.exe');
const FFPROBE = path.join(RUNTIME, 'ffprobe.exe');

function runProcess(executable, args, { signal, timeoutMs = 600000, maxBytes = 32 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = []; let bytes = 0, stderr = '', failure = null;
    const abort = () => { failure = new Error('已取消，未保存当前音频。'); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { failure = new Error('音频处理超时，请稍后重试。'); child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { failure = new Error('音频分析结果过大，未修改文件。'); child.kill(); } else output.push(chunk); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    child.once('error', error => { cleanup(); reject(new Error(error.code === 'ENOENT' ? '内置音频编码器缺失，请保留完整工具目录。' : error.message)); });
    child.once('close', code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr.trim() || '音频编码器执行失败。'));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

async function probeAudio(file, options = {}) {
  const raw = await runProcess(FFPROBE, ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,sample_rate,channels,bit_rate,duration:format=format_name,duration,bit_rate', '-of', 'json', file], options);
  const data = JSON.parse(raw);
  const audios = (data.streams || []).filter(stream => stream.codec_type === 'audio');
  if (audios.length !== 1) throw new Error('音频必须包含且仅包含一条音轨。');
  const stream = audios[0];
  const duration = Number.isFinite(Number(stream.duration)) ? Number(stream.duration) : Number(data.format?.duration);
  const info = { codec: stream.codec_name, format: data.format?.format_name, sampleRate: Number(stream.sample_rate), channels: Number(stream.channels), duration,
    bitrate: Number(stream.bit_rate) || 0 };
  if (!Number.isFinite(info.duration) || info.duration <= 0 || !Number.isInteger(info.sampleRate) || info.sampleRate <= 0 || !Number.isInteger(info.channels) || info.channels <= 0) throw new Error('无法读取有效的音频时长、采样率或声道。');
  if (!info.bitrate) {
    // Opus 不提供名义码率；按音频包负载与包时长计算，排除 OGG 容器开销。
    const packets = JSON.parse(await runProcess(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=size,duration_time', '-of', 'json', file], options));
    let bytes = 0, seconds = 0;
    const allPackets = packets.packets || [];
    // 首尾 Opus 包含预跳过或尾部裁剪，不能将整包字节除以裁剪后的时长。
    const payload = stream.codec_name === 'opus' && allPackets.length > 2 ? allPackets.slice(1, -1) : allPackets;
    for (const packet of payload) { bytes += Number(packet.size) || 0; seconds += Number(packet.duration_time) || 0; }
    info.bitrate = seconds > 0 ? Math.round(bytes * 8 / seconds) : 0;
  }
  if (!Number.isFinite(info.bitrate) || info.bitrate <= 0) throw new Error('无法确定音频码率，未重编码。');
  return info;
}

async function processAudio(entry, options) {
  const target = options.audioBitrate == null ? 128 : Number(options.audioBitrate);
  if (!AUDIO_BITRATES.has(target)) throw new Error('音频码率只支持 128、96 或 64 kbps。');
  const original = await fs.readFile(entry.path);
  const extension = path.extname(entry.path).toLowerCase();
  const details = { kind: 'audio', targetBitrate: target * 1000 };
  if (extension === '.wav') return saveResult(entry, original, { buffer: original, optimized: false, details: { ...details, reason: 'wav-preserved' } }, options);
  if (!['.mp3', '.ogg'].includes(extension)) throw new Error('不支持此音频格式。');
  const before = await probeAudio(entry.path, options);
  if (extension === '.mp3' && (before.codec !== 'mp3' || before.format !== 'mp3')) throw new Error('文件内容不是有效的 MP3。');
  if (extension === '.ogg' && (before.format !== 'ogg' || !['vorbis', 'opus'].includes(before.codec))) throw new Error('OGG 仅支持 Vorbis 或 Opus 音轨。');
  Object.assign(details, { originalBitrate: before.bitrate, codec: before.codec, sampleRate: before.sampleRate, channels: before.channels, duration: before.duration });
  if (before.bitrate <= target * 1000) return saveResult(entry, original, { buffer: original, optimized: false, details: { ...details, reason: 'bitrate-low', finalBitrate: before.bitrate } }, options);

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'media-audio-'));
  try {
    const output = path.join(temporary, 'encoded' + extension);
    const codec = before.codec === 'mp3' ? 'libmp3lame' : before.codec === 'opus' ? 'libopus' : 'libvorbis';
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', entry.path, '-map', '0:a:0', '-map_metadata', '0'];
    if (extension === '.mp3') args.push('-map', '0:v?', '-c:v', 'copy', '-id3v2_version', '3');
    else args.push('-vn');
    args.push('-c:a', codec, '-b:a', target + 'k', '-ar', String(before.sampleRate), '-ac', String(before.channels), '-threads', '2');
    if (before.codec === 'opus') args.push('-vbr', 'off');
    args.push(output);
    await runProcess(FFMPEG, args, options);
    const after = await probeAudio(output, options);
    if (after.codec !== before.codec || after.sampleRate !== before.sampleRate || after.channels !== before.channels
      || Math.abs(after.duration - before.duration) > 0.12) throw new Error('音频格式、时长、采样率或声道校验失败，未保存。');
    await runProcess(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-err_detect', 'explode', '-i', output, '-map', '0:a:0', '-f', 'null', '-'], options);
    const encoded = await fs.readFile(output), optimized = encoded.length < original.length;
    return saveResult(entry, original, { buffer: optimized ? encoded : original, optimized,
      details: { ...details, reason: optimized ? 'compressed' : 'not-smaller', finalBitrate: optimized ? after.bitrate : before.bitrate } }, options);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function processMedia(entry, options) {
  return ['.mp3', '.ogg', '.wav'].includes(path.extname(entry.path).toLowerCase()) ? processAudio(entry, options) : processImage(entry, options);
}

module.exports = { AUDIO_BITRATES, FFMPEG, FFPROBE, runProcess, probeAudio, processAudio, processMedia };
