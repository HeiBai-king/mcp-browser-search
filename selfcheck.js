#!/usr/bin/env node
// 自检：确认这套东西在你机器上能不能跑起来。
// 用法：node selfcheck.js
// 它只做检查，不启动 MCP 服务器。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { homedir } from 'node:os';

const CDP_PORT = Number(process.env.BROWSER_CDP_PORT || 9222);
const PROFILE = process.env.BROWSER_SEARCH_PROFILE || path.join(homedir(), '.mcp-browser-profile');

const ok = (s) => console.log('  [OK]   ' + s);
const warn = (s) => console.log('  [WARN] ' + s);
const bad = (s) => console.log('  [FAIL] ' + s);

function findBrowser() {
  const c = [];
  if (process.platform === 'win32') {
    const base = process.env.PROGRAMFILES || 'C:\\Program Files';
    const base86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    c.push(
      `${base86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${base}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${base}\\Google\\Chrome\\Application\\chrome.exe`,
      `${base86}\\Google\\Chrome\\Application\\chrome.exe`,
      local ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : '',
    );
  } else if (process.platform === 'darwin') {
    c.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    c.push(
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    );
  }
  return c.find((p) => p && fs.existsSync(p)) || '';
}

function cdpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: CDP_PORT, path: p, method: 'GET', timeout: 3000 },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('CDP 返回的不是 JSON')); } });
      },
    );
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.on('error', reject);
    req.end();
  });
}

console.log('\nmcp-browser-search 自检\n');

// 1. Node 版本
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node}（需要 >= 18）`);

// 2. 浏览器
const exe = process.env.BROWSER_SEARCH_EXE || findBrowser();
if (exe && fs.existsSync(exe)) ok(`浏览器: ${exe}`);
else if (process.env.BROWSER_SEARCH_EXE) bad(`BROWSER_SEARCH_EXE 指向的文件不存在: ${process.env.BROWSER_SEARCH_EXE}`);
else bad('没找到 Chrome / Edge / Chromium。装一个，或用 BROWSER_SEARCH_EXE 指定路径。');

// 3. profile 目录
ok(`专用 profile: ${PROFILE}${fs.existsSync(PROFILE) ? '（已存在）' : '（还没建，首次运行会自动创建）'}`);

// 4. 依赖
try {
  await import('@modelcontextprotocol/sdk/server/mcp.js');
  await import('zod');
  ok('依赖齐全（@modelcontextprotocol/sdk / zod）');
} catch (e) {
  bad('依赖没装好，先跑 npm install —— ' + e.message);
}

// 5. CDP 端口
try {
  const v = await cdpGet('/json/version');
  ok(`CDP ${CDP_PORT} 已在运行: ${v.Browser || '?'}`);
  try {
    const list = await cdpGet('/json/list');
    const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
    ok(`当前标签页 ${pages.length} 个` + (pages[0] ? `，第一个: ${String(pages[0].url || '').slice(0, 80)}` : ''));
  } catch { /* 忽略 */ }
} catch {
  warn(`CDP ${CDP_PORT} 还没起来 —— 这很正常，第一次调用工具时会自动拉起浏览器。`);
  warn('如果你想现在就看到它，随便调一次 web_open 就会启动。');
}

console.log('\n完成。把上面这段贴给帮你配置的人/AI 也行。\n');
