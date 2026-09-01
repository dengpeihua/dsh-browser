# 安全策略 / Security Policy

> **[中文](#中文安全策略)** | **[English](#english-security-policy)**

---

<a id="中文安全策略"></a>

## 🇨🇳 中文安全策略

### 支持版本

当前项目处于 `0.1.x` 初始开发阶段，只维护最新版本。在 npm 首次发布前，“最新版本”指当前源码和由它生成的本地 tarball；发布后则指最新的公开 tag 和 npm 包。

| 版本 | 支持状态 |
|---|---|
| 最新 `0.1.x` | ✅ 主动维护 |
| 更早版本 | ❌ 请改用当前受支持版本 |

### 报告漏洞

请不要在公开 Issue、Pull Request、日志或示例中披露漏洞细节、凭据、Cookie、页面数据或可用攻击代码。

请使用 GitHub 的 [Report a vulnerability](https://github.com/dengpeihua/dsh-browser/security/advisories/new) 私密报告入口。不要通过公开 Issue 或 Pull Request 发送漏洞细节。

报告应包含：

- 受影响版本和运行环境；
- 最小复现步骤；
- 实际影响与攻击前提；
- 是否涉及恶意页面、恶意提示词、配置篡改或本地攻击者；
- 建议修复方向（如有）。

维护者会先确认问题是否属于本插件边界，再协调修复、测试和披露。请在修复发布前保持私密。

### 威胁模型

本插件让 AI Agent 操作本机真实浏览器。网页内容、模型输出和任务提示都可能是不可信输入。主要风险包括：

- 恶意网页利用提示注入诱导 Agent 泄露信息或执行越权操作；
- 浏览器访问 `localhost`、局域网或云元数据地址造成内部网络暴露；
- `browser_execute_script` 在当前页面上下文执行任意 JavaScript；
- 点击、输入、导航和标签页操作改变外部系统状态；
- 截图、DOM 和脚本结果包含账号、个人信息或业务数据；
- 被篡改的 `chromePath`、`outputDir` 或 profile patch 指向不可信程序或位置；
- `noSandbox: true` 削弱 Chromium 的进程隔离。

### 安全边界与部署建议

1. **Approval 不是浏览器沙箱。** `approvalMode: mutating` 能在副作用前请求确认，但不能隔离恶意页面、扩展、浏览器漏洞或已获准的危险操作。
2. **保持 Chromium sandbox。** 默认 `noSandbox: false`；仅在受控容器确有兼容需求时关闭。
3. **限制网络范围。** 不要让处理不可信任务的实例访问敏感内网、云元数据端点或管理平面。需要强隔离时使用容器或虚拟机并配置网络策略。
4. **使用专用浏览器身份。** 不要给 Agent 使用包含个人主账号、支付信息或管理员登录态的浏览器环境。
5. **高风险动作必须明确授权。** 登录、发送、发布、购买、删除、上传、下载和最终提交需要独立确认和后置条件验证。
6. **保护产物。** DOM、截图、attachment 和被截断脚本的完整结果都可能敏感；限制 `outputDir` 权限并按需清理。
7. **及时更新。** 保持 Chrome/Chromium、Node.js、Puppeteer、DSH 和本插件为受支持版本。

### 属于本项目的问题

- 绕过插件声明的 approval 策略；
- Session 之间泄露标签页、Cookie、DOM 快照或 attachment；
- 工具在报告失败时仍执行副作用，或报告成功但后置条件不成立；
- 通过工具参数造成非预期本地文件读写或命令执行；
- 插件日志、错误或输出无必要地泄露敏感数据；
- 插件自身导致的任意代码执行、路径遍历或依赖供应链问题。

### 通常不属于本项目的问题

- Chrome/Chromium、Node.js、Puppeteer 或 DSH 上游自身的漏洞；
- 用户主动设置 `approvalMode: off` 或 `noSandbox: true` 后的预期风险；
- 用户明确授权浏览器访问某网站或执行某页面脚本产生的预期行为；
- 用户配置的 LLM 提供方、浏览器扩展、代理或外部服务的数据处理行为；
- 仅有自动扫描告警、没有可验证影响或复现路径的报告。

上游问题仍可私下告知维护者，以便判断是否需要升级依赖或增加缓解措施。

---

<a id="english-security-policy"></a>

## 🇬🇧 English security policy

### Supported versions

The project is in its initial `0.1.x` development line, and only the latest version is maintained. Before the first npm publication, "latest" means the current source and the local tarball built from it. After publication, it means the newest public tag and npm package.

| Version | Support |
|---|---|
| Latest `0.1.x` | ✅ Actively maintained |
| Earlier versions | ❌ Use the current supported version |

### Reporting a vulnerability

Do not disclose vulnerability details, credentials, cookies, page data, or working exploit code in a public Issue, Pull Request, log, or example.

Use GitHub's private [Report a vulnerability](https://github.com/dengpeihua/dsh-browser/security/advisories/new) form. Do not send vulnerability details through a public Issue or Pull Request.

A useful report includes:

- affected version and environment;
- minimal reproduction steps;
- concrete impact and attack prerequisites;
- whether the scenario requires a malicious page, prompt injection, config tampering, or a local attacker;
- a proposed mitigation, if available.

Maintainers will first determine whether the issue belongs to this plugin's trust boundary, then coordinate a fix, verification, and disclosure. Keep the report private until a fix is released.

### Threat model

The plugin lets an AI Agent operate a real local browser. Page content, model output, and task prompts may all be untrusted. Principal risks include:

- prompt injection from a malicious page that induces data disclosure or unauthorized actions;
- browser access to localhost, private networks, or cloud metadata endpoints;
- arbitrary JavaScript executed in the active page by `browser_execute_script`;
- clicks, input, navigation, and tab operations that change external state;
- screenshots, DOM output, or script results containing account, personal, or business data;
- a tampered `chromePath`, `outputDir`, or profile patch pointing to an untrusted executable or location;
- reduced Chromium process isolation when `noSandbox: true` is enabled.

### Security boundaries and deployment guidance

1. **Approval is not a browser sandbox.** `approvalMode: mutating` requests confirmation before side effects, but it does not isolate malicious pages, extensions, browser vulnerabilities, or an approved dangerous action.
2. **Keep Chromium sandboxing enabled.** The default is `noSandbox: false`; disable it only for a demonstrated compatibility requirement in a controlled container.
3. **Restrict network reachability.** Do not let an instance handling untrusted tasks reach sensitive private networks, metadata endpoints, or management planes. Use a container or VM with network policy when strong isolation is required.
4. **Use a dedicated browser identity.** Do not give the Agent a browser environment containing primary personal accounts, payment data, or administrator sessions.
5. **Authorize high-risk effects explicitly.** Login, send, publish, purchase, delete, upload, download, and final-submit actions need separate confirmation and postcondition verification.
6. **Protect artifacts.** DOM output, screenshots, attachments, and complete truncated-script results may be sensitive. Restrict `outputDir` permissions and clean up data when appropriate.
7. **Stay current.** Keep Chrome/Chromium, Node.js, Puppeteer, DSH, and this plugin on supported versions.

### In scope

- bypassing the plugin's declared approval policy;
- leaking tabs, cookies, DOM snapshots, or attachments across Sessions;
- performing a side effect while reporting failure, or reporting success without the required postcondition;
- unexpected local file access or command execution through tool parameters;
- unnecessary disclosure of sensitive data through plugin logs, errors, or output;
- arbitrary code execution, path traversal, or dependency supply-chain issues caused by the plugin itself.

### Generally out of scope

- vulnerabilities in upstream Chrome/Chromium, Node.js, Puppeteer, or DSH;
- expected risk after a user deliberately sets `approvalMode: off` or `noSandbox: true`;
- expected behavior after a user explicitly authorizes a website visit or page script;
- data handling by a configured LLM provider, browser extension, proxy, or external service;
- automated scanner findings without a reproducible impact path.

Upstream issues may still be reported privately so maintainers can evaluate dependency upgrades or local mitigations.
