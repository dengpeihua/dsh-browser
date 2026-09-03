# 贡献指南 / Contributing

> **[中文](#中文贡献指南)** | **[English](#english-contributing-guide)**

---

<a id="中文贡献指南"></a>

## 🇨🇳 中文贡献指南

本项目是一个独立的 DeepSeek Harness 插件。

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


## 🇬🇧 English contributing guide

This repository is a standalone DeepSeek Harness plugin. 

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
