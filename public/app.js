'use strict';
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name=tool-token]').content;
let state = { entries: [], job: null }, busy = false, polling = null, closed = false;
const descriptions = { lossless: 'PNG 无损；JPEG 质量 90。', high: 'PNG 调色板最多 256 色；JPEG 质量 80。', extreme: 'PNG 调色板最多 128 色；JPEG 质量 60。适合优先减小体积。', tinify: '由 Tinify 智能压缩，保留原文件格式。' };
const size = value => value >= 1048576 ? (value / 1048576).toFixed(2) + ' MB' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';
const destination = () => document.querySelector('input[name=destination]:checked').value;

async function api(route, data) {
  const response = await fetch('/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Tool-Token': token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}
function notice(text = '', error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; $('notice').hidden = !text; }
function settings() {
  const imagesOn = $('compress-images').checked;
  $('mode-help').textContent = descriptions[$('mode').value];
  $('key-field').hidden = !imagesOn || $('mode').value !== 'tinify';
  $('privacy-text').textContent = imagesOn && $('mode').value === 'tinify' ? '使用 Tinify 时需要联网' : '本地压缩无需联网';
  $('output-field').hidden = destination() === 'overwrite';
  $('overwrite-note').hidden = destination() !== 'overwrite';
  locks();
}
function locks() {
  const running = closed || busy || state.job?.status === 'running';
  const imagesOn = $('compress-images').checked;
  const audioOn = $('compress-audio').checked;
  for (const id of ['pick-files', 'pick-folder', 'pick-output', 'add-paths', 'api-key', 'output-dir', 'paths', 'compress-images', 'compress-audio']) $(id).disabled = running;
  $('mode').disabled = running || !imagesOn;
  $('audio-bitrate').disabled = running || !audioOn;
  for (const radio of document.querySelectorAll('input[name=destination]')) radio.disabled = running;
  for (const button of document.querySelectorAll('.remove')) button.disabled = running;
  $('clear').disabled = running || !state.entries.length;
  $('start').disabled = running || !state.entries.length || (!imagesOn && !audioOn);
  $('start').title = !imagesOn && !audioOn ? '请至少勾选图片压缩或音频压缩。' : '';
  $('start').textContent = closed ? '工具已退出' : state.job?.status === 'running' ? '正在压缩…' : '开始压缩';
  $('cancel').hidden = state.job?.status !== 'running';
  $('quit').disabled = running;
}
function render() {
  const job = state.job;
  const results = new Map((job?.results || []).map(item => [item.id, item]));
  $('file-count').textContent = state.entries.length + ' 个';
  $('empty').hidden = !!state.entries.length;
  $('table-wrap').hidden = !state.entries.length;
  const fragment = document.createDocumentFragment();
  for (const entry of state.entries) {
    const result = results.get(entry.id), row = document.createElement('tr');
    const name = document.createElement('td'), title = document.createElement('div'), filepath = document.createElement('span');
    title.className = 'file-name';
    const kind = document.createElement('span'); kind.className = 'file-kind'; kind.textContent = entry.name.split('.').pop().toUpperCase();
    const filename = document.createElement('span'); filename.textContent = entry.relative; title.append(kind, filename);
    filepath.className = 'file-path'; filepath.textContent = entry.path; filepath.title = entry.path;
    name.append(title, filepath); row.append(name);
    if (result?.originalBitrate) {
      const audioInfo = document.createElement('span'); audioInfo.className = 'file-audio';
      audioInfo.textContent = `${Math.round(result.originalBitrate / 1000)} → ${Math.round(result.finalBitrate / 1000)} kbps · ${result.sampleRate} Hz · ${result.channels} 声道`;
      name.append(audioInfo);
    }
    for (const value of [size(result?.originalBytes ?? entry.bytes), result && result.status !== 'error' && result.reason !== 'compression-off' ? size(result.finalBytes) : '—']) {
      const cell = document.createElement('td'); cell.className = 'number'; cell.textContent = value; row.append(cell);
    }
    const status = document.createElement('td'); status.className = 'result';
    if (result?.status === 'optimized') { status.textContent = '减小 ' + ((1 - result.finalBytes / result.originalBytes) * 100).toFixed(1).replace(/\.0$/, '') + '%'; status.classList.add('success'); }
    else if (result?.status === 'error') { status.textContent = '失败'; status.classList.add('failure'); status.title = result.error; }
    else if (result) {
      status.textContent = result.reason === 'compression-off' ? '已跳过' : result.reason === 'wav-preserved' ? '保留 WAV' : result.reason === 'bitrate-low' ? '无需降码率' : job.destination === 'overwrite' ? '保留原文件' : '原样另存';
      status.classList.add('unchanged');
      if (result.reason === 'bitrate-low') status.title = '源音频码率不高于目标，不重复编码。';
      if (result.reason === 'compression-off') status.title = '未勾选此项压缩，文件未改动。';
    }
    else status.textContent = job?.status === 'running' && job.current === entry.path ? '处理中' : '待处理';
    row.append(status);
    const action = document.createElement('td'), remove = document.createElement('button'); remove.className = 'remove'; remove.textContent = '×'; remove.title = '移除文件'; remove.setAttribute('aria-label', '移除 ' + entry.name);
    remove.disabled = busy || job?.status === 'running'; remove.onclick = () => perform(async () => { await api('remove', { id: entry.id }); await refresh(); });
    action.append(remove); row.append(action); fragment.append(row);
    if (result?.status === 'error') {
      const errorRow = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'failure'; cell.textContent = result.error; errorRow.append(cell); fragment.append(errorRow);
    }
  }
  $('file-list').replaceChildren(fragment);
  $('progress-panel').hidden = !job;
  $('summary').hidden = !job || job.status === 'running';
  $('result-actions').hidden = !job || job.status === 'running';
  if (job) {
    $('progress').max = job.total || 1; $('progress').value = job.processed;
    $('progress-title').textContent = ({ running: '正在压缩', completed: '批次完成', cancelled: '批次已停止', failed: '批次中断' })[job.status];
    $('progress-count').textContent = `${job.processed} / ${job.total}`;
    $('current-file').textContent = job.current || (job.destination === 'overwrite' ? '原文件备份：' + job.backupRoot : '输出目录：' + job.outputRoot);
    $('size-summary').textContent = size(job.originalBytes) + ' → ' + size(job.finalBytes);
    $('saved-summary').textContent = size(job.originalBytes - job.finalBytes);
    const errors = job.results.filter(item => item.status === 'error').length;
    const optimized = job.results.filter(item => item.status === 'optimized').length;
    const kept = job.results.filter(item => ['unchanged', 'skipped'].includes(item.status)).length;
    $('result-summary').textContent = `${optimized} 压缩 / ${kept} 保留 / ${errors} 失败`;
    $('open-output').hidden = job.destination === 'overwrite';
    $('open-backup').hidden = job.destination !== 'overwrite' || !job.results.some(item => item.backup);
    if (job.error) notice(job.error, true);
  }
  locks();
}
async function refresh() { state = await api('state'); if (!$('output-dir').value) $('output-dir').value = state.outputDir; render(); }
async function perform(action) {
  if (busy) return;
  busy = true; locks();
  try { await action(); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; locks(); }
}
async function add(paths) {
  if (!paths.length) return;
  notice();
  const added = await api('add', { paths });
  if (added.failures.length) notice(added.failures.map(f => f.path + '：' + f.error).join('\n'), true);
  else if (!added.entries.length) notice('没有找到 PNG、JPG、JPEG、MP3、OGG 或 WAV 文件。');
  await refresh();
}
async function pick(kind, output = false) {
  const result = await api('pick', { kind, initialPath: output ? $('output-dir').value : '' });
  if (output) { if (result.paths[0]) $('output-dir').value = result.paths[0]; }
  else await add(result.paths);
}
$('mode').onchange = settings;
$('compress-images').onchange = settings;
$('compress-audio').onchange = settings;
for (const radio of document.querySelectorAll('input[name=destination]')) radio.onchange = settings;
$('toggle-path').onclick = () => { $('path-box').hidden = !$('path-box').hidden; if (!$('path-box').hidden) $('paths').focus(); };
$('pick-files').onclick = () => perform(() => pick('files'));
$('pick-folder').onclick = () => perform(() => pick('folder'));
$('pick-output').onclick = () => perform(() => pick('folder', true));
$('add-paths').onclick = () => perform(async () => { await add($('paths').value.split(/\r?\n/).map(v => v.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)); $('paths').value = ''; });
$('clear').onclick = () => perform(async () => { await api('clear', {}); notice(); await refresh(); });
$('start').onclick = () => perform(async () => {
  notice();
  await api('start', { mode: $('mode').value, audioBitrate: Number($('audio-bitrate').value), compressImages: $('compress-images').checked, compressAudio: $('compress-audio').checked, destination: destination(), outputDir: $('output-dir').value, apiKey: $('compress-images').checked && $('mode').value === 'tinify' ? $('api-key').value.trim() : '' });
  await refresh(); poll();
});
$('cancel').onclick = () => perform(async () => { await api('cancel', {}); await refresh(); });
$('open-output').onclick = () => perform(() => api('open-output', {}));
$('open-backup').onclick = () => perform(() => api('open-output', { kind: 'backup' }));
$('download-report').onclick = () => perform(async () => {
  const report = await api('report');
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = '媒体压缩报告.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
});
$('quit').onclick = () => perform(async () => { await api('shutdown', {}); clearTimeout(polling); closed = true; notice('工具已退出，可以关闭此页面。'); state.entries = []; });
function poll() {
  clearTimeout(polling);
  polling = setTimeout(async () => {
    try { await refresh(); if (state.job?.status === 'running') poll(); }
    catch (error) { notice('与本地服务的连接已断开，请重新双击启动工具。', true); }
  }, 450);
}
settings();
refresh().then(() => { if (state.job?.status === 'running') poll(); }).catch(error => notice(error.message, true));
