'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { measure } = require('./benchmark-startup.cjs');

async function main() {
  const outDir = path.resolve(process.argv[2] || 'dist');
  const metadata = JSON.parse(await fs.readFile(path.join(outDir, 'portable-cache.json'), 'utf8'));
  assert.equal(path.basename(metadata.cacheId), metadata.cacheId);
  const cache = path.join(process.env.LOCALAPPDATA, 'MediaCompressor/portable', metadata.cacheId);
  const executable = path.join(outDir, metadata.executable);
  const results = [];
  if (!(await fs.stat(cache).catch(() => null))) {
    // Simulate an interrupted preparation with a partially written component.
    // Only a brand-new build cache is mutated; existing user caches are left intact.
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'LICENSE.electron.txt'), 'partial');
    const attempts = await Promise.allSettled([measure(executable), measure(executable)]);
    const failures = attempts.filter(attempt => attempt.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(attempt => attempt.reason), '并发启动测试失败');
    const firstLaunches = attempts.map(attempt => attempt.value);
    results.push({ scenario: 'incomplete-cache-concurrent-launch', launches: firstLaunches.map(result => result.startupMs) });
    assert.deepEqual(await fs.readFile(path.join(cache, 'LICENSE.electron.txt')), await fs.readFile(path.join(outDir, 'win-unpacked/LICENSE.electron.txt')));
    // Both test instances have exited; remove a non-loaded documentation component to verify repair.
    const document = metadata.files.find(name => name.endsWith('使用说明.md'));
    assert.ok(document);
    const imageTime = (await fs.stat(path.join(cache, 'MediaCompressor.exe'))).mtimeMs;
    await fs.unlink(path.join(cache, document));
    results.push({ scenario: 'missing-component-repair', ...await measure(executable) });
    assert.ok((await fs.stat(path.join(cache, document))).isFile());
    assert.equal((await fs.stat(path.join(cache, 'MediaCompressor.exe'))).mtimeMs, imageTime, '修复缺失文件不应重写已有程序');
  }
  const before = await Promise.all(metadata.files.map(async name => (await fs.stat(path.join(cache, name))).mtimeMs));
  const warm = await measure(executable);
  const after = await Promise.all(metadata.files.map(async name => (await fs.stat(path.join(cache, name))).mtimeMs));
  assert.deepEqual(after, before, '再次启动不应重新解压或改写组件');
  assert.equal(await fs.readFile(path.join(cache, '.portable-ready'), 'utf8'), metadata.cacheId);
  results.push({ scenario: 'cached-launch-no-extraction', ...warm });
  await fs.writeFile(path.join(outDir, 'portable-test-results.json'), JSON.stringify({ ok: true, cache, results }, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, cache, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
