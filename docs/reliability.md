# 浏览可靠性与验证

## 1. 动态页面与虚拟列表

旧逻辑按滚动位置合并“已看范围”，并把屏外 DOM 扩展区当作已观察范围。虚拟列表只渲染屏幕附近的条目，因此跳过扩展区可能遗漏数据。

现在每次采集后，覆盖计算会检查完整 DOM 内容指纹、页面 URL、真实容器身份和视口/内容尺寸。发生插入、删除、重排、虚拟节点替换或尺寸变化后，不匹配的旧范围不会继续算作已看。容器编号变化时按底层节点身份匹配，避免混用另一个容器的历史。

```text
采集当前内容和布局
  → 保存当前观察
  → 排除内容/尺寸/容器不匹配的历史观察
  → 只合并真实视口覆盖范围
  → 返回当前版本的已看与未看提示
```

`browser_scroll_next_screen` 每次推进实际视口的 80%，保留重叠；不再根据 DOM 扩展比例跳过区域。可见的滚动容器即使没有屏外子节点，也会获得可操作编号。

这是保守的覆盖机制：频繁变化的列表可能反复清空覆盖进度；未加载的服务器数据不会凭空出现在 DOM 中。要求“收集全部条目”时，Agent 仍须保存唯一 ID/链接、去重，并核对加载结束或总条目数。视口覆盖完成不等于所有业务条目已读完。

## 2. 执行、后置条件与任务完成

| 返回或字段 | 含义 |
|---|---|
| `status: error` | 元素不存在/遮挡/不可用、输入值不符，或明确要求的后置条件未满足。检查错误内容后再决定是否重试。 |
| `status: partial` | 部分请求完成，例如有些截图 ID 无效或检查点只恢复了一部分。 |
| `status: success` | 工具执行未报告失败；不能单独用来判断用户任务完成。 |
| `metadata.inputValueVerified` | 输入操作读回了与请求相符的值；这发生在可选 Enter 之前。 |
| `metadata.verification.requested` | 是否显式要求文本/URL 后置条件。 |
| `metadata.verification.verified` | 所要求的后置条件是否通过；未指定时为 false。 |
| `metadata.task: not_evaluated` | 该工具没有判断全部用户要求是否完成。 |

点击和输入可指定 `expectText`（主文档可见文字包含该字符串）、`expectUrl`（完整 URL 精确相等），同时指定时都必须满足。插件最多等待 5 秒，并响应取消。空条件会在浏览器操作前被拒绝。

```json
{"elementIndex": 12, "expectText": "Filter applied"}
```

没有指定后置条件时，点击只报告已执行且结果未验证。文本已经存在也可能满足条件，因此应选择能代表目标结果的内容；复杂任务仍需核对数量、筛选条件、来源等。此机制不宣称存在通用的自主任务验收器。

## 3. 精确检查点恢复

每次观察生成独立 ID，例如 `tab0-dom3`、`tab0-dom3.1`、`tab0-dom3.2`。必须使用模型收到的完整 ID；不能省略小数部分去恢复另一时刻。

```text
stateId → 查找内存检查点 → 访问原 URL
        → 核对地址 → 重新定位并恢复支持的字段
        → 恢复局部与主页面滚动 → 读回验证
        → 返回当前 DOM 和 restoration 报告
```

| 状态 | 支持范围 |
|---|---|
| 文本框、textarea、原生选择器 | 保存普通值、复选框/单选框状态、下拉选项；恢复时触发 input/change。 |
| details | 恢复展开/收起。 |
| 滚动 | 主页面与可识别局部容器的水平/垂直位置，允许 2 像素误差。 |
| Open Shadow DOM | 用跨 shadow root 的分段选择器定位支持的控件与滚动容器。 |
| 密码、文件选择 | 不采集、不恢复。 |
| iframe、任意弹窗、富文本编辑器、SPA 内存、登录会话 | 不承诺恢复；可识别的排除项计入 omitted。 |

每个检查点最多保存 500 个字段、200 个滚动容器；单字段序列化值超过 8,000 字符会被排除。字段值仅保留在当前浏览器缓存中，随快照淘汰、标签页关闭或浏览器重启失效。

字段丢失、只读、定位歧义、值被网页改写或滚动无法达到原位置，会返回 `partial` 和 `metadata.restoration` 中的 failed/omitted 数量。检查点不存在时返回 `error`，不执行导航。网站跳转到不同 URL 时不继续填写原检查点。

`restoration.verified: true` 仅表示本次捕获且支持的字段和滚动检查通过，不是完整网页运行时快照。网站重新加载可能产生新数据，任意脚本内部状态无法由通用插件还原。恢复不会复用旧元素编号，而是重新采集 DOM。

## 4. 验证入口

| 命令 | 覆盖 |
|---|---|
| `npm run check` | 单元/宿主上下文/记忆/包结构测试，以及真实临时消费者安装导入。 |
| `npx tsc --noEmit` | 严格类型检查。 |
| `npm run test:smoke` | 真实 Chromium 基础浏览与可靠性场景。 |
| `npm run test:host` | 真实 DSH Agent Loop、Chromium、模型请求上下文与事实记忆回归。 |

`scripts/smoke-reliability.mjs` 验证：缺失/遮挡元素、输入截断、成功/失败后置条件、精确版本恢复、只读字段的部分恢复、动态插入后覆盖失效，以及连续读取 60 条虚拟列表数据。测试使用本地页面与确定性工具调用，不代表线上 LLM 能自主完成所有网站任务。

## English contract

Coverage is tied to captured DOM content, container identity and dimensions; only actual viewports are merged. Next-screen scrolling advances 80% with overlap. This avoids expanded-region gaps but does not prove that all server-side items have loaded.

Expected failures return `error`; incomplete results return `partial`. Click/input may request visible-text and exact-URL postconditions with a five-second deadline. Input values are read back before optional Enter. Successful dispatch, a checked postcondition and overall task completion remain separate claims.

Exact checkpoint IDs retain same-URL subversions. Memory-only checkpoints restore supported native fields, details and scrolling, including open shadow roots, and verify the result. Excluded, missing or changed state is reported. Passwords, files, iframe state, arbitrary dialogs and SPA memory are not restored. Run the commands above for regression evidence.
