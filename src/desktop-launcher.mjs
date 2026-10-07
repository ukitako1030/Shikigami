import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir, ensureService } from './service.mjs';

fs.mkdirSync(dataDir, { recursive: true });

const chromeCandidates = [
  process.env.SHIKIGAMI_CHROME_PATH,
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

const chrome = chromeCandidates.find(candidate => fs.existsSync(candidate));
if (!chrome) {
  throw new Error('Google Chrome が見つかりません。Chrome をインストールしてから再度起動してください。');
}

const session = await ensureService();
if (!/^http:\/\/127\.0\.0\.1:\d+\/panel\/[a-f0-9]{48}$/.test(session.panel)) {
  throw new Error('Shikigami の画面URLが不正です。');
}

const uiProfile = path.join(dataDir, 'ui-profile');
fs.mkdirSync(uiProfile, { recursive: true });
const child = spawn(chrome, [
  `--user-data-dir=${uiProfile}`,
  `--app=${session.panel}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--window-size=1200,820',
], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
});
child.on('error', error => { console.error(`Shikigami の画面を開けませんでした: ${error.message}`); process.exitCode = 1; });
child.unref();
