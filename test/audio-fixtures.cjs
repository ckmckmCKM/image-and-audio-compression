'use strict';
const path = require('node:path');
const { FFMPEG, runProcess } = require('../lib/audio.cjs');

async function createAudio(root, filename, { codec = 'libmp3lame', bitrate = 320, sampleRate = 44100, channels = 2, duration = 2 } = {}) {
  const output = path.join(root, filename);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', `anoisesrc=color=white:amplitude=0.15:sample_rate=${sampleRate}:duration=${duration}:seed=17`, '-ac', String(channels), '-ar', String(sampleRate), '-c:a', codec];
  if (codec !== 'pcm_s16le') args.push('-b:a', bitrate + 'k');
  if (codec === 'libopus') args.push('-vbr', 'off');
  args.push('-metadata', 'title=音频测试', output);
  await runProcess(FFMPEG, args);
  return output;
}
module.exports = { createAudio };
