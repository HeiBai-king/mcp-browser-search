#!/usr/bin/env node
// mcp-browser-search — a Web Search / Fetch MCP server that drives a real browser.
//
// Why: instead of scraping search engines over plain HTTP, this server talks to a
// Chromium-based browser through CDP (Chrome DevTools Protocol) and behaves like a
// person using it — with that profile's cookies, login state and real fingerprint.
// That makes it far more reliable against bot detection, and it can read pages that
// only exist after you log in.
//
// Works with any MCP client (Claude Desktop, Cursor, DSH, ...). Transport: stdio.
//
// Tools: web_search / web_open / web_read / web_click / web_type / browser_status
//
// Environment variables (all optional):
//   BROWSER_CDP_PORT              CDP port, default 9222
//   BROWSER_SEARCH_ENGINE         google | bing | baidu, default google
//   BROWSER_SEARCH_ALLOW_PRIVATE  set to 1 to allow localhost / private addresses
//   BROWSER_SEARCH_AUTOSTART      set to 0 to never launch a browser automatically
//   BROWSER_SEARCH_EXE            path to the browser executable
//   BROWSER_SEARCH_PROFILE        dedicated profile directory (keeps logins separate)
//
// Search engines: google, bing (international results, adult filter off), baidu.
// With no engine requested it tries google, then bing, then baidu, and reports which
// ones failed. Google needs working internet access to Google.
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dnsLookup = dns.promises.lookup;

// ───────────────────────── 配置 ─────────────────────────
const CDP_PORT = Number(process.env.BROWSER_CDP_PORT || 9222);
const DEFAULT_ENGINE = (process.env.BROWSER_SEARCH_ENGINE || 'google').toLowerCase();
const ALLOW_PRIVATE = process.env.BROWSER_SEARCH_ALLOW_PRIVATE === '1';
const AUTOSTART = process.env.BROWSER_SEARCH_AUTOSTART !== '0';
const MAX_TEXT = 200000;

// 浏览器可执行文件：按平台自动找 Edge / Chrome。找不到就用 BROWSER_SEARCH_EXE 指定。
function defaultBrowserExe() {
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
      '/usr/bin/chromium', '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    );
  }
  return c.find((p) => p && fs.existsSync(p)) || c.find(Boolean) || 'google-chrome';
}

const BROWSER_EXE = process.env.BROWSER_SEARCH_EXE || defaultBrowserExe();
// 专用 profile：跟日常浏览器隔离，登录态存在这里。
const BROWSER_PROFILE = process.env.BROWSER_SEARCH_PROFILE
  || path.join(homedir(), '.mcp-browser-profile');

function log(...a) {
  // stdio 传输下 stdout 归协议，日志一律走 stderr
  try { process.stderr.write('[browser-search] ' + a.join(' ') + '\n'); } catch {}
}

// ───────────────────────── 通用工具 ─────────────────────────
function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── 内网防护（可关）─────────────────────────
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::') || lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  return null;
}

function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const p = h.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] === 198 && p[1] >= 18 && p[1] <= 19) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] >= 224) return true;
    return false;
  }
  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (/^fe[cde]/.test(h)) return true;
    if (h.startsWith('2001:db8')) return true;
    const s6 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (s6) {
      const num = (parseInt(s6[1], 16) << 16) + parseInt(s6[2], 16);
      if (isPrivateIp(`${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (ALLOW_PRIVATE) return net.isIP(h) ? h : (await dnsLookup(h, { all: true }))[0]?.address ?? h;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址（要关掉这个防护：把环境变量 BROWSER_SEARCH_ALLOW_PRIVATE 设为 1）');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址（同上，可关）');
    return h;
  }
  const addresses = await dnsLookup(h, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止（同上，可关）');
  }
  return addresses[0].address;
}

async function validateUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw new Error('URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

// ───────────────────────── CDP：驱动真实浏览器 ─────────────────────────
async function cdpHttp(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: CDP_PORT, path: pathname, method: 'GET', timeout: 4000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('CDP 返回的不是 JSON')); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.on('error', reject);
    req.end();
  });
}

async function browserAlive() {
  try { await cdpHttp('/json/version'); return true; } catch { return false; }
}

function launchBrowser() {
  if (!fs.existsSync(BROWSER_EXE)) {
    throw new Error(`找不到浏览器：${BROWSER_EXE}（可用 BROWSER_SEARCH_EXE 指定）`);
  }
  fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${BROWSER_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 2026-10-16 加：启动时别抢前台 + 最小化/被遮挡时不要降频。
    // 起因：会话搜索时它把 Edge 拉到前台挡住用户视野，用户顺手最小化；
    // Chromium 随即把渲染降到后台模式，页面可能加载不完整 —— 看起来像"搜不出来"。
    '--start-minimized',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    'about:blank',
  ];
  const child = spawn(BROWSER_EXE, args, { detached: true, stdio: 'ignore' });
  child.unref();
  log(`已启动浏览器 pid=${child.pid} 端口=${CDP_PORT} profile=${BROWSER_PROFILE}`);
}

/** 拿到一个可用的 page target 的 webSocketDebuggerUrl */
async function pickTarget() {
  const list = await cdpHttp('/json/list');
  const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('浏览器里没有可用标签页');
  // 优先挑一个"空白页"，否则用第一个
  const blank = pages.find((p) => !p.url || p.url === 'about:blank');
  return blank || pages[0];
}

let wsSeq = 0;
/** 开一条 CDP 连接，返回 { send, close } */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接 CDP 超时')), 8000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error('连接 CDP 失败：' + (e?.message || 'error'))); }, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++wsSeq;
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const close = () => { try { ws.close(); } catch {} };
  return { send, close };
}

// ⚠️ 串行闸门（2026-10-16 加）
// DSH 里所有会话共用**同一个 MCP 进程**、同一只浏览器、同一个标签页。
// 不排队的话，两个会话会同时 navigate 同一个 tab 再各自 evaluate ——
// 谁后到谁覆盖，先到的那个读到的是别人的页面。
// 实测漂移：请求 Google，拿回来的是别人正在搜的 LoversLab 页；请求 Bing，拿回来 9dm.net。
// 这里把所有浏览器操作串成一条队列，单次调用的 navigate+evaluate 不会被别的会话插进来。
let pageQueue = Promise.resolve();
function withPage(fn) {
  const run = pageQueue.then(() => withPageNow(fn), () => withPageNow(fn));
  pageQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * 把搜索专用窗口最小化（2026-10-16 加）。
 * 起因：会话搜索时它把 Edge 拉到前台挡住用户视野。实测 Edge **不认** `--start-minimized`
 * （启动后 IsIconic=False），所以改用 CDP 的 Browser.setWindowBounds 明确收窗口。
 * 只有"浏览器是本工具自己拉起来的"那一次才收；用户自己还原窗口后不会再被收回去。
 */
async function minimizeBrowserWindow() {
  try {
    const list = await cdpHttp('/json/list');
    const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) return;
    const { send, close } = await connect(page.webSocketDebuggerUrl);
    try {
      const w = await send('Browser.getWindowForTarget', { targetId: page.id }, 8000);
      if (w?.windowId != null) {
        await send('Browser.setWindowBounds', {
          windowId: w.windowId,
          bounds: { windowState: 'minimized' },
        }, 8000);
        log('已把搜索窗口最小化 windowId=' + w.windowId);
      }
    } finally {
      close();
    }
  } catch (e) {
    // 收不起来不影响搜索，只是会挡一下视野
    log('最小化窗口失败（不影响功能）：' + (e?.message || e));
  }
}

async function withPageNow(fn) {
  if (!(await browserAlive())) {
    if (!AUTOSTART) throw new Error(`浏览器没开（CDP 端口 ${CDP_PORT} 无响应），且自动启动被关闭`);
    launchBrowser();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await browserAlive()) break;
      if (i === 29) throw new Error('浏览器启动了但 CDP 端口没起来');
    }
    // Edge 不认 --start-minimized，这里再用 CDP 明确收一次窗口，别挡用户视野
    await minimizeBrowserWindow();
  }
  const target = await pickTarget();
  const { send, close } = await connect(target.webSocketDebuggerUrl);
  try {
    await send('Page.enable').catch(() => {});
    await send('Runtime.enable').catch(() => {});
    return await fn(send);
  } finally {
    close();
  }
}

/** 导航并等页面稳定 */
async function navigate(send, url, waitMs = 2500) {
  await send('Page.navigate', { url }, 45000);
  const deadline = Date.now() + 45000;
  let lastLen = -1, stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    let state = '';
    try {
      const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 8000);
      state = r?.result?.value || '';
    } catch { /* 导航中可能报错，忽略 */ }
    if (state === 'complete') {
      let len = 0;
      try {
        const r = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.length : 0', returnByValue: true }, 8000);
        len = Number(r?.result?.value || 0);
      } catch {}
      if (len === lastLen) { stable++; if (stable >= 2) break; } else { stable = 0; lastLen = len; }
    }
  }
  await new Promise((r) => setTimeout(r, waitMs));
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, 30000);
  if (r?.exceptionDetails) {
    throw new Error('页面执行出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || ''));
  }
  return r?.result?.value;
}

// ───────────────────────── 搜索引擎 ─────────────────────────
const ENGINES = {
  // ── Google（2026-10-27 加）：唯一实测能给真结果的通道 ────────────────
  // 百度会把敏感词的结果换成「百科介绍页」，Bing 中国区给 0 条或无关内容。
  // 注意：Google 直连不通，必须在梯子开着的时候用。
  google: {
    name: 'Google',
    url: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q) + '&num=20&hl=zh-CN',
    extract: `(() => {
      const out = [];
      const seen = new Set();
      const bad = /google\\.(com|com\\.hk|com\\.cn)\\/|\\/search\\?|webcache\\.googleusercontent|\\/accounts\\./i;
      for (const a of document.querySelectorAll('a:has(h3)')) {
        const h = a.querySelector('h3');
        const href = a.href || '';
        if (!h || !/^https?:/i.test(href) || bad.test(href) || seen.has(href)) continue;
        const title = (h.innerText || '').trim();
        if (!title) continue;
        let snippet = '';
        let box = a.parentElement;
        for (let i = 0; i < 4 && box && !snippet; i++) {
          const t = (box.innerText || '').replace(/\\s+/g, ' ').trim();
          if (t.length > title.length + 20) {
            snippet = (t.startsWith(title) ? t.slice(title.length).trim() : t)
              .replace(/^[\\s\\-—·|]+/, '').slice(0, 300);
          }
          box = box.parentElement;
        }
        seen.add(href);
        out.push({ title, url: href, snippet });
        if (out.length >= 12) break;
      }
      return out;
    })()`,
  },
  baidu: {
    name: '百度',
    url: (q) => 'https://www.baidu.com/s?wd=' + encodeURIComponent(q) + '&rn=20',
    extract: `(() => {
      const out = [];
      const nodes = document.querySelectorAll('#content_left > div[class*="result"], #content_left .c-container, #content_left > div');
      for (const n of nodes) {
        const a = n.querySelector('h3 a') || n.querySelector('a[href^="http"]');
        if (!a) continue;
        const title = (a.innerText || '').trim();
        const href = a.href || '';
        // 百度的摘要 class 是动态的，所以直接拿整块文本、减掉标题，剩下的就是摘要
        let all = (n.innerText || '').replace(/\\s+/g, ' ').trim();
        let snippet = all.startsWith(title) ? all.slice(title.length).trim() : all;
        snippet = snippet.replace(/^[\\s\\-—·|]+/, '').slice(0, 300);
        if (title && href && /^https?:/.test(href)) out.push({ title, url: href, snippet });
        if (out.length >= 12) break;
      }
      return out;
    })()`,
  },
  bing: {
    name: 'Bing（国际版）',
    // ⚠️ ensearch=1 = 国际版结果，adlt=off = 关掉成人过滤。
    // 少了这两个参数，cn.bing.com 只会给 0 条或完全无关的东西（实测过）。
    url: (q) => 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&count=20&ensearch=1&adlt=off',
    extract: `(() => {
      const out = [];
      for (const n of document.querySelectorAll('li.b_algo')) {
        const a = n.querySelector('h2 a') || n.querySelector('a[href^="http"]');
        if (!a) continue;
        const title = (a.innerText || '').trim();
        const href = a.href || '';
        const p = n.querySelector('p');
        let snippet = p ? (p.innerText || '').replace(/\\s+/g, ' ').trim() : '';
        if (!snippet) {
          const all = (n.innerText || '').replace(/\\s+/g, ' ').trim();
          snippet = (all.startsWith(title) ? all.slice(title.length).trim() : all).slice(0, 300);
        }
        if (title && href && /^https?:/.test(href)) out.push({ title, url: href, snippet });
        if (out.length >= 12) break;
      }
      return out;
    })()`,
  },
};

// 兜底顺序（2026-10-27）：Google（真结果）→ Bing 国际版 → 百度（最后手段）。
// 用户点名了 engine 就只跑那一个，不自动替换 —— 免得"我要 bing"却给你 google。
const ENGINE_ORDER = ['google', 'bing', 'baidu'];

async function browserSearch(query, engineName) {
  const wanted = String(engineName || DEFAULT_ENGINE || 'google').toLowerCase();
  const tries = (engineName && ENGINES[wanted])
    ? [wanted]
    : ENGINE_ORDER.filter((k) => ENGINES[k]);
  const notes = [];
  for (const key of tries) {
    const engine = ENGINES[key];
    let results = [];
    try {
      results = await withPage(async (send) => {
        await navigate(send, engine.url(query));
        const r = await evaluate(send, engine.extract);
        return Array.isArray(r) ? r : [];
      });
    } catch (e) {
      notes.push(`${engine.name}: ${e?.message ?? e}`);
      continue;
    }
    if (results.length) {
      return {
        query,
        engine: engine.name,
        via: `浏览器（CDP ${CDP_PORT}，带你的登录态）`,
        results,
        ...(notes.length ? { fallbackFrom: notes } : {}),
      };
    }
    notes.push(`${engine.name}: 0 条`);
  }
  return {
    query,
    engine: tries.map((k) => ENGINES[k].name).join(' / ') || '?',
    via: `浏览器（CDP ${CDP_PORT}，带你的登录态）`,
    results: [],
    note: '所有通道都没结果 —— ' + notes.join('；') +
      '。Google 需要开梯子；百度/Bing 会把敏感词换成百科页或直接 0 条，这种时候改 web_open 直接开网址更靠谱。',
  };
}

async function browserFetch(url, maxChars) {
  const { url: u } = await validateUrl(url);
  return withPage(async (send) => {
    await navigate(send, u.toString());
    const payload = await evaluate(send, `(() => ({
      title: document.title || '',
      url: location.href,
      text: document.body ? document.body.innerText : ''
    }))()`);
    // ① 页面根本没打开（空白页 / 浏览器错误页）→ 抛出去，让 HTTP 直连兜底
    const finalUrl = String(payload?.url || '');
    if (!finalUrl || /^(about:blank|chrome-error:)/i.test(finalUrl)) {
      throw new Error('页面没真正打开（停在 ' + (finalUrl || '空白页') + '）');
    }
    // ② 落到了完全不相干的站点 → 标出来。正常跳转（pornhub.com → cn.pornhub.com）不算
    const hostOf = (s) => { try { return new URL(s).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return ''; } };
    const wantHost = hostOf(u.toString());
    const gotHost = hostOf(finalUrl);
    const related = !wantHost || !gotHost || wantHost === gotHost
      || wantHost.endsWith('.' + gotHost) || gotHost.endsWith('.' + wantHost);
    let text = String(payload?.text || '');
    const truncated = text.length > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    return {
      url: finalUrl,
      requestedUrl: u.toString(),
      ...(related ? {} : { hostChanged: `${wantHost} → ${gotHost}` }),
      title: payload?.title || '',
      truncated,
      length: text.length,
      via: `浏览器（CDP ${CDP_PORT}）`,
      body: text,
    };
  });
}

// ───────────────────────── 纯 HTTP 兜底（浏览器不可用时）─────────────────────────
function readBoundedText(res, maxChars) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let settled = false;
    res.on('data', (chunk) => {
      if (settled) return;
      text += decoder.write(chunk);
      if (text.length >= maxChars) {
        text = Array.from(text).slice(0, maxChars).join('');
        try { res.destroy(); } catch {}
        settled = true; resolve(text);
      }
    });
    res.on('end', () => { if (!settled) { settled = true; resolve(Array.from(text + decoder.end()).slice(0, maxChars).join('')); } });
    res.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });
}

function requestOnce(url, ip, maxChars) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: ip,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 25000,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code)) {
        res.resume();
        resolve({ statusCode: code, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, maxChars).then((body) => resolve({ statusCode: code, body })).catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

async function plainFetch(urlString, maxChars) {
  let { url, ip } = await validateUrl(urlString);
  for (let i = 0; i <= 5; i++) {
    const r = await requestOnce(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(r.statusCode)) {
      if (!r.redirect) throw new Error(`重定向缺少 Location: ${r.statusCode}`);
      ({ url, ip } = await validateUrl(new URL(r.redirect, url).toString()));
      continue;
    }
    const body = r.body || '';
    return {
      url: url.toString(),
      statusCode: r.statusCode,
      truncated: body.length >= maxChars,
      length: body.length,
      via: 'HTTP 直连（浏览器不可用时的兜底）',
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

// ───────────────────────── MCP 工具 ─────────────────────────
const server = new McpServer({ name: 'browser-search', version: '1.0.0' });

server.tool(
  'web_search',
  '联网搜索（走用户已登录的真实浏览器，百度/Bing）。返回标题、URL、摘要。用于查资料、找文档、确认事实。',
  {
    query: z.string().describe('搜索关键词'),
    engine: z.string().optional().describe('搜索引擎：baidu（默认）或 bing'),
  },
  async ({ query, engine }) => {
    const clean = sanitizeQuery(query);
    if (!clean) return { content: [{ type: 'text', text: '查询词为空。' }], isError: true };
    try {
      // ⚠️ 这里必须原样把 engine 传下去（可能是 undefined）。
      // 之前写成 (engine || DEFAULT_ENGINE) 会让 browserSearch 以为"用户点名了引擎"，
      // 于是 Google 挂了也不往 Bing/百度 兜底 —— 直接 0 条。
      const result = await browserSearch(clean, engine);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'web_open',
  '用浏览器打开一个网址，返回页面标题和正文纯文本。走用户已登录的浏览器，所以能看到登录后才有内容。',
  {
    url: z.string().describe('要打开的 http(s) 网址'),
    maxChars: z.number().optional().describe('正文最大字符数，默认 200000'),
  },
  async ({ url, maxChars }) => {
    const cap = Math.max(1000, Math.min(Number(maxChars) || MAX_TEXT, 2000000));
    try {
      const result = await browserFetch(url, cap);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      // 浏览器不行就退回 HTTP 直连
      try {
        const fallback = await plainFetch(url, cap);
        return { content: [{ type: 'text', text: JSON.stringify({ ...fallback, browserError: String(error?.message ?? error) }, null, 2) }] };
      } catch (e2) {
        return { content: [{ type: 'text', text: `打开失败：${e2?.message ?? e2}（浏览器通道也失败：${error?.message ?? error}）` }], isError: true };
      }
    }
  }
);

server.tool(
  'web_read',
  '读取当前浏览器标签页的正文（不导航）。适合点完链接或翻页之后取内容。',
  { maxChars: z.number().optional().describe('正文最大字符数，默认 200000') },
  async ({ maxChars }) => {
    const cap = Math.max(1000, Math.min(Number(maxChars) || MAX_TEXT, 2000000));
    try {
      const r = await withPage(async (send) => evaluate(send, `(() => ({
        title: document.title || '', url: location.href,
        text: document.body ? document.body.innerText : ''
      }))()`));
      let text = String(r?.text || '');
      const truncated = text.length > cap;
      if (truncated) text = text.slice(0, cap);
      return { content: [{ type: 'text', text: JSON.stringify({ url: r?.url, title: r?.title, truncated, length: text.length, body: text }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'web_click',
  '在当前页面点击一个元素（CSS 选择器），点完等页面稳定并返回新页面信息。',
  {
    selector: z.string().describe('CSS 选择器，例如 "a.next" 或 "#submit"'),
    waitMs: z.number().optional().describe('点击后额外等待毫秒，默认 2000'),
  },
  async ({ selector, waitMs }) => {
    try {
      const r = await withPage(async (send) => {
        const hit = await evaluate(send, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, reason: '找不到元素' };
          el.scrollIntoView({ block: 'center' });
          // 很多搜索结果带 target="_blank"，会开新标签页导致"看起来没跳转" —— 去掉它，在本页打开
          let droppedTarget = false;
          if (el.tagName === 'A' && el.getAttribute('target')) {
            el.removeAttribute('target');
            droppedTarget = true;
          }
          el.click();
          return { ok: true, tag: el.tagName, text: (el.innerText || '').slice(0, 80), droppedTarget };
        })()`);
        if (!hit?.ok) return { clicked: false };
        await new Promise((res) => setTimeout(res, Math.max(0, Number(waitMs) || 2000)));
        const after = await evaluate(send, `(() => ({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, 2000) }))()`);
        return { clicked: true, element: hit, title: after?.title, url: after?.url, preview: after?.text };
      });
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `点击失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'web_type',
  '在当前页面的输入框里填内容（CSS 选择器），可选是否提交（优先真正提交所在表单，没有表单才发真回车键）。',
  {
    selector: z.string().describe('输入框的 CSS 选择器'),
    text: z.string().describe('要填的内容'),
    submit: z.boolean().optional().describe('填完是否提交，默认 false'),
  },
  async ({ selector, text, submit }) => {
    try {
      const r = await withPage(async (send) => {
        const hit = await evaluate(send, `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, reason: '找不到元素' };
          el.focus();
          // 兼容 React 等受控组件：走原生 setter 再派发事件
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, tag: el.tagName, hasForm: !!(el.form || el.closest('form')) };
        })()`);
        if (!hit?.ok || !submit) return hit;

        // JS 造的 KeyboardEvent 不受信任，浏览器不会当默认动作 —— 所以优先真正提交表单
        if (hit.hasForm) {
          hit.submitMethod = await evaluate(send, `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            const form = el.form || el.closest('form');
            if (!form) return 'none';
            const btn = form.querySelector('input[type=submit], button[type=submit], button:not([type]), input[type=image]');
            if (btn) { btn.click(); return 'button'; }
            if (typeof form.requestSubmit === 'function') { form.requestSubmit(); return 'requestSubmit'; }
            form.submit(); return 'form.submit';
          })()`);
        } else {
          await send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          }, 8000).catch(() => {});
          await send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: 'Enter', code: 'Enter',
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          }, 8000).catch(() => {});
          hit.submitMethod = 'keyEvent';
        }

        await new Promise((res) => setTimeout(res, 3000));
        const after = await evaluate(send, `(() => ({ title: document.title, url: location.href }))()`);
        hit.afterTitle = after?.title;
        hit.afterUrl = after?.url;
        return hit;
      });
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `填写失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'browser_status',
  '检查浏览器通道是否可用：CDP 端口、浏览器是否在跑、进程内配置。',
  {},
  async () => {
    const alive = await browserAlive();
    let tabs = [];
    if (alive) {
      try {
        const list = await cdpHttp('/json/list');
        tabs = (Array.isArray(list) ? list : [])
          .filter((t) => t.type === 'page')
          .map((t) => ({ title: (t.title || '').slice(0, 80), url: (t.url || '').slice(0, 120) }));
      } catch {}
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          browserAlive: alive,
          cdpPort: CDP_PORT,
          defaultEngine: DEFAULT_ENGINE,
          allowPrivate: ALLOW_PRIVATE,
          autostart: AUTOSTART,
          browserExe: BROWSER_EXE,
          browserProfile: BROWSER_PROFILE,
          profileDirExists: fs.existsSync(BROWSER_PROFILE),
          tabs,
        }, null, 2),
      }],
    };
  }
);

await server.connect(new StdioServerTransport());
