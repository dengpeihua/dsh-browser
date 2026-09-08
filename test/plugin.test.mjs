import assert from "node:assert/strict"
import test from "node:test"
import { apply, TOOL_IDS } from "../lib/index.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"

test("missing click targets return an error result instead of success", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off", headless: true })
  try {
    const exec = execution("browser_click")
    const manager = context.browserRuntime.getManager(String(exec.agent.session.id))
    manager.getActiveTab = () => ({ domService: { getLatestSelectorMap: () => new Map() } })
    manager.enqueue = async fn => fn(() => true)
    const tool = registered.find(t => t.name === "browser_click")
    const result = await tool.execute({ elementIndex: 999 }, exec)
    assert.equal(result.status, "error")
    assert.equal(result.metadata.errorCode, "element_not_found")
    assert.match(tool.output.render({}, result).map(x => x.text ?? "").join(""), /not found/)
  } finally { await dispose() }
})

test("empty postconditions fail before browser creation or approval", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "mutating", headless: true })
  try {
    context.browserRuntime.getManager = () => { throw new Error("Unexpected browser creation") }
    for (const name of ["browser_click", "browser_input"]) {
      const tool = registered.find(t => t.name === name)
      await assert.rejects(tool.execute({ elementIndex: 1, expectText: " ", ...(name === "browser_input" ? { text: "x" } : {}) }, execution(name)), /expectText must be a non-empty/)
    }
  } finally { await dispose() }
})

test("invalid restore checkpoints and missing images never report success", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off", headless: true })
  try {
    for (const stateId of ["not-a-state", "tab999-dom0.2"]) {
      const result = await registered.find(t => t.name === "browser_restore_state").execute({ stateId }, execution("browser_restore_state"))
      assert.equal(result.status, "error")
    }
    const result = await registered.find(t => t.name === "browser_view_elements").execute({ viewIds: [] }, execution("browser_view_elements"))
    assert.equal(result.status, "error")
  } finally { await dispose() }
})

test("cancellation during postcondition reads cannot become a successful click", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off", headless: true })
  const controller = new AbortController()
  try {
    const exec = execution("browser_click", controller.signal)
    const manager = context.browserRuntime.getManager(String(exec.agent.session.id))
    const node = { backendNodeId: 1, renderInfo: {}, attributes: {} }
    manager.getActiveTab = () => ({
      page: { async evaluate() { controller.abort(new Error("stop verification")); return "done" } },
      domService: {
        getLatestSelectorMap: () => new Map([[1, node]]), withClient: async fn => fn(),
        getElementRect: async () => ({ x: 0, y: 0, width: 20, height: 20 }),
        getScrollInfoByIndex: async () => ({ viewportHeight: 900, viewportWidth: 1280 }),
        getElementState: async () => ({ connected: true, disabled: false }),
        hitTestAtPoint: async () => true, click: async () => {}, recordInteraction() {},
      },
    })
    manager.enqueue = async fn => fn(() => true)
    await assert.rejects(registered.find(t => t.name === "browser_click").execute({ elementIndex: 1, expectText: "done" }, exec), /stop verification/)
  } finally { await dispose() }
})

function harnessContext(services = {}) {
  const registered = []
  const promptSections = []
  const listeners = new Map()
  const context = {
    provide(name, value) {
      context[name] = value
      return () => { delete context[name] }
    },
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {
          const index = registered.indexOf(tool)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    systemPrompt: {
      section(section) {
        promptSections.push(section)
        return () => {
          const index = promptSections.indexOf(section)
          if (index >= 0) promptSections.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    get(name) {
      return services[name]
    },
    logger: {
      warn() {},
    },
  }
  return { context, registered, promptSections, listeners }
}

function execution(name, signal = new AbortController().signal) {
  return {
    callId: `call-${name}`,
    rootCallId: `call-${name}`,
    name,
    arguments: {},
    agent: { id: "test-session", session: Session.create(SessionId("test-session")) },
    signal,
    token: Symbol(name),
    deferContext() {},
    concludeTurn() {},
  }
}

test("bundle registers the complete native DSH browser tool set and disposes it", async () => {
  const { context, registered, promptSections, listeners } = harnessContext()
  const dispose = apply(context, { approvalMode: "off", headless: true })
  assert.deepEqual(registered.map(tool => tool.name), [...TOOL_IDS])
  assert.equal(new Set(registered.map(tool => tool.name)).size, 17)
  assert.equal(promptSections.length, 1)
  assert.match(promptSections[0].text, /explicitly asks to use a browser/)
  assert.match(promptSections[0].text, /only permitted web-access tools for that entire turn/)
  assert.match(promptSections[0].text, /never call web_search or web_fetch before, alongside, or after them/)
  assert.equal(listeners.has("session/disposed"), true)
  assert.equal(listeners.has("agent/pre-step"), true)
  assert.ok(context.browserRuntime)
  for (const tool of registered) {
    assert.equal(typeof tool.execute, "function")
    assert.equal(typeof tool.output.render, "function")
    assert.ok(tool.timeoutMs > 0)
  }

  await dispose()
  assert.equal(registered.length, 0)
  assert.equal(promptSections.length, 0)
  assert.equal(listeners.size, 0)
})

test("browser failures include a root cause, safe retry, and stop condition", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off", headless: true })
  const wait = registered.find(tool => tool.name === "browser_wait")
  await assert.rejects(
    wait.execute({ seconds: 0 }, execution("browser_wait")),
    error => {
      assert.match(error.message, /Browser not started/)
      assert.match(error.message, /Safe retry:/)
      assert.match(error.message, /Stop condition:/)
      return true
    },
  )
  await dispose()
})

test("browser_wait enforces the configured deployment cap before side effects", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off", maxWaitSeconds: 2 })
  const wait = registered.find(tool => tool.name === "browser_wait")
  await assert.rejects(
    wait.execute({ seconds: 3 }, execution("browser_wait")),
    /browser_wait seconds must be between 0 and 2/,
  )
  await dispose()
})

test("invalid positive-integer configuration fails during plugin load", () => {
  const { context } = harnessContext()
  assert.throws(() => apply(context, { viewportWidth: 0 }), /viewportWidth must be a positive integer/)
  assert.throws(() => apply(context, { maxContextDeltas: 0 }), /maxContextDeltas must be a positive integer/)
})

test("host context policy runs after downstream pre-step work and respects cancellation and skipped steps", async () => {
  const { context, listeners } = harnessContext()
  const dispose = apply(context, { approvalMode: "off" })
  const order = []
  context.browserRuntime.prepareContext = session => { order.push(session.id) }
  const hook = listeners.get("agent/pre-step")
  const controller = new AbortController()
  const payload = { agent: { session: { id: "context" } }, signal: controller.signal }
  const enter = { kind: "enter" }
  assert.equal(await hook(payload, async () => { order.push("downstream"); return enter }), enter)
  assert.deepEqual(order, ["downstream", "context"])
  await hook(payload, async () => ({ kind: "skip" }))
  assert.equal(order.length, 2)
  controller.abort(new Error("cancelled"))
  await assert.rejects(hook(payload, async () => enter), /cancelled/)
  assert.equal(order.length, 2)
  const runtime = context.browserRuntime
  await dispose()
  assert.throws(() => runtime.getManager("late-session"), /runtime is closing/)
})

test("mutating tools fail closed when the DSH approval service is absent", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "mutating", headless: true })
  const start = registered.find(tool => tool.name === "browser_start")
  await assert.rejects(
    start.execute({ url: "data:text/html,approval" }, execution("browser_start")),
    /requires @deepseek-ai\/dsh-user-approval/,
  )
  await dispose()
})

test("browser state cannot be created by an executor without a DSH Agent", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off", headless: true })
  const wait = registered.find(tool => tool.name === "browser_wait")
  const exec = execution("browser_wait")
  exec.agent = undefined
  await assert.rejects(wait.execute({ seconds: 0 }, exec), /require a DSH Agent/)
  await dispose()
})

test("concurrent browser calls cannot navigate past an unobserved intermediate page", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off" })
  let started = 0
  context.browserRuntime.getManager = () => ({ ensureStarted() { started++ } })
  const wait = registered.find(tool => tool.name === "browser_wait")
  const first = wait.execute({ seconds: 0.03 }, execution("browser_wait"))
  try {
    await assert.rejects(wait.execute({ seconds: 0 }, execution("browser_wait")), /already running/)
    await first
    assert.equal(started, 1)
  } finally { await first; await dispose() }
})

test("cancelled memory writes do not append events", async () => {
  const { context, registered } = harnessContext()
  const dispose = apply(context, { approvalMode: "off" })
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  const exec = execution("browser_record_facts", controller.signal)
  const before = exec.agent.session.events.length
  await assert.rejects(registered.find(t => t.name === "browser_record_facts").execute({ observations: [] }, exec), /cancelled/)
  assert.equal(exec.agent.session.events.length, before)
  await dispose()
})
