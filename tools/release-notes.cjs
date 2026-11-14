'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

function extractReleaseNotes(changelog, version) {
  const text = changelog.replace(/\r\n/g, '\n');
  const headings = [...text.matchAll(/^## \[([^\]\n]+)\][^\n]*$/gm)];
  const matches = headings.filter(heading => heading[1] === version);
  if (matches.length !== 1) throw new Error(`CHANGELOG.md 必须包含且仅包含一个 ## [${version}] 版本章节。`);
  const heading = matches[0];
  const next = headings[headings.indexOf(heading) + 1];
  const body = text.slice(heading.index + heading[0].length, next?.index ?? text.length).trim();
  if (!body) throw new Error(`CHANGELOG.md 中 ${version} 的更新说明不能为空。`);
  return `${heading[0]}\n\n${body}\n`;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const output = process.argv[2];
  if (!output) throw new Error('用法：node tools/release-notes.cjs <输出文件>');
  const version = require('../package.json').version;
  const notes = extractReleaseNotes(await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
  const destination = path.resolve(output);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, notes, 'utf8');
  console.log(`已生成 v${version} 更新说明：${destination}`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { extractReleaseNotes };
