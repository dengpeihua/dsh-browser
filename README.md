<h1 align="center">dsh-browser-plugin</h1>

<p align="center">Native Chromium browser Agent tools for DeepSeek Harness</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-blue" alt="Node.js >= 22.19">
  <img src="https://img.shields.io/badge/browser-Chrome%20%7C%20Chromium-blue" alt="Chrome or Chromium">
  <img src="https://img.shields.io/badge/tools-15-success" alt="15 browser tools">
</p>

<p align="center"><strong><a href="#中文">中文</a> | <a href="#english">English</a></strong></p>

---

<a id="中文"></a>

# 🇨🇳 dsh-browser-plugin（中文）

> 给 DeepSeek Harness 装上真实浏览器：让 Agent 能够打开网页、理解页面、填写表单、管理标签页并完成多步骤任务。

`dsh-browser-plugin` 是一个可独立安装的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web profile 插件。它直接启动本机 Chrome 或 Chromium，通过 Puppeteer、Chrome DevTools Protocol（CDP）和增量 DOM 快照向 Agent 提供 15 个 `browser_*` 工具。

本仓库只包含浏览器插件自身的源码，不包含 DeepSeek Harness 源码，也不要求用户克隆 Harness 仓库。

## 它能做什么

| 任务 | 没装插件 | 装上插件 |
|---|---|---|
| 访问动态网站 | 只能依赖搜索或静态抓取 | 启动真实 Chromium 并操作页面 |
| 填写复杂表单 | 无法处理弹窗、下拉框和动态字段 | 通过 DOM 引用定位、输入和点击 |
| 多步资料调研 | 每一步都要人工复制页面内容 | Agent 可在多个标签页之间持续探索 |
| 理解页面变化 | 反复读取整页，浪费上下文 | 优先返回 DOM 差异，必要时建立完整或新增内容基线 |
| 查看图表和图片 | 只有文本信息 | 截取指定视觉元素并保存为 DSH attachment |

## 核心特性

- **真实 Chromium** — 使用本机 Chrome/Chromium，而不是 HTTP 抓取器或模拟页面。
- **增量 DOM** — 首次返回完整快照，后续优先返回 `+|` / `-|` 差异，减少重复上下文。
- **稳定元素引用** — 可点击元素使用 `[N]`，可输入元素使用 `<N>`，视觉元素使用 `[view:ID]`。
- **Session 隔离** — 每个 DSH Agent 独立拥有浏览器进程、标签页、CDP 会话和 DOM 缓存。
- **多标签页与滚动探索** — 支持创建、切换、关闭标签页，以及按屏或按页面位置探索长页面。
- **DSH 原生生命周期** — 使用 Cordis、`defineTool`、approval、取消信号和 attachment 服务，不依赖兼容服务器。
- **显式浏览器路由** — 用户明确要求使用浏览器或 Chromium 时，模型从 `browser_start` 开始并持续使用 `browser_*`，不会用 `web_search` 或 `web_fetch` 替代。
- **安全默认值** — Chromium sandbox 默认开启；改变页面状态的操作默认需要 DSH approval。
- **有界输出** — 页面脚本结果过大时只向模型返回预览，并把完整结果写入指定目录或临时目录。

## 快速开始

### 环境要求

- Node.js `>=22.19`
- Chrome 或 Chromium
- `pnpm`（DSH 的插件安装命令会调用它）

```powershell
node --version
pnpm --version
```

如果尚未安装 `pnpm`：

```powershell
npm install --global pnpm
```

### 安装当前本地版本

该包目前尚未发布到 npm，以下步骤假定你已经通过当前私下交付渠道取得源码。先生成标准 npm tarball，再安装到 DSH 的 `web` profile：

```powershell
Set-Location path\to\dsh-browser
npm install
$package = npm pack --silent

npx @deepseek-ai/dsh plugin --profile web add ".\$package"
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

`--dump-config` 中应出现 `id: dsh-browser` 和 `name: dsh-browser-plugin`。

### 发布到 npm 后

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-browser-plugin
npx @deepseek-ai/dsh web
```

首次使用 `npx` 时可能会下载 npm 发布的 DSH CLI 及其依赖；插件安装会下载本插件及其依赖。两条路径都不会下载 DeepSeek Harness 源码 checkout。

## 快速配置（可选）

默认配置可以直接使用。在本地打包前，可以修改本仓库的 [`cordis.patch.yml`](cordis.patch.yml)。安装完成后，把下面的条目合并进 `$DSH_HOME/profiles/web/cordis.patch.yml`（`DSH_HOME` 默认是 `~/.dsh`）已有的 YAML 列表；不要覆盖文件中的其他 profile 条目。该层会覆盖 bundle 默认值。

DSH 的 profile patch 会替换目标条目的整个 `config`，因此覆盖时要重述需要保留的字段：

```yaml
- id: dsh-browser
  config:
    headless: true
    noSandbox: false
    approvalMode: mutating
    viewportWidth: 1280
    viewportHeight: 900
    toolTimeoutMs: 120000
    maxWaitSeconds: 300
    scriptMaxLines: 100
    scriptMaxBytes: 8192
```

修改后重启 DSH，并用 `npx @deepseek-ai/dsh --profile web --dump-config` 检查最终配置。

| 需求 | 配置项 | 默认值 | 常用改法 |
|---|---|---:|---|
| 后台无界面运行 | `headless` | `false` | 改为 `true` |
| 指定浏览器程序 | `chromePath` | 自动探测 | 填入 Chrome/Chromium 绝对路径 |
| 调整操作审批 | `approvalMode` | `mutating` | `off`、`mutating` 或 `always` |
| 调整浏览器窗口 | `viewportWidth` / `viewportHeight` | `1280` / `900` | 改为所需正整数 |
| 限制单次工具时长 | `toolTimeoutMs` | `120000` | 填写正整数毫秒数 |
| 限制等待时长 | `maxWaitSeconds` | `300` | 填写正整数秒数 |
| 限制脚本可见输出 | `scriptMaxLines` / `scriptMaxBytes` | `100` / `8192` | 改为所需正整数 |
| 保存完整脚本结果 | `outputDir` | 系统临时目录 | 填入目标目录绝对路径 |

只有受控容器确有兼容性需要时才应设置 `noSandbox: true`。

## 使用示例

安装后，直接在 DSH 中使用自然语言描述任务：

### 信息提取

> 打开 Hugging Face 热门模型页面，整理排名前三的模型名称、机构、参数规模和下载量，并给出来源页面。

### 表单填写

> 打开联系表单，填写我提供的字段，检查必填项和格式校验，但不要最终提交。

### 多步骤调研

> 调查一篇论文的官方代码仓库、依赖、最近维护状态和常见复现问题，最后判断复现难度。

涉及登录、购买、发布、删除或最终提交等高风险动作时，应明确限制任务边界并保留 approval。

## 增量 DOM 如何工作

普通浏览器 Agent 经常在每次操作后把整个页面重新发送给模型。这个插件会保留同一标签页的 DOM 快照链：

```text
首次观察       → mode:full         完整 DOM
少量页面变化   → mode:incremental  新增 +| 与移除 -|
大量页面变化   → mode:added        以新增内容为主的新基线
没有变化       → mode:nochange     简短状态提示
```

处理链路如下：

```text
CDP Snapshot
  → DOM Tree
  → 可见性与可交互性检测
  → 剪枝、内联合并和视觉元素标记
  → 结构化文本渲染
  → 与上一快照计算差异
  → 返回给 Agent
```

`browser_restore_state` 只会重新访问快照记录的 URL，不会恢复表单内容、滚动位置、弹窗、选择项或 SPA 内存。

## 工具清单

| 工具 | 作用 |
|---|---|
| `browser_start` | 启动浏览器并打开 URL |
| `browser_goto` | 导航当前标签页 |
| `browser_refresh` | 刷新当前页面 |
| `browser_restore_state` | 根据 `stateId` 重新访问历史 URL |
| `browser_new_tab` | 新建标签页 |
| `browser_switch_tab` | 切换活动标签页 |
| `browser_close_tab` | 关闭一个或多个标签页 |
| `browser_click` | 点击 `[N]` 元素 |
| `browser_input` | 向 `<N>` 元素输入内容 |
| `browser_reveal_offscreen` | 展示已知的离屏元素 |
| `browser_scroll_next_screen` | 滚动到下一段未探索内容 |
| `browser_scroll_to_page` | 跳到指定页面位置 |
| `browser_execute_script` | 在页面上下文执行 JavaScript |
| `browser_view_elements` | 截取 `[view:ID]` 视觉元素 |
| `browser_wait` | 可取消地等待指定秒数 |

## 架构

```text
DSH Agent Session
  → Cordis 加载 dsh-browser-plugin
  → @deepseek-ai/dsh-tools defineTool
  → DSH approval / cancellation / timeout
  → browser operation
  → Session-scoped BrowserManager
  → Puppeteer + Chromium + CDP + DOM Service
  → canonical tool output / DSH attachments
```

项目结构：

```text
dsh-browser/
├─ src/
│  ├─ index.ts              # Cordis 插件入口与生命周期
│  ├─ plugin-tools.ts       # 15 个 DSH 工具注册器
│  ├─ tool-schemas.ts       # 参数与输出 schema
│  ├─ config.ts             # 配置 schema 与校验
│  └─ browser/
│     ├─ manager.ts         # 浏览器与标签页生命周期
│     ├─ operations/        # 导航、交互、观察、滚动等操作
│     ├─ cdp/               # CDP 封装
│     └─ dom/               # DOM 构建、渲染、差异与视觉映射
├─ test/                    # node:test 测试
├─ scripts/                 # 真实浏览器和安装验证脚本
├─ cordis.patch.yml         # DSH bundle patch
└─ package.json             # npm 与 DSH bundle 清单
```

`src/` 是源码事实来源，`lib/` 是 `npm run build` 生成的发布产物，不要直接编辑 `lib/`。

## 开发与验证

```powershell
npm install
npm test
npm run test:smoke
npm run verify:package
npm run verify:installed
```

| 命令 | 验证内容 |
|---|---|
| `npm test` | 构建、包结构、工具注册、错误契约、approval 和配置测试 |
| `npm run test:smoke` | 真实启动 Chromium，验证 DOM、脚本、截图、attachment 和清理 |
| `npm run verify:package` | 确认 npm 包是独立 DSH bundle 且不包含 Harness checkout |
| `npm run verify:installed` | 在临时 npm 消费者项目中安装 tarball 并导入插件 |

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目使用 [MIT License](LICENSE)。

---

<a id="english"></a>

# 🇬🇧 dsh-browser-plugin (English)

> Give DeepSeek Harness a real browser so an Agent can open pages, understand interfaces, fill forms, manage tabs, and complete multi-step tasks.

`dsh-browser-plugin` is a standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin for the Web profile. It launches a local Chrome or Chromium instance and exposes 15 `browser_*` tools through Puppeteer, the Chrome DevTools Protocol (CDP), and incremental DOM snapshots.

This repository contains only the browser plugin's own source. It neither contains DeepSeek Harness source nor requires users to clone the Harness repository.

## What it enables

| Task | Without the plugin | With the plugin |
|---|---|---|
| Visit dynamic sites | Limited to search or static fetch | Operate a real Chromium page |
| Fill complex forms | Cannot reliably handle dynamic controls | Locate, fill, and click DOM references |
| Conduct multi-step research | Manually copy content at every step | Continue exploration across tabs |
| Understand page changes | Re-read the full page repeatedly | Prefer DOM diffs and establish a full or added-content baseline when needed |
| Inspect charts and images | Text-only information | Capture visual elements as DSH attachments |

## Core features

- **Real Chromium** — Controls local Chrome/Chromium instead of simulating a page or performing an HTTP-only fetch.
- **Incremental DOM** — Returns a full initial snapshot, then prefers `+|` / `-|` diffs to reduce repeated context.
- **Stable element references** — Clickable elements use `[N]`, inputs use `<N>`, and visual elements use `[view:ID]`.
- **Session isolation** — Each DSH Agent owns an independent browser process, tab set, CDP session, and DOM cache.
- **Tabs and long-page exploration** — Create, switch, and close tabs; explore content screen by screen or jump to a page position.
- **Native DSH lifecycle** — Uses Cordis, `defineTool`, approval, cancellation signals, and attachments without a compatibility server.
- **Explicit browser routing** — When the user explicitly requests a browser or Chromium, the model starts with `browser_start` and stays on `browser_*` instead of substituting `web_search` or `web_fetch`.
- **Secure defaults** — Chromium sandboxing is enabled, and state-changing operations request DSH approval by default.
- **Bounded output** — Oversized script results return a preview while the full value is written to a configured or temporary directory.

## Quick start

### Requirements

- Node.js `>=22.19`
- Chrome or Chromium
- `pnpm` (used by the DSH plugin installation command)

```powershell
node --version
pnpm --version
```

Install `pnpm` if it is missing:

```powershell
npm install --global pnpm
```

### Install the current local build

The package has not been published to npm yet, so these steps assume you already obtained the source through the current private distribution channel. Build a standard npm tarball and add it to the DSH `web` profile:

```powershell
Set-Location path\to\dsh-browser
npm install
$package = npm pack --silent

npx @deepseek-ai/dsh plugin --profile web add ".\$package"
npx @deepseek-ai/dsh --profile web --dump-config
npx @deepseek-ai/dsh web
```

The dumped config should contain `id: dsh-browser` and `name: dsh-browser-plugin`.

### After npm publication

```powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-browser-plugin
npx @deepseek-ai/dsh web
```

On first use, `npx` may download the published DSH CLI and its dependencies; plugin installation downloads this plugin and its dependencies. Neither path downloads a DeepSeek Harness source checkout.

## Quick configuration (optional)

The defaults work out of the box. Before packing locally, you can edit this repository's [`cordis.patch.yml`](cordis.patch.yml). After installation, merge the entry below into the existing YAML list in `$DSH_HOME/profiles/web/cordis.patch.yml` (`DSH_HOME` defaults to `~/.dsh`); do not overwrite unrelated profile entries. This user layer overrides the bundle defaults.

A DSH profile patch replaces the matched entry's entire `config`, so restate every field that must be retained:

```yaml
- id: dsh-browser
  config:
    headless: true
    noSandbox: false
    approvalMode: mutating
    viewportWidth: 1280
    viewportHeight: 900
    toolTimeoutMs: 120000
    maxWaitSeconds: 300
    scriptMaxLines: 100
    scriptMaxBytes: 8192
```

Restart DSH after editing, then inspect the effective config with `npx @deepseek-ai/dsh --profile web --dump-config`.

| Need | Setting | Default | Common change |
|---|---|---:|---|
| Run without a visible window | `headless` | `false` | Set to `true` |
| Select a browser executable | `chromePath` | Auto-detect | Set an absolute Chrome/Chromium path |
| Change approval behavior | `approvalMode` | `mutating` | `off`, `mutating`, or `always` |
| Resize the viewport | `viewportWidth` / `viewportHeight` | `1280` / `900` | Set positive integers |
| Limit one tool call | `toolTimeoutMs` | `120000` | Set positive milliseconds |
| Limit explicit waits | `maxWaitSeconds` | `300` | Set positive seconds |
| Bound visible script output | `scriptMaxLines` / `scriptMaxBytes` | `100` / `8192` | Set positive integers |
| Store complete script results | `outputDir` | System temp directory | Set an absolute directory path |

Set `noSandbox: true` only when a controlled container has a demonstrated compatibility requirement.

## Usage examples

After installation, describe the task in natural language:

### Information extraction

> Open the Hugging Face trending models page, collect the top three model names, organizations, parameter counts, and download counts, and include the source page.

### Form filling

> Open the contact form, fill the fields I provide, and check required-field and format validation, but do not submit it.

### Multi-step research

> Investigate a paper's official code repository, dependencies, maintenance status, and common reproduction issues, then rate its reproduction difficulty.

For login, purchase, publish, delete, or final-submit operations, keep approval enabled and state the task boundary explicitly.

## How incremental DOM works

Many browser Agents resend the entire page after every action. This plugin retains a DOM snapshot chain for each tab:

```text
First observation   → mode:full         complete DOM
Small page change   → mode:incremental  added +| and removed -|
Large page change   → mode:added        added-content-oriented new baseline
No page change      → mode:nochange     short status message
```

Processing pipeline:

```text
CDP Snapshot
  → DOM Tree
  → visibility and interactivity detection
  → pruning, inline merging, and visual-element mapping
  → structured-text rendering
  → diff against the previous snapshot
  → Agent output
```

`browser_restore_state` only revisits the URL recorded by a snapshot. It does not restore form values, scroll position, dialogs, selections, or SPA memory.

## Tool reference

| Tool | Purpose |
|---|---|
| `browser_start` | Launch the browser and open a URL |
| `browser_goto` | Navigate the active tab |
| `browser_refresh` | Reload the active page |
| `browser_restore_state` | Revisit a historical URL by `stateId` |
| `browser_new_tab` | Create a tab |
| `browser_switch_tab` | Change the active tab |
| `browser_close_tab` | Close one or more tabs |
| `browser_click` | Click a `[N]` element |
| `browser_input` | Enter content into a `<N>` element |
| `browser_reveal_offscreen` | Reveal a known off-screen element |
| `browser_scroll_next_screen` | Move to the next unexplored screen |
| `browser_scroll_to_page` | Jump to a page position |
| `browser_execute_script` | Run JavaScript in the page context |
| `browser_view_elements` | Capture `[view:ID]` visual elements |
| `browser_wait` | Wait for a bounded number of seconds with cancellation support |

## Architecture

```text
DSH Agent Session
  → Cordis loads dsh-browser-plugin
  → @deepseek-ai/dsh-tools defineTool
  → DSH approval / cancellation / timeout
  → browser operation
  → Session-scoped BrowserManager
  → Puppeteer + Chromium + CDP + DOM Service
  → canonical tool output / DSH attachments
```

Repository layout:

```text
dsh-browser/
├─ src/
│  ├─ index.ts              # Cordis entry and lifecycle
│  ├─ plugin-tools.ts       # 15 DSH tool registrations
│  ├─ tool-schemas.ts       # parameter and output schemas
│  ├─ config.ts             # config schema and validation
│  └─ browser/
│     ├─ manager.ts         # browser and tab lifecycle
│     ├─ operations/        # navigation, interaction, observation, and scrolling
│     ├─ cdp/               # CDP wrappers
│     └─ dom/               # DOM building, rendering, diffing, and visual mapping
├─ test/                    # node:test suite
├─ scripts/                 # real-browser and installation verification
├─ cordis.patch.yml         # DSH bundle patch
└─ package.json             # npm and DSH bundle manifest
```

`src/` is the source of truth. `lib/` is generated by `npm run build`; do not edit `lib/` directly.

## Development and verification

```powershell
npm install
npm test
npm run test:smoke
npm run verify:package
npm run verify:installed
```

| Command | Evidence produced |
|---|---|
| `npm test` | Build, package shape, tool registration, error contract, approval, and config tests |
| `npm run test:smoke` | Real Chromium DOM, script, screenshot, attachment, and cleanup checks |
| `npm run verify:package` | Confirms the npm package is a standalone DSH bundle with no Harness checkout |
| `npm run verify:installed` | Installs the tarball in a temporary consumer project and imports the plugin |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for security boundaries and vulnerability reporting.

## License

This project is released under the [MIT License](LICENSE).
