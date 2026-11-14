'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractReleaseNotes } = require('../tools/release-notes.cjs');

test('发布说明只包含目标版本，保留中文和子标题，支持 Windows 换行', () => {
  const changelog = '# 更新日志\r\n\r\n## [Unreleased]\r\n\r\n- 尚未发布\r\n\r\n## [0.1.2] - 2026-11-13\r\n\r\n### 修复\r\n\r\n- 修复文件名。\r\n\r\n## [0.1.1]\r\n\r\n- 旧版本\r\n';
  assert.equal(extractReleaseNotes(changelog, '0.1.2'), '## [0.1.2] - 2026-11-13\n\n### 修复\n\n- 修复文件名。\n');
  assert.equal(extractReleaseNotes(changelog, '0.1.1'), '## [0.1.1]\n\n- 旧版本\n');
});

test('缺少、重复或空白版本说明时阻止发布', () => {
  assert.throws(() => extractReleaseNotes('## [Unreleased]\n\n- 待发布\n', '0.1.2'), /必须包含且仅包含一个/);
  assert.throws(() => extractReleaseNotes('## [0.1.2]\n- 一\n## [0.1.2]\n- 二\n', '0.1.2'), /必须包含且仅包含一个/);
  assert.throws(() => extractReleaseNotes('## [0.1.2]\n \n## [0.1.1]\n- 旧版本\n', '0.1.2'), /不能为空/);
});
