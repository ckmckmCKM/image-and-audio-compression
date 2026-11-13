'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" rx="54" fill="#2e507d"/>
    <rect x="43" y="46" width="124" height="106" rx="14" fill="none" stroke="#fff" stroke-width="12"/>
    <circle cx="131" cy="78" r="12" fill="#b8d9ed"/>
    <path d="M49 135l38-42 30 30 18-18 28 30" fill="none" stroke="#b8d9ed" stroke-width="10" stroke-linejoin="round"/>
    <path d="M181 106v84c0 28-44 28-44 5 0-18 25-23 44-14m0-69 30-9v26l-30 9" fill="#fff"/>
    <path d="M53 184h52m-17-17 17 17-17 17" fill="none" stroke="#b8d9ed" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`);
  const png = await sharp(svg).png().toBuffer();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(22, 18);
  const directory = path.resolve(__dirname, '../build');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'icon.png'), png);
  await fs.writeFile(path.join(directory, 'icon.ico'), Buffer.concat([header, png]));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
