<h1 align="center">dsh-browser-plugin</h1>

<p align="center">Native Chromium browser Agent tools for DeepSeek Harness</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.19-blue" alt="Node.js >= 22.19">
  <img src="https://img.shields.io/badge/browser-Chrome%20%7C%20Chromium-blue" alt="Chrome or Chromium">
  <img src="https://img.shields.io/badge/tools-17-success" alt="17 browser and memory tools">
</p>

<p align="center"><strong><a href="#中文">中文</a> | <a href="#english">English</a></strong></p>

---

<a id="中文"></a>

# 🇨🇳 dsh-browser-plugin（中文）

> 给 DeepSeek Harness 装上真实浏览器：让 Agent 能够打开网页、理解页面、填写表单、管理标签页并完成多步骤任务。

`dsh-browser-plugin` 是一个可独立安装的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web profile 插件。它直接启动本机 Chrome 或 Chromium，通过 Puppeteer、Chrome DevTools Protocol（CDP）和增量 DOM 快照向 Agent 提供 15 个浏览器操作，并配有 2 个任务记忆工具。

本仓库只包含浏览器插件自身的源码，不包含 DeepSeek Harness 源码，也不要求用户克隆 Harness 仓库。

本版本通过 DSH 的原生扩展点，把浏览器运行时与上下文策略接入 Agent Harness。这里的 Host 是 DSH 的 Agent/Session 运行时；插件仍可独立打包安装，不需要复制或修改 DSH 源码。

## 跨页面任务记忆：先保存事实，再清理 DOM

新增 `browser_record_facts` 和 `browser_recall` 两个原生工具。现在共有 **15 个浏览器操作 + 2 个任务记忆工具**。任务信息属于当前 DSH Session，由宿主日志持久化；不会写入 Codex 的用户记忆目录，也不共享给其他会话。

| 场景 | 之前的上下文改造 | 本次修正后 |
|---|---|---|
| 在 A 页看到 A 100 元，再打开 B 页 | A 的 DOM 可能被淘汰，依赖模型自行记笔记 | 未记录的 A 观察暂时保留；若继续浏览，会要求先保存事实或明确说明该页无关 |
| 保存 A、B 后清理旧页面 | 没有专用事实存储 | 事实独立保留为实体、字段、值、原文证据、来源 URL、观察时间；DOM 可以淘汰 |
| 回到 A，价格变为 90 元 | 没有专用更新与历史查询规则 | 同来源、同实体、同字段以较新的观察为当前值；`includeHistory: true` 可查 100→90，B 仍是 200 |
| 宿主总结历史或重启浏览器 | 独立文字记录是否保留取决于一般压缩策略 | 从宿主原生 `user/message` 事实记录恢复摘要；`browser_recall` 也能读取历史观察，无需重新打开页面 |
| 事实较多 | 可能持续堆积在上下文 | 每轮最多注入 20 条近期当前事实并限制摘要长度，其余可搜索和分页；不静默删除 |

实际流程是：**观察页面 → Agent 调用 `browser_record_facts` 提取相关信息 → Host 校验证据并保存 → 旧 DOM 淘汰 → 后续步骤通过记忆摘要或 `browser_recall` 使用事实。** 若模型忘记记录，代码会保留尚未处理的活跃运行时观察，并在下一次继续浏览前拦截。被宿主通用压缩移出上下文的观察仍可从原始日志读取。已经属于当前增量基线链的观察不会仅因出现下一次增量就触发拦截。

记录示例（`observationId` 必须使用实际工具返回的 ID，`evidence` 必须复制实际观察中的原文）：

```json
{
  "observations": [{
    "observationId": "obs-实际观察标识",
    "facts": [{"entity": "商品 A", "attribute": "price", "value": "100 元", "evidence": "商品 A 价格 100 元"}]
  }]
}
```

- URL、标题和观察时间由 Host 从该观察中取得，不接受模型自行声明来源。旧版本日志若缺少这些字段，会显示为空，不伪造来源。
- `evidence` 必须是该观察的连续原文（允许空白差异），并包含实体与值；不接受编造数值或自行换算。是否与任务相关、实体与字段的语义关系仍由模型判断，代码不保证判断永远正确。
- `facts: []` 必须同时给出 `reason`，用于确认该观察没有任务所需信息。已保存的事实不会因之后给出空列表而被删除。
- 最新值按照**观察先后**而非补记顺序决定；不同来源的相同商品分别保留。比较时仍需确认币种、规格与时间一致。
- `browser_recall {}` 返回当前事实和未处理观察；`query` 搜索事实，`includeHistory` 包括旧值，`offset/limit` 分页，`nextObservationOffset` 用于未处理观察列表。指定 `observationId` 时读取最多 12000 字符的历史观察，`offset` 改为字符位置。
- 浏览器关闭后失效的是页面元素引用，已保存的价格等历史事实继续保留；历史事实不等于实时价格。事实和观察的持久性依赖 DSH 保留 Session 原始日志。
- 为避免同批并发导航跳过中间页面观察，同一 Session 的浏览器操作不并发执行。任务记忆工具不操作网页；记录和校验过程不调用额外 LLM，也不引入外部数据库。

持久化使用宿主已支持的 `user/message`，来源标记为 `dsh-browser:fact-record`；每轮上下文只保留简短回执与工作记忆摘要，完整事实和证据留在原始日志中。这样不会因引入宿主不认识的事件类型导致重启后无法加载。

验证（2026-09-08）：34 项测试涵盖跨页价格、旧值回查、晚补记不覆盖新值、原文/来源校验、无关确认、分页、并发拦截、取消、Session 隔离和磁盘记录经过 DSH 持久化入口冷加载。真实 Cordis/DSH + Chromium 比价场景完成 12 次模型请求，保存 A=100、B=200、A=90 三条事实版本，最终读取 A=90、B=200、差价110元；漏记时导航在副作用前被阻止，通用压缩后可恢复事实。严格类型检查、17 工具 tarball 安装导入和 Chromium 冒烟通过。决策使用确定性模型适配器，未宣称线上 LLM 的自主任务成功率。

实现位置：[`src/browser-memory.ts`](src/browser-memory.ts) 负责来源校验、追加事实日志、查询与工作记忆恢复；[`src/browser-memory-tools.ts`](src/browser-memory-tools.ts) 注册两个工具；[`src/browser-runtime.ts`](src/browser-runtime.ts) 在每轮模型调用前组合任务记忆与 DOM 保留策略；[`src/plugin-tools.ts`](src/plugin-tools.ts) 在网页副作用前检查待处理观察及并发操作。`prepareBrowserContext` 是底层 DOM 策略函数，生产入口由 `BrowserRuntime.prepareContext` 传入已处理观察集合并恢复记忆摘要。

参考依据：检查本机 OpenCode 浏览器模块后，其 `tools/start.ts` 主要要求模型在离开页面前记笔记，`session/message-v2.ts` 负责 DOM/截图裁剪，没有发现专用的跨页面事实保存与回读闭环。本次参考 [browser-use 的 ActionResult](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/views.py)、[提取工具](https://github.com/browser-use/browser-use/blob/main/browser_use/tools/service.py) 和 [消息管理器](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/message_manager/service.py)：分别处理临时读取与持续记忆，长提取结果可保存并回读。2026-09-08 读取官方 main 源码；本项目借鉴该设计，在 DSH Session 日志上独立实现，并额外加入来源证据校验与未记录观察保护，没有复制对方实现。

## Host 如何管理 Browser State 与 Agent Context

以前，插件主要决定“这次工具返回什么”；历史页面是否继续进入模型输入，交给宿主的一般策略。本次增加了 `browserRuntime` 宿主服务和 `agent/pre-step` 钩子：同一套集成既持有会话浏览器，又在下一次模型请求前决定哪些浏览器观察继续可见。

```text
DSH Agent 调用 browser_* 工具
  → ctx.browserRuntime 按 Session 找到 BrowserManager
  → 操作 Chromium，生成带运行时、标签页和基线标识的观察
  → 工具结果与观察元数据写入 Session 日志
  → agent/pre-step 保留最新观察及必要基线，替换过期页面/图像
  → DSH 根据 Session surface 构造模型消息
  → 模型决定下一步
```

| 修改位置 | 怎么修改 | 作用 |
|---|---|---|
| [`src/index.ts`](src/index.ts) | 提供 `browserRuntime` 服务，注册每轮执行前与会话释放钩子 | 将浏览器管理接入宿主 Agent Loop 和生命周期 |
| [`src/browser-runtime.ts`](src/browser-runtime.ts) | 按 Session 持有管理器，统一准备上下文与清理资源 | 两个 Agent 不共享浏览器；会话释放或插件卸载时清理对应进程 |
| [`src/browser/manager.ts`](src/browser/manager.ts) | 移除全局静态实例表，由宿主服务创建实例；重置时更换运行时标识 | 区分浏览器重启前后的引用，避免把旧 DOM 当成当前状态 |
| [`src/browser-observation.ts`](src/browser-observation.ts)、[`src/browser/dom-utils.ts`](src/browser/dom-utils.ts) | 记录 `runtimeId / tabId / domId / baseDomId`；保存同一次观察的完整版本；大变化及周期检查点返回完整 DOM | 增量有明确基准；基准缺失时可恢复完整观察，不把“仅新增内容”误当完整基线 |
| [`src/plugin-tools.ts`](src/plugin-tools.ts)、[`src/tool-schemas.ts`](src/tool-schemas.ts) | 将操作结果与页面观察拆为独立文本块；通过 `presentationMeta` 持久化观察身份和截图来源 | 可以只移除过期页面，保留操作结果、脚本提取的信息和错误；不靠页面里的标记猜测归属 |
| [`src/browser-context.ts`](src/browser-context.ts) | 沿明确的基线关系保留最新观察链；用 Session surface 替换过期内容；配合宿主 TokenMeter 记录替换前的估算值 | 下一轮模型实际收到经过整理的消息；原始日志和工具调用关联仍可回放 |
| [`src/browser/operations/observe.ts`](src/browser/operations/observe.ts) 及其他观察操作 | 在串行浏览器操作中记录截图所对应的运行时、标签页和 DOM；各操作传递观察元数据 | 裁剪截图时依据实际采集来源，避免标签页切换后的归属混淆 |
| [`src/config.ts`](src/config.ts)、[`cordis.patch.yml`](cordis.patch.yml) | 增加 `maxContextDeltas`，默认 8 | 最多连续保留 8 次增量/无变化观察后建立完整检查点；它限制链长，不是总 token 上限 |

例如，先观察到完整商品列表 A，随后返回变化 B。宿主会同时保留 A 和依赖 A 的 B。出现新的完整列表 C 后，A、B 的页面块被替换为短占位符；先前脚本提取的商品信息仍保留。若 A 已被宿主其他策略裁剪，则使用 B 在采集时保存的完整版本补齐，不让模型只看到没有基准的变化。

具体保留规则：

- 保留最新浏览器观察、必要基线链，以及尚未完成事实记录/无关确认的观察；已确认的旧页面才能被正常淘汰。切换回已裁剪的标签页时，补齐最新完整观察。
- 仅保留与当前 DOM 对应的最新一批截图；旧图片从模型消息中移除，attachment 文件仍由宿主管理。
- 整段工具历史被宿主总结后，从原始日志补充最新的页面快照消息，不伪造新的工具调用。该快照是上次观察，不保证网页后台变化后仍然最新。
- 浏览器关闭、重启或会话重新加载而没有活跃运行时时，旧元素引用失效，提示重新启动并观察。
- 原始日志只追加记录，不删除；下一轮模型看到的是宿主的有效消息视图。任务事实需单独提取/记录，不能指望被淘汰的页面一直充当长期记忆。

这种设计的好处是：减少重复页面和旧截图对后续判断的干扰；保留完整的增量依据；把上下文整理、会话隔离、资源释放和回放放进同一宿主流程。代价是更依赖 DSH 的 Agent/Session API，并且为恢复保留完整观察会增加日志存储。本项目尚未证明真实任务成功率或 token 成本的提升幅度。

准确定位是：**以独立原生插件的形式，将浏览器运行时和浏览器观察管理集成到 DSH Agent Harness。** MCP 也可以通过宿主适配实现类似能力；关键在于实际接入上下文管理，而非插件名称或通信协议。当前实现不恢复 Chromium 进程、登录态、表单或 SPA 内存，也不承担所有任务历史的通用总结。

已验证的宿主契约固定为 DSH `0.1.2-alpha.2`，不再声明兼容旧的 `0.1.1-rc.2`；其他版本需重新验证。宿主挂载 TokenMeter 时，替换记录同步提供 token 估算所需信息。

首次上下文改造验证（2026-09-08）：`npm run check` 的 22 项测试及临时消费者 tarball 安装导入通过；严格 TypeScript 检查通过；`test:smoke` 使用真实 Chromium 验证工具与截图；`test:host` 使用真实 Cordis/DSH Agent Loop 和 Chromium，完成 14 次模型请求、12 次工具调用及 2 次截图，验证下一轮消息、回放、上下文计量和两个会话的隔离。模型决策使用确定性适配器，未调用线上 LLM；未测量真实任务成功率或成本改善。

## 它能做什么

| 任务 | 没装插件 | 装上插件 |
|---|---|---|
| 访问动态网站 | 只能依赖搜索或静态抓取 | 启动真实 Chromium 并操作页面 |
| 填写复杂表单 | 无法处理弹窗、下拉框和动态字段 | 通过 DOM 引用定位、输入和点击 |
| 多步资料调研 | 每一步都要人工复制页面内容 | Agent 可在多个标签页之间持续探索 |
| 理解页面变化 | 反复读取整页，浪费上下文 | 优先返回 DOM 差异，必要时建立完整基线 |
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

npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add ".\$package"
npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

`--dump-config` 中应出现 `id: dsh-browser` 和 `name: dsh-browser-plugin`。

### 发布到 npm 后

```powershell
npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add dsh-browser-plugin
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
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
    maxContextDeltas: 8
    scriptMaxLines: 100
    scriptMaxBytes: 8192
```

修改后重启 DSH，并用 `npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config` 检查最终配置。

| 需求 | 配置项 | 默认值 | 常用改法 |
|---|---|---:|---|
| 后台无界面运行 | `headless` | `false` | 改为 `true` |
| 指定浏览器程序 | `chromePath` | 自动探测 | 填入 Chrome/Chromium 绝对路径 |
| 调整操作审批 | `approvalMode` | `mutating` | `off`、`mutating` 或 `always` |
| 调整浏览器窗口 | `viewportWidth` / `viewportHeight` | `1280` / `900` | 改为所需正整数 |
| 限制单次工具时长 | `toolTimeoutMs` | `120000` | 填写正整数毫秒数 |
| 限制等待时长 | `maxWaitSeconds` | `300` | 填写正整数秒数 |
| 限制 DOM 增量链长 | `maxContextDeltas` | `8` | 正整数；达到后生成完整检查点 |
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
大量变化/检查点 → mode:full         建立新的完整基线
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
| `browser_record_facts` | 保存观察中的任务事实与来源，或确认观察与任务无关 |
| `browser_recall` | 搜索当前/历史事实，或回读已归档的页面观察 |

## 架构

```text
DSH Agent Session
  → Cordis 加载 dsh-browser-plugin
  → @deepseek-ai/dsh-tools defineTool
  → DSH approval / cancellation / timeout
  → browser operation
  → Session-scoped BrowserManager
  → Puppeteer + Chromium + CDP + DOM Service
  → canonical tool output / DSH attachments / observation metadata
  → agent/pre-step: browser context retention
  → Session surface → next model request
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

上下文策略优先通过 `Session.snapshotEvents()` 读取当前宿主日志；对依赖锁定的 DSH `0.1.2-alpha.2` 使用其 `events` getter。源码链接安装修改后需重新构建插件并重启 `pnpm dsh web`，使进程加载新的 `lib/`。

## 开发与验证

```powershell
npm install
npm test
npm run test:smoke
npm run test:host
npm run verify:package
npm run verify:installed
```

| 命令 | 验证内容 |
|---|---|
| `npm test` | 构建、包结构、工具注册、错误契约、approval 和配置测试 |
| `npm run test:smoke` | 真实启动 Chromium，验证 DOM、脚本、截图、attachment 和清理 |
| `npm run test:host` | 真实 Cordis/DSH Agent Loop + Chromium，验证下一轮消息、基线恢复、截图裁剪、回放与会话隔离；模型决策使用确定性适配器 |
| `npm run verify:package` | 确认 npm 包是独立 DSH bundle 且不包含 Harness checkout |
| `npm run verify:installed` | 在临时 npm 消费者项目中安装 tarball 并导入插件 |

`test/browser-context.test.mjs` 可通过 `DSH_TEST_SESSION_MODULE` 指定另一宿主 Session 模块的文件 URL，以复用全部上下文测试。检查 DSH 源码版本时，从其仓库根目录执行（假设插件位于相邻的 `dsh-browser` 目录）：

```powershell
$env:DSH_TEST_SESSION_MODULE = ([uri](Resolve-Path packages/core/session/src/index.ts).Path).AbsoluteUri
node --import tsx/esm --test ../dsh-browser/test/browser-context.test.mjs
Remove-Item Env:DSH_TEST_SESSION_MODULE
```

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目使用 [MIT License](LICENSE)。

---

<a id="english"></a>

# 🇬🇧 dsh-browser-plugin (English)

> Give DeepSeek Harness a real browser so an Agent can open pages, understand interfaces, fill forms, manage tabs, and complete multi-step tasks.

`dsh-browser-plugin` is a standalone [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin for the Web profile. It launches a local Chrome or Chromium instance and exposes 15 `browser_*` tools through Puppeteer, the Chrome DevTools Protocol (CDP), and incremental DOM snapshots.

This repository contains only the browser plugin's own source. It neither contains DeepSeek Harness source nor requires users to clone the Harness repository.

## Host-owned browser runtime and context

The plugin now exposes 15 browser operations plus two Session-local task-memory tools. `browser_record_facts` validates exact evidence quotes containing each entity and value, binds source URL/title/capture time from archived observations, and appends replayable fact records using host-native `user/message` envelopes. `browser_recall` searches current or historical facts and reads archived observations after navigation, browser closure or compaction. Different sources remain separate; newer observations win over older observations even if recorded out of order.

Unreviewed superseded observations are protected, and further browser actions pause before side effects until the Agent records relevant facts or supplies an explicit irrelevance reason. Same-session browser operations cannot run concurrently and skip intermediate observations. A bounded memory snapshot is rebuilt before model requests (up to 20 current facts); search/pagination retains access to all records. Semantic relevance still requires Agent judgment; quote validation does not prove a website's claim or guarantee the Agent records every relevant fact. Saved prices are historical evidence, not guaranteed live prices. Durability depends on preserving the host's raw Session log.

This design follows the separation of temporary reads and retained extraction results in browser-use's [ActionResult](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/views.py), [extraction tools](https://github.com/browser-use/browser-use/blob/main/browser_use/tools/service.py), and [message manager](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/message_manager/service.py), inspected from upstream main on 2026-09-08. The local OpenCode browser module only provides note-taking instructions and DOM retention. This is an independent DSH implementation, with additional provenance validation and review protection; no external database or extra LLM call is introduced.

The independently packaged native plugin now integrates both browser ownership and observation retention into DSH's Agent Harness. `src/index.ts` provides `ctx.browserRuntime` and an `agent/pre-step` hook; `src/browser-runtime.ts` owns one manager per Session and releases it on session disposal or plugin unload. No DSH source checkout or patch is required.

`src/browser-observation.ts`, `src/browser/dom-utils.ts`, and `src/plugin-tools.ts` record runtime, tab, DOM, and explicit baseline IDs in durable tool metadata. Observation text is separate from action results. `src/browser-context.ts` preserves the newest observation and its baseline chain, replaces superseded DOM/images through the Session surface API, and supplies shadow prices when the host TokenMeter is mounted. DSH then derives the actual next model request from that surface; raw history remains replayable.

Missing baselines are repaired using a complete version captured at the same observation. Large changes and periodic checkpoints produce complete DOM, not added-only baselines. Whole-history compaction can recover the latest logged observation as a plugin snapshot without inventing a tool call. A resumed Session without its live browser invalidates old references. These snapshots describe the last observation, not guaranteed live page contents.

Benefits include less stale page/image context, interpretable deltas, session isolation, and coordinated cleanup/replay. Costs include tighter host API coupling and larger durable logs from full recovery observations. This is not full browser-process/login/form restoration, general task summarization, or evidence of improved autonomous benchmark scores. MCP integrations can implement similar policies with host cooperation.

The verified host contract is pinned to DSH `0.1.2-alpha.2`; older `0.1.1-rc.2` and other releases are not advertised as compatible. The real-host smoke test uses published Cordis/DSH services and Chromium with deterministic model decisions, not a live LLM provider.

## What it enables

| Task | Without the plugin | With the plugin |
|---|---|---|
| Visit dynamic sites | Limited to search or static fetch | Operate a real Chromium page |
| Fill complex forms | Cannot reliably handle dynamic controls | Locate, fill, and click DOM references |
| Conduct multi-step research | Manually copy content at every step | Continue exploration across tabs |
| Understand page changes | Re-read the full page repeatedly | Prefer DOM diffs and establish a full baseline when needed |
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

npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add ".\$package"
npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
```

The dumped config should contain `id: dsh-browser` and `name: dsh-browser-plugin`.

### After npm publication

```powershell
npx @deepseek-ai/dsh@0.1.2-alpha.2 plugin --profile web add dsh-browser-plugin
npx @deepseek-ai/dsh@0.1.2-alpha.2 web
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
    maxContextDeltas: 8
    scriptMaxLines: 100
    scriptMaxBytes: 8192
```

Restart DSH after editing, then inspect the effective config with `npx @deepseek-ai/dsh@0.1.2-alpha.2 --profile web --dump-config`.

| Need | Setting | Default | Common change |
|---|---|---:|---|
| Run without a visible window | `headless` | `false` | Set to `true` |
| Select a browser executable | `chromePath` | Auto-detect | Set an absolute Chrome/Chromium path |
| Change approval behavior | `approvalMode` | `mutating` | `off`, `mutating`, or `always` |
| Resize the viewport | `viewportWidth` / `viewportHeight` | `1280` / `900` | Set positive integers |
| Limit one tool call | `toolTimeoutMs` | `120000` | Set positive milliseconds |
| Limit explicit waits | `maxWaitSeconds` | `300` | Set positive seconds |
| Bound DOM delta chains | `maxContextDeltas` | `8` | Positive integer; then produce a full checkpoint |
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
Large change/checkpoint → mode:full     new complete baseline
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
| `browser_record_facts` | Save source-grounded task facts or explicitly review irrelevant observations |
| `browser_recall` | Search current/historical facts or read archived browser observations |

## Architecture

```text
DSH Agent Session
  → Cordis loads dsh-browser-plugin
  → @deepseek-ai/dsh-tools defineTool
  → DSH approval / cancellation / timeout
  → browser operation
  → Session-scoped BrowserManager
  → Puppeteer + Chromium + CDP + DOM Service
  → canonical tool output / DSH attachments / observation metadata
  → agent/pre-step: browser context retention
  → Session surface → next model request
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

Context preparation reads current host logs through `Session.snapshotEvents()` and uses the `events` getter on the pinned DSH `0.1.2-alpha.2` host. After changing a source-linked installation, rebuild the plugin and restart `pnpm dsh web` to load the updated `lib/`.

Set `DSH_TEST_SESSION_MODULE` to another host Session module's file URL to run `test/browser-context.test.mjs` against it. For a source checkout, run from the DSH root with its TypeScript loader (the plugin is assumed to be in the sibling `dsh-browser` directory):

```powershell
$env:DSH_TEST_SESSION_MODULE = ([uri](Resolve-Path packages/core/session/src/index.ts).Path).AbsoluteUri
node --import tsx/esm --test ../dsh-browser/test/browser-context.test.mjs
Remove-Item Env:DSH_TEST_SESSION_MODULE
```

## Development and verification

```powershell
npm install
npm test
npm run test:smoke
npm run test:host
npm run verify:package
npm run verify:installed
```

| Command | Evidence produced |
|---|---|
| `npm test` | Build, package shape, tool registration, error contract, approval, and config tests |
| `npm run test:smoke` | Real Chromium DOM, script, screenshot, attachment, and cleanup checks |
| `npm run test:host` | Published Cordis/DSH Agent Loop + Chromium; real model-request inputs, baseline recovery, images, replay and isolation with deterministic decisions |
| `npm run verify:package` | Confirms the npm package is a standalone DSH bundle with no Harness checkout |
| `npm run verify:installed` | Installs the tarball in a temporary consumer project and imports the plugin |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [SECURITY.md](SECURITY.md) for security boundaries and vulnerability reporting.

## License

This project is released under the [MIT License](LICENSE).
