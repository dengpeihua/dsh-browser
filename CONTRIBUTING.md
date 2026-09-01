# 贡献指南 / Contributing

> **[中文](#中文贡献指南)** | **[English](#english-contributing-guide)**

---

<a id="中文贡献指南"></a>

## 🇨🇳 中文贡献指南

感谢你改进 `dsh-browser-plugin`。本项目是一个独立的 DeepSeek Harness 插件；贡献内容应保持插件边界，不要把 DeepSeek Harness 或其他 Agent 框架的源码复制进本仓库。

### 环境要求

- Node.js `>=22.19`
- npm
- Chrome 或 Chromium
- `pnpm`（执行 DSH 安装验证时需要）

### 代码库布局

```text
src/                       源码事实来源
├─ index.ts                Cordis 插件入口和资源清理
├─ plugin-tools.ts         DSH defineTool 注册与执行边界
├─ tool-schemas.ts         工具参数和 canonical output schema
├─ config.ts               配置 schema 与运行时校验
└─ browser/
   ├─ manager.ts           Chromium、标签页和 Session 生命周期
   ├─ operations/          15 个浏览器操作
   ├─ cdp/                 Chrome DevTools Protocol
   └─ dom/                 DOM 快照、渲染、差异和视觉映射
lib/                       构建产物，不要手工修改
test/                      node:test 测试
scripts/                   真实浏览器与安装验证
cordis.patch.yml           DSH profile bundle patch
```

`src/` 是唯一源码事实来源。`lib/` 和根目录的 `.tgz` 都由构建命令生成。

### 本地开发

```powershell
npm install
npm run build
npm test
```

涉及真实浏览器行为时，再运行：

```powershell
npm run test:smoke
npm run verify:installed
```

常用命令：

| 命令 | 作用 |
|---|---|
| `npm run build` | 从 `src/index.ts` 生成 `lib/` |
| `npm test` | 构建并运行全部 `node:test` 测试 |
| `npm run test:smoke` | 启动真实 Chromium 并验证主链路 |
| `npm run verify:package` | 检查 bundle manifest、依赖和发布文件清单 |
| `npm run verify:installed` | 在临时消费者项目中安装并导入 tarball |
| `npm run check` | 运行测试与安装验证 |

### 工程约定

- 使用 ESM、TypeScript、双引号和两空格缩进，遵循现有文件风格。
- 新增配置必须同时更新 `src/config.ts`、`cordis.patch.yml`、README 配置表和测试。
- 新增浏览器工具必须同时更新操作实现、`TOOL_IDS`、参数 schema、README 工具表和注册测试。
- 浏览器状态必须按 DSH Agent 隔离，不能回退到进程级共享实例。
- 成功必须依据 Chromium 的真实后置状态，例如最终 URL、活动标签页或实际 DOM，而不是回显请求参数。
- approval、取消信号和超时必须在副作用边界生效；缺少必需的 approval 服务时应 fail closed。
- 错误信息应包含根因、安全重试建议和停止条件，不要吞掉导航或 CDP 错误。
- 不要手工修改 `lib/`，也不要提交 DeepSeek Harness checkout、`node_modules/` 或临时浏览器数据。

### 测试要求

| 改动类型 | 最低验证 |
|---|---|
| 文档 | 检查中英文一致性、内部链接和命令 |
| 配置或 schema | `npm test` |
| 工具注册或执行 | `npm test` + 对应行为测试 |
| Chromium/CDP/DOM | `npm test` + `npm run test:smoke` |
| 依赖或发布清单 | `npm run check` + `npm pack --dry-run` |

测试结果必须如实报告。静态检查、mock 测试和真实 Chromium 验证是不同证据，不能相互替代。

### Issue 与 Pull Request

请通过 [GitHub Issues](https://github.com/dengpeihua/dsh-browser/issues) 报告问题，并通过 [Pull Requests](https://github.com/dengpeihua/dsh-browser/pulls) 提交补丁。安全问题不要使用公开 Issue，请遵循 [SECURITY.md](SECURITY.md) 的私密报告流程。

较大的功能或破坏性改动应先开 Issue，说明问题、预期行为、安全影响和兼容策略。Pull Request 应：

1. 保持范围小而集中；
2. 说明修改原因和用户可见变化；
3. 列出实际运行的验证命令及结果；
4. 对 DOM、截图或交互变化提供可复现步骤；
5. 不包含密钥、Cookie、登录态、用户页面内容或本机绝对隐私路径。

建议使用 Conventional Commits：

```text
feat: add browser history navigation
fix(dom): preserve selector mapping across incremental snapshots
docs: clarify local tarball installation
test: cover session-scoped browser cleanup
```

安全问题不要提交公开 Issue，请遵循 [SECURITY.md](SECURITY.md)。

---

<a id="english-contributing-guide"></a>

## 🇬🇧 English contributing guide

Thank you for improving `dsh-browser-plugin`. This repository is a standalone DeepSeek Harness plugin. Contributions must preserve that boundary and must not copy a DeepSeek Harness or other Agent-framework checkout into this repository.

### Requirements

- Node.js `>=22.19`
- npm
- Chrome or Chromium
- `pnpm` for DSH installation verification

### Repository layout

```text
src/                       source of truth
├─ index.ts                Cordis entry and cleanup
├─ plugin-tools.ts         DSH defineTool registration and execution boundary
├─ tool-schemas.ts         parameter and canonical-output schemas
├─ config.ts               config schema and runtime validation
└─ browser/
   ├─ manager.ts           Chromium, tab, and Session lifecycle
   ├─ operations/          15 browser operations
   ├─ cdp/                 Chrome DevTools Protocol
   └─ dom/                 DOM snapshots, rendering, diffing, and visual mapping
lib/                       generated output; do not edit manually
test/                      node:test suite
scripts/                   real-browser and installation verification
cordis.patch.yml           DSH profile bundle patch
```

`src/` is the only source of truth. `lib/` and the root `.tgz` are generated artifacts.

### Local development

```powershell
npm install
npm run build
npm test
```

For changes that affect real browser behavior, also run:

```powershell
npm run test:smoke
npm run verify:installed
```

Common commands:

| Command | Purpose |
|---|---|
| `npm run build` | Generate `lib/` from `src/index.ts` |
| `npm test` | Build and run the complete `node:test` suite |
| `npm run test:smoke` | Launch real Chromium and verify the main path |
| `npm run verify:package` | Check the bundle manifest, dependencies, and publish list |
| `npm run verify:installed` | Install and import the tarball in a temporary consumer |
| `npm run check` | Run tests and installation verification |

### Engineering conventions

- Use ESM, TypeScript, double quotes, and two-space indentation, following the surrounding files.
- A new setting must update `src/config.ts`, `cordis.patch.yml`, the README config table, and tests.
- A new browser tool must update its operation, `TOOL_IDS`, parameter schema, README tool table, and registration tests.
- Browser state must remain isolated by DSH Agent; never fall back to a process-wide shared instance.
- Report success from Chromium's actual postcondition, such as the final URL, active tab, or observed DOM, rather than echoing requested input.
- Approval, cancellation, and timeout behavior must apply at side-effect boundaries. Missing required approval services must fail closed.
- Errors should retain the root cause, a safe retry, and a stop condition; do not swallow navigation or CDP failures.
- Do not edit `lib/` manually or commit a DeepSeek Harness checkout, `node_modules/`, or temporary browser data.

### Testing expectations

| Change | Minimum evidence |
|---|---|
| Documentation | Check bilingual consistency, internal links, and commands |
| Config or schema | `npm test` |
| Tool registration or execution | `npm test` plus focused behavior tests |
| Chromium/CDP/DOM | `npm test` plus `npm run test:smoke` |
| Dependencies or publishing | `npm run check` plus `npm pack --dry-run` |

Report evidence honestly. Static checks, mocked tests, and real Chromium validation are different forms of evidence and do not replace one another.

### Issues and pull requests

Use [GitHub Issues](https://github.com/dengpeihua/dsh-browser/issues) to report problems and [Pull Requests](https://github.com/dengpeihua/dsh-browser/pulls) to submit patches. Do not use a public Issue for security reports; follow the private process in [SECURITY.md](SECURITY.md).

Open an Issue before a large feature or breaking change. Describe the problem, expected behavior, security impact, and compatibility plan. A Pull Request should:

1. remain small and focused;
2. explain the motivation and user-visible behavior;
3. list the verification commands actually run and their results;
4. provide reproducible steps for DOM, screenshot, or interaction changes;
5. contain no secrets, cookies, login state, user page content, or private local paths.

Conventional Commit examples:

```text
feat: add browser history navigation
fix(dom): preserve selector mapping across incremental snapshots
docs: clarify local tarball installation
test: cover session-scoped browser cleanup
```

Do not open a public Issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).
