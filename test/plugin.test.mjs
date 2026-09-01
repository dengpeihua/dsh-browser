import assert from "node:assert/strict"
import test from "node:test"
import { apply, TOOL_IDS } from "../lib/index.js"

function harnessContext(services = {}) {
  const registered = []
  const promptSections = []
  const listeners = new Map()
  const context = {
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
    agent: { id: "test-session" },
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
  assert.equal(new Set(registered.map(tool => tool.name)).size, 15)
  assert.equal(promptSections.length, 1)
  assert.match(promptSections[0].text, /explicitly asks to use a browser/)
  assert.match(promptSections[0].text, /only permitted web-access tools for that entire turn/)
  assert.match(promptSections[0].text, /never call web_search or web_fetch before, alongside, or after them/)
  assert.equal(listeners.has("session/disposed"), true)
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
