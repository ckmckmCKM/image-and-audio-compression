'use strict';
const { app, BrowserWindow, dialog, shell, Menu, session } = require('electron');
const path = require('node:path');
const { createApp } = require('../server.cjs');

const smokeRoot = process.argv.includes('--smoke-test') && process.env.MEDIA_COMPRESSOR_SMOKE_DIR;
app.setName('图片与音频压缩');
const userDataRoot = smokeRoot || path.join(app.getPath('appData'), 'MediaCompressor');
require('node:fs').mkdirSync(userDataRoot, { recursive: true });
app.setPath('userData', userDataRoot);
app.setAppUserModelId('com.local.mediacompressor');

let window = null, backend = null, closing = false, closePrompt = false;

async function pickPaths(kind, initialPath) {
  if (!['files', 'folder'].includes(kind)) throw new Error('无效的选择方式。');
  const result = await dialog.showOpenDialog(window, {
    title: kind === 'files' ? '选择图片或音频' : '选择文件夹',
    ...(initialPath ? { defaultPath: initialPath } : {}),
    properties: kind === 'files' ? ['openFile', 'multiSelections'] : ['openDirectory', 'createDirectory'],
    ...(kind === 'files' ? { filters: [
      { name: '图片与音频', extensions: ['png', 'jpg', 'jpeg', 'mp3', 'ogg', 'wav'] },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg'] },
      { name: '音频', extensions: ['mp3', 'ogg', 'wav'] },
    ] } : {}),
  });
  return result.canceled ? [] : result.filePaths;
}

async function openFolder(folder) {
  const error = await shell.openPath(folder);
  if (error) throw new Error('无法打开目录：' + error);
}

async function closeApplication() {
  if (closing || closePrompt) return;
  if (backend?.getJob()?.status === 'running') {
    closePrompt = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: '退出图片与音频压缩',
        message: '当前批次尚未完成，停止后退出？',
        detail: '已完成的文件和原文件备份会保留。',
        buttons: ['继续压缩', '停止并退出'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) return;
      // 等待处理器响应取消并完成临时文件清理和报告写入。
      await backend.stop();
    } finally { closePrompt = false; }
  }
  closing = true;
  await backend?.stop();
  if (backend?.server.listening) {
    await new Promise(resolve => {
      backend.server.close(resolve);
      backend.server.closeIdleConnections();
    });
  }
  window?.destroy();
  app.quit();
}

async function start() {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  backend = await createApp({
    root: app.getPath('userData'),
    outputDir: path.join(smokeRoot || app.getPath('documents'), '图片与音频压缩'),
    picker: pickPaths, opener: openFolder,
  });
  await new Promise((resolve, reject) => {
    backend.server.once('error', reject);
    backend.server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${backend.server.address().port}`;
  backend.setUrl(url);
  backend.server.on('close', () => { if (!closing) void closeApplication(); });
  window = new BrowserWindow({
    width: 1280, height: 920, minWidth: 840, minHeight: 640,
    title: '图片与音频压缩', backgroundColor: '#f5f6f8', show: false,
    icon: path.join(__dirname, '../build/icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (target !== url && target !== url + '/') event.preventDefault();
  });
  window.on('close', event => { if (!closing) { event.preventDefault(); void closeApplication(); } });
  window.on('closed', () => { window = null; });
  await window.loadURL(url);
  if (smokeRoot) {
    try {
      await require('./smoke.cjs').runSmoke({ window, backend, root: smokeRoot });
    } catch (error) {
      await require('node:fs/promises').writeFile(path.join(smokeRoot, 'result.json'), JSON.stringify({ ok: false, error: error.stack }, null, 2));
      process.exitCode = 1;
    }
    await closeApplication();
  } else window.show();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); void closeApplication(); } });
  app.on('window-all-closed', () => { if (!closing) void closeApplication(); });
  app.whenReady().then(start).catch(async error => {
    if (smokeRoot) {
      await require('node:fs/promises').mkdir(smokeRoot, { recursive: true });
      await require('node:fs/promises').writeFile(path.join(smokeRoot, 'result.json'), JSON.stringify({ ok: false, error: error.stack }, null, 2));
    } else dialog.showErrorBox('启动失败', '无法启动图片与音频压缩工具：\n' + error.message);
    closing = true;
    app.exit(1);
  });
}
