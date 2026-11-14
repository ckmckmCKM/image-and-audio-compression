'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { createApp } = require('../server.cjs');

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-tool-http-'));
  const app = await createApp({ root, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`; app.setUrl(url);
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  async function request(route, data, headers = {}) {
    const response = await fetch(url + '/api/' + route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-Tool-Token': app.token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { response, data: await response.json() };
  }
  async function waitDone() {
    for (let i = 0; i < 200; i++) {
      const state = (await request('state')).data;
      if (state.job && state.job.status !== 'running') {
        return state;
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Batch timed out');
  }
  return { root, app, url, request, waitDone };
}

test('HTTP save-as, Unicode inputs, failures continue, reports and no key leakage', async t => {
  const { root, url, app, request, waitDone } = await setup(t);
  const image = await sharp({ create: { width: 150, height: 150, channels: 4, background: '#bba077cc' } }).png({ compressionLevel: 0 }).toBuffer();
  const good = path.join(root, '钥匙.png'), bad = path.join(root, 'bad.png');
  await fs.writeFile(good, image); await fs.writeFile(bad, 'invalid image');
  assert.equal((await request('state')).data.outputDir, path.join(root, 'output'));
  assert.equal((await request('state', undefined, { 'X-Tool-Token': 'wrong' })).response.status, 403);
  assert.equal((await request('clear', {}, { Origin: 'https://other.example' })).response.status, 403);
  const html = await (await fetch(url)).text(); assert.ok(html.includes(app.token)); assert.ok(!html.includes('__SESSION_TOKEN__'));
  await request('add', { paths: [bad, good] });
  assert.equal((await request('start', { mode: 'tinify', destination: 'saveAs', outputDir: path.join(root, 'out') })).response.status, 400);
  const started = await request('start', { mode: 'high', destination: 'saveAs', outputDir: path.join(root, 'out'), apiKey: 'secret-not-needed' });
  assert.equal(started.response.status, 200);
  const done = await waitDone();
  assert.equal(done.job.status, 'completed'); assert.equal(done.job.processed, 2);
  assert.equal(done.job.results.filter(r => r.status === 'error').length, 1);
  assert.equal(done.job.results.filter(r => r.status === 'optimized').length, 1);
  assert.deepEqual(await fs.readFile(good), image);
  const report = await request('report');
  assert.ok(!JSON.stringify(report.data).includes('secret-not-needed'));
  assert.ok(!JSON.stringify(report.data).includes('apiKey'));
  assert.equal((await fs.readdir(path.join(root, 'out'))).length, 1);
  const firstBatch = done.job.id;
  await request('start', { mode: 'lossless', destination: 'saveAs', outputDir: path.join(root, 'out') });
  const second = await waitDone(); assert.notEqual(second.job.id, firstBatch);
  assert.equal((await fs.readdir(path.join(root, 'out'))).length, 2);
  assert.equal(JSON.parse(await fs.readFile(done.job.reportPath, 'utf8')).id, firstBatch);
});

test('batch stays running until its report directory and file are ready', async t => {
  const { root, app, request, waitDone } = await setup(t, {
    processFile: async entry => ({ optimized: false, originalBytes: 5, finalBytes: 5, output: entry.path }),
  });
  const reportDirectory = path.join(root, 'data/reports');
  let directoryEntered, releaseDirectory, writeEntered, releaseWrite;
  const directoryStarted = new Promise(resolve => { directoryEntered = resolve; });
  const directoryReady = new Promise(resolve => { releaseDirectory = resolve; });
  const writeStarted = new Promise(resolve => { writeEntered = resolve; });
  const writeReady = new Promise(resolve => { releaseWrite = resolve; });
  const mkdir = fs.mkdir, writeFile = fs.writeFile;
  t.mock.method(fs, 'mkdir', async (directory, ...args) => {
    if (directory === reportDirectory) { directoryEntered(); await directoryReady; }
    return mkdir(directory, ...args);
  });
  t.mock.method(fs, 'writeFile', async (filename, ...args) => {
    if (path.dirname(filename) === reportDirectory) { writeEntered(); await writeReady; }
    return writeFile(filename, ...args);
  });
  try {
    const input = path.join(root, 'test.png');
    await fs.writeFile(input, 'input');
    await request('add', { paths: [input] });
    const options = { mode: 'high', destination: 'overwrite' };
    assert.equal((await request('start', options)).response.status, 200);
    await directoryStarted;
    const preparing = (await request('state')).data.job;
    assert.equal(preparing.status, 'running', '创建报告目录期间仍应锁定当前批次');
    assert.equal(preparing.reportPath, undefined);
    assert.equal((await request('start', options)).response.status, 400);
    assert.equal((await request('report')).response.status, 400);
    releaseDirectory();
    await writeStarted;
    assert.equal((await request('state')).data.job.status, 'running', '报告写入完成前不能公布完成状态');
    assert.equal((await request('clear', {})).response.status, 400);
    assert.equal((await request('report')).response.status, 400);
    releaseWrite();
    const done = (await waitDone()).job;
    assert.equal(done.status, 'completed');
    const report = JSON.parse(await fs.readFile(done.reportPath, 'utf8'));
    assert.equal(report.id, preparing.id);
    assert.equal(report.status, 'completed');
    assert.equal(report.finishedAt, done.finishedAt);
    assert.deepEqual((await request('report')).data, report);
  } finally {
    releaseDirectory(); releaseWrite();
    await app.stop();
  }
});

test('HTTP cancellation, picker cancellation and shutdown/queue guards', async t => {
  let entered;
  const began = new Promise(resolve => entered = resolve);
  const { root, request, waitDone } = await setup(t, {
    picker: async () => [],
    processFile: async (entry, options) => {
      entered();
      await new Promise(resolve => setTimeout(resolve, 60));
      if (options.signal.aborted) throw new Error('cancelled');
      return { optimized: true, originalBytes: 100, finalBytes: 50, output: entry.path };
    },
  });
  const image = path.join(root, 'test.png'); await fs.writeFile(image, 'input');
  assert.deepEqual((await request('pick', { kind: 'files' })).data.paths, []);
  await request('add', { paths: [image] });
  await request('start', { mode: 'high', destination: 'overwrite' });
  await began;
  assert.equal((await request('clear', {})).response.status, 400);
  assert.equal((await request('shutdown', {})).response.status, 400);
  await request('cancel', {});
  const done = await waitDone(); assert.equal(done.job.status, 'cancelled'); assert.equal(done.job.processed, 0);
  await request('clear', {}); assert.equal((await request('state')).data.entries.length, 0);
});

test('Tinify key is redacted even when a compressor error contains the key', async t => {
  const { root, request, waitDone } = await setup(t, { processFile: async () => { throw new Error('failed with private-example-key'); } });
  const file = path.join(root, 'test.png'); await fs.writeFile(file, 'input');
  await request('add', { paths: [file] });
  await request('start', { mode: 'tinify', destination: 'saveAs', outputDir: path.join(root, 'output'), apiKey: 'private-example-key' });
  const done = await waitDone();
  assert.ok(!JSON.stringify(done).includes('private-example-key'));
  assert.equal(done.job.results[0].error, 'failed with [已隐藏]');
});

test('desktop adapters use writable defaults, open folders and await cancellation cleanup', async t => {
  const outputDir = path.join(os.tmpdir(), 'desktop-output');
  let opened = '', entered, cleaned = false;
  const began = new Promise(resolve => entered = resolve);
  const { root, app, request } = await setup(t, {
    outputDir,
    opener: async folder => { opened = folder; },
    processFile: async (_entry, { signal }) => {
      entered();
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
      cleaned = true;
      signal.throwIfAborted();
    },
  });
  assert.equal((await request('state')).data.outputDir, outputDir);
  const input = path.join(root, 'test.png');
  await fs.writeFile(input, 'fixture');
  await request('add', { paths: [input] });
  await request('start', { mode: 'high', destination: 'overwrite' });
  await began;
  await app.stop();
  assert.equal(cleaned, true);
  assert.equal(app.getJob().status, 'cancelled');
  assert.ok((await fs.stat(app.getJob().reportPath)).isFile());
  await fs.mkdir(app.getJob().backupRoot, { recursive: true });
  assert.equal((await request('open-output', { kind: 'backup' })).response.status, 200);
  assert.equal(opened, app.getJob().backupRoot);
});

test('shutdown closes unused browser preconnections after delivering the response', { timeout: 3000 }, async t => {
  const { app, request } = await setup(t);
  const idle = require('node:net').createConnection(app.server.address().port, '127.0.0.1');
  idle.on('error', () => {});
  t.after(() => idle.destroy());
  await require('node:events').once(idle, 'connect');
  const closed = require('node:events').once(app.server, 'close');
  const response = await request('shutdown', {});
  assert.equal(response.response.status, 200);
  assert.equal(response.data.ok, true);
  await closed;
  assert.equal(app.server.listening, false);
});
