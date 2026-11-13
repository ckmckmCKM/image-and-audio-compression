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
        for (let j = 0; j < 100 && state.job.reportPath; j++) {
          if (await fs.stat(state.job.reportPath).catch(() => null)) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
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
