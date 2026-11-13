'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { collectMedia, outputNames, MODES } = require('./lib/compression.cjs');
const { AUDIO_BITRATES, processMedia } = require('./lib/audio.cjs');

const ROOT = __dirname;
const INSTANCE = path.join(ROOT, 'data/instance.json');
const APP_ID = 'standalone-image-compressor-v1';

function openExternal(target) {
  // 路径通过参数传递，不拼入 PowerShell 代码。
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools/open.ps1'), target], { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function pickPaths(kind, initialPath) {
  if (process.platform !== 'win32') throw new Error('系统选择窗口仅支持 Windows，请在输入框粘贴路径。');
  if (!['files', 'folder'].includes(kind)) throw new Error('无效的选择方式。');
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools/pick.ps1'), '-Kind', kind];
    if (initialPath) args.push('-InitialPath', initialPath);
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || '无法打开系统选择窗口，请粘贴路径。'));
      try { const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); resolve(Array.isArray(result) ? result : []); }
      catch { reject(new Error('无法读取选择结果，请粘贴路径。')); }
    });
  });
}

function batchName() {
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(/[^0-9]/g, '');
  return '压缩_' + stamp + '_' + crypto.randomBytes(3).toString('hex');
}

async function createApp({ root = ROOT, processFile = processMedia, picker = pickPaths, opener = openExternal, outputDir = path.join(root, 'output') } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const entries = new Map();
  let job = null, controller = null, batchTask = null, serverUrl = '', dialogBusy = false;
  let defaultOutput = outputDir;
  try {
    const prefs = JSON.parse(await fs.readFile(path.join(root, 'data/preferences.json'), 'utf8'));
    if (prefs.root === root && typeof prefs.outputDir === 'string' && path.isAbsolute(prefs.outputDir)) defaultOutput = prefs.outputDir;
  } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }

  function send(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('请求格式无效。'), { status: 415 });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) throw Object.assign(new Error('请求内容过大。'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求数据无效。'); }
  }
  function requireIdle() { if (job?.status === 'running') throw new Error('请等待当前批次结束或先停止。'); }
  function snapshot(batch = job) { if (!batch) return null; const { apiKey, ...publicJob } = batch; return publicJob; }

  async function runBatch(selected, options) {
    const names = outputNames(selected);
    const batch = job;
    const activeController = controller;
    for (let i = 0; i < selected.length; i++) {
      if (activeController.signal.aborted) break;
      const entry = selected[i]; batch.current = entry.path;
      try {
        const result = await processFile(entry, { ...options, relative: names[i], signal: activeController.signal });
        const status = ['wav-preserved', 'bitrate-low'].includes(result.reason) ? 'skipped' : result.optimized ? 'optimized' : 'unchanged';
        batch.results.push({ id: entry.id, path: entry.path, name: entry.relative, kind: entry.kind, status, ...result });
        batch.originalBytes += result.originalBytes; batch.finalBytes += result.finalBytes;
      } catch (error) {
        if (activeController.signal.aborted) break;
        let message = String(error.message || error);
        if (options.apiKey) message = message.split(options.apiKey).join('[已隐藏]');
        batch.results.push({ id: entry.id, path: entry.path, name: entry.relative, kind: entry.kind, status: 'error', error: message });
      }
      batch.processed++;
    }
    batch.status = activeController.signal.aborted ? 'cancelled' : 'completed';
    batch.current = ''; batch.finishedAt = new Date().toISOString();
    await fs.mkdir(path.join(root, 'data/reports'), { recursive: true });
    batch.reportPath = path.join(root, 'data/reports', batch.id + '.json');
    await fs.writeFile(batch.reportPath, JSON.stringify(snapshot(batch), null, 2) + '\n').catch(() => { batch.reportPath = ''; });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    try {
      const host = req.headers.host || '';
      if (serverUrl && host !== new URL(serverUrl).host) return send(res, 403, { error: '访问地址无效。' });
      const url = new URL(req.url, serverUrl || 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { app: APP_ID, root, running: job?.status === 'running' });
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        let content = await fs.readFile(path.join(ROOT, 'public', filename), 'utf8');
        if (filename === 'index.html') content = content.replace('__SESSION_TOKEN__', token);
        res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(content);
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: '页面不存在。' });
      if (req.headers['x-tool-token'] !== token || (req.headers.origin && req.headers.origin !== serverUrl)) return send(res, 403, { error: '请重新打开工具页面。' });
      if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { entries: Array.from(entries.values()), job: snapshot(), outputDir: defaultOutput });
      if (req.method === 'GET' && url.pathname === '/api/report') {
        if (!job || job.status === 'running') throw new Error('当前批次尚未结束。');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="compression-report.json"' });
        return res.end(JSON.stringify(snapshot(), null, 2));
      }
      if (req.method !== 'POST') return send(res, 404, { error: '接口不存在。' });
      const data = await body(req);
      if (url.pathname === '/api/pick') {
        requireIdle();
        if (dialogBusy) throw new Error('已有选择窗口打开。');
        dialogBusy = true;
        try { return send(res, 200, { paths: await picker(data.kind, typeof data.initialPath === 'string' ? data.initialPath : '') }); }
        finally { dialogBusy = false; }
      }
      if (url.pathname === '/api/add') {
        requireIdle();
        const found = await collectMedia(data.paths);
        const seen = new Set(Array.from(entries.values(), item => item.path.toLowerCase()));
        for (const entry of found.entries) if (!seen.has(entry.path.toLowerCase())) { entries.set(entry.id, entry); seen.add(entry.path.toLowerCase()); }
        return send(res, 200, { entries: Array.from(entries.values()), failures: found.failures });
      }
      if (url.pathname === '/api/clear') { requireIdle(); entries.clear(); job = null; return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/remove') { requireIdle(); entries.delete(data.id); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/start') {
        requireIdle();
        if (!entries.size) throw new Error('请先添加图片或音频。');
        if (!MODES.has(data.mode)) throw new Error('请选择压缩方式。');
        const hasImages = Array.from(entries.values()).some(entry => entry.kind === 'image');
        if (hasImages && data.mode === 'tinify' && (!String(data.apiKey || '').trim() || /[\r\n]/.test(data.apiKey))) throw new Error('请填写有效的 Tinify API Key。');
        const audioBitrate = data.audioBitrate == null ? 128 : Number(data.audioBitrate);
        if (!AUDIO_BITRATES.has(audioBitrate)) throw new Error('音频码率只支持 128、96 或 64 kbps。');
        if (!['saveAs', 'overwrite'].includes(data.destination)) throw new Error('请选择保存方式。');
        const outputDir = data.destination === 'saveAs' ? String(data.outputDir || '').trim() : defaultOutput;
        if (!path.isAbsolute(outputDir)) throw new Error('请填写完整的输出目录路径。');
        const id = batchName();
        const outputRoot = path.join(outputDir, id), backupRoot = path.join(root, 'backups', id);
        if (data.destination === 'saveAs') {
          await fs.mkdir(outputRoot, { recursive: true });
          defaultOutput = path.resolve(outputDir);
          await fs.mkdir(path.join(root, 'data'), { recursive: true });
          await fs.writeFile(path.join(root, 'data/preferences.json'), JSON.stringify({ root, outputDir: defaultOutput }, null, 2));
        }
        controller = new AbortController();
        job = { id, status: 'running', mode: data.mode, audioBitrate, destination: data.destination, outputRoot: data.destination === 'overwrite' ? '' : outputRoot,
          backupRoot: data.destination === 'overwrite' ? backupRoot : '', total: entries.size, processed: 0, originalBytes: 0, finalBytes: 0, results: [], current: '', startedAt: new Date().toISOString() };
        const selected = Array.from(entries.values());
        const createdBatch = job;
        batchTask = runBatch(selected, { mode: data.mode, audioBitrate, apiKey: hasImages && data.mode === 'tinify' ? String(data.apiKey || '').trim() : '', overwrite: data.destination === 'overwrite', outputRoot, backupRoot }).catch(error => {
          createdBatch.status = 'failed'; createdBatch.error = '批次中断：' + String(error.message || error); createdBatch.current = '';
        });
        return send(res, 200, { job: snapshot() });
      }
      if (url.pathname === '/api/cancel') { controller?.abort(); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/open-output') {
        const folder = data.kind === 'backup' ? job?.backupRoot : job?.outputRoot || defaultOutput;
        if (!folder || !(await fs.stat(folder).catch(() => null))?.isDirectory()) throw new Error('目录尚未生成。');
        await opener(folder); return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/shutdown') {
        requireIdle();
        res.once('finish', () => { server.close(); server.closeAllConnections(); });
        send(res, 200, { ok: true }); return;
      }
      return send(res, 404, { error: '接口不存在。' });
    } catch (error) { if (!res.headersSent) send(res, error.status || 400, { error: String(error.message || error) }); else res.end(); }
  });
  return { server, token, setUrl(url) { serverUrl = url; }, getJob: snapshot,
    async stop() { controller?.abort(); await batchTask; } };
}

async function main() {
  const stop = process.argv.includes('--stop'), browser = process.argv.includes('--open');
  try {
    const instance = JSON.parse(await fs.readFile(INSTANCE, 'utf8'));
    if (instance.root === ROOT) {
      const response = await fetch(instance.url + '/api/health', { signal: AbortSignal.timeout(1500) });
      const info = await response.json();
      if (info.app === APP_ID && info.root === ROOT) {
        if (stop) {
          const response = await fetch(instance.url + '/api/shutdown', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tool-Token': instance.token }, body: '{}' });
          const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error), { liveTool: true });
        } else if (browser) openExternal(instance.url);
        return;
      }
    }
  } catch (error) { if (error.liveTool) throw error; }
  if (stop) return;
  const app = await createApp();
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  app.setUrl(url);
  await fs.mkdir(path.dirname(INSTANCE), { recursive: true });
  await fs.writeFile(INSTANCE, JSON.stringify({ app: APP_ID, root: ROOT, url, pid: process.pid, token: app.token }));
  app.server.on('close', async () => {
    try { const current = JSON.parse(await fs.readFile(INSTANCE, 'utf8')); if (current.pid === process.pid) await fs.unlink(INSTANCE); } catch {}
  });
  console.log(`图片与音频压缩工具已启动：${url}`);
  if (browser) openExternal(url);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createApp, pickPaths };
