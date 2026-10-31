# mcp-browser-search

一个**真浏览器驱动**的 MCP 搜索 / 抓取服务器。

它不用 HTTP 去爬搜索引擎，而是通过 **CDP（Chrome DevTools Protocol）** 操作一个真正的
Chromium 浏览器 —— 带那个 profile 的 cookie、登录态和真实指纹。

因为"它就是一个真人开着的浏览器"，所以：

- 不会被平台当成匿名爬虫
- 能读到**登录之后才存在**的内容
- 搜索结果比纯 HTTP 方案准得多
- 能真的点按钮、填表单、翻页

支持**任何 MCP 客户端**：Claude Desktop、Cursor、DSH、自己写的 agent —— 传输方式是 stdio。

---

## 三分钟装好

**前置条件**：Node.js ≥ 18；机器上装有 Chrome / Edge / Chromium 之一。

```bash
# 1. 下载
git clone https://github.com/HeiBai-king/mcp-browser-search.git
cd mcp-browser-search

# 2. 装依赖（只有两个）
npm install

# 3. 自检 —— 这一步能过，基本就成了
node selfcheck.js
```

自检通过会长这样：

```
mcp-browser-search 自检

  [OK]   Node 24.21.0
  [OK]   浏览器: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
  [OK]   专用 profile: C:\Users\you\.mcp-browser-profile（还没建，首次运行会自动创建）
  [OK]   依赖齐全（@modelcontextprotocol/sdk / zod）
  [WARN] CDP 9222 还没起来 —— 这很正常，第一次调用工具时会自动拉起浏览器。
```

看到 `CDP 还没起来` 不用管 —— 那是**正常状态**，第一次调用工具时它自己会启动浏览器。

然后跳到下面「客户端配置」，把那一小段贴进你客户端的配置文件就行。

**配好之后怎么确认真的能用**：在客户端里让它调用一次 `browser_status`。
能看到端口、浏览器进程和标签页列表（哪怕列表是空的），就说明通了。

---

## 客户端配置

### DSH

在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: mcp-browser-search
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: browser-search
        transport: stdio
        command: 'node'
        args:
          - '/absolute/path/to/mcp-browser-search.js'
        toolCallTimeoutMs: 300000
```

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "browser-search": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-browser-search.js"]
    }
  }
}
```

Windows 上路径要写成 `C:\\Users\\you\\mcp-browser-search\\mcp-browser-search.js`（双反斜杠）
或者 `C:/Users/you/...`。

### 其他客户端

凡是支持 stdio 传输的 MCP 客户端，配置都是同一件事：

> **命令 = `node`，参数 = `mcp-browser-search.js` 的绝对路径。**

---

## 第一次用要做什么

**如果要抓的是需要登录的站点，先去那个专用窗口里登一次。**

这个项目用一个**独立的浏览器 profile**（默认 `~/.mcp-browser-profile`），跟你的日常浏览器
互不干扰。第一次调用工具时，它会自动弹出这个 profile 的浏览器窗口，然后**把窗口最小化**
（不打断你）。

想登录：随便调一次工具 → 去任务栏把那个窗口还原 → 登录。之后登录态就一直在了。

想**换账号或者清掉登录态**：先关掉那个浏览器窗口，再删掉 profile 目录
（默认 `~/.mcp-browser-profile`，也可以看环境变量 `BROWSER_SEARCH_PROFILE` 指到哪）。
下次调用会重新建一个干净的。

> ⚠️ 它用的是**你自己的登录态**。通过它访问的网站，活动都记在你这个账号名下。
> 别拿它去跑平台明确禁止自动化的操作。

---

## 工具

| 工具 | 作用 |
|---|---|
| `web_search` | 联网搜索，返回标题 / URL / 摘要 |
| `web_open` | 打开网址，返回正文纯文本 |
| `web_read` | 读**当前标签页**（不导航），适合点完链接后取内容 |
| `web_click` | 按 CSS 选择器点击元素 |
| `web_type` | 往输入框填内容，可选提交（优先真的提交表单） |
| `browser_status` | 查 CDP 端口、浏览器是否在跑、当前有哪些标签页 |

## 搜索引擎

- **`google`** —— 默认。实测最不容易被替换结果。⚠️ 需要能访问 Google。
- **`bing`** —— 走国际版（`&ensearch=1`）并关闭成人过滤（`&adlt=off`）。少了这两个参数，
  `cn.bing.com` 只会返回 0 条或完全无关的内容。
- **`baidu`** —— 兜底。

不指定引擎时按 **google → bing → baidu** 依次尝试，并用 `fallbackFrom` 说明前面哪些失败了。
**不会默默给你一个错的结果。**

---

## 环境变量

全部可选。

| 变量 | 默认 | 说明 |
|---|---|---|
| `BROWSER_CDP_PORT` | `9222` | CDP 调试端口 |
| `BROWSER_SEARCH_ENGINE` | `google` | `google` / `bing` / `baidu` |
| `BROWSER_SEARCH_PROFILE` | `~/.mcp-browser-profile` | 专用 profile，登录态存这里 |
| `BROWSER_SEARCH_EXE` | 自动探测 | 浏览器可执行文件路径 |
| `BROWSER_SEARCH_AUTOSTART` | 开 | 设 `0` 则不自动拉起浏览器 |
| `BROWSER_SEARCH_ALLOW_PRIVATE` | 关 | 设 `1` 才允许访问内网 / 本机地址 |

---

## 常见问题

**`[FAIL] 没找到 Chrome / Edge / Chromium`**
装一个浏览器，或者用 `BROWSER_SEARCH_EXE` 显式指定路径：

```json
{
  "command": "node",
  "args": [".../mcp-browser-search.js"],
  "env": { "BROWSER_SEARCH_EXE": "/path/to/chrome" }
}
```

**`[FAIL] 依赖没装好`**
在项目目录跑 `npm install`。国内网络慢就加镜像：
`npm install --registry=https://registry.npmmirror.com`

**CDP 端口被占用**
默认 9222，改 `BROWSER_CDP_PORT` 换个端口就行。

**搜索返回 0 条**
通常是引擎那边的问题，不是工具坏了。结果里会写清楚试过哪些引擎；
Google 连不上时会自动落到 Bing / 百度。

**想让它读登录后的内容**
先在那个专用窗口里登录一次（见上面「第一次用要做什么」）。

**页面打不开，报"页面没真正打开"**
这是有意的：`web_open` 会检查实际落地的 URL，不会把错误页当成成功返回。

---

## 实现细节

**自动拉起浏览器**
CDP 端口没人监听时，自己用 `--remote-debugging-port` 启动一个专用 profile 的浏览器，
启动后通过 CDP 把窗口最小化，避免突然弹到前台打断使用者。

**串行闸门**
所有浏览器操作排成一队。多个 agent / 会话共用一个服务器时，并发导航同一个标签页会导致
「请求 A 却读回 B 的页面」—— 排队是根治办法。

**不节流**
启动参数带 `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding` /
`--disable-background-timer-throttling`，窗口最小化时页面也能完整加载。

**返回校验**
`web_open` 会比对实际落地的 URL：页面没真正打开（错误页 / 空白页）会明确报错，
而不是把别的页面当成成功返回。跳到不同域名时会在结果里标 `hostChanged`。

**内网防护**
默认拒绝 localhost 与私有网段（含 IPv6 内嵌形式），用于防 SSRF。需要访问内网时用
`BROWSER_SEARCH_ALLOW_PRIVATE=1` 显式打开。

---

## 已知限制

- 依赖你在那个 profile 里**已经登录**过。需要登录的站点，第一次要手动登一次。
- Google 需要能访问 Google；访问不了时会自动落到 Bing / 百度。
- 搜索引擎的 DOM 结构会变 —— 提取器失效时需要跟着改。这是这类方案的固有成本。
- 只支持 Chromium 系浏览器（Chrome / Edge / Chromium），不支持 Firefox / Safari。
- 并发是串行的，不会并行加速。
- **只在 Windows 上实跑验证过**。macOS / Linux 的浏览器路径探测是按各系统常见安装位置写的，
  逻辑上成立但**没有实测**；那边出问题大概率就在找浏览器这一步，用 `BROWSER_SEARCH_EXE`
  直接指定路径即可绕过。

## 卸载

删掉这个目录，再删掉 profile 目录（默认 `~/.mcp-browser-profile`）就干净了。
它不写注册表、不装全局包、不开机自启。

## 项目结构

```
mcp-browser-search.js   MCP 服务器本体（stdio）
selfcheck.js            自检脚本（node selfcheck.js）
package.json
README.md
LICENSE
```

## License

MIT
