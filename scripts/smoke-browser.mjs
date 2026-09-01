import assert from "node:assert/strict"
import { apply } from "../lib/index.js"

const registered = []
let savedImages = 0
const attachments = {
  async saveImages(inputs) {
    savedImages += inputs.length
    return inputs.map((input, index) => ({
      attachmentId: `sha256:${String(index + 1).padStart(64, "0")}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 64,
      height: 32,
      name: input.name,
    }))
  },
}
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
    section() {
      return () => {}
    },
  },
  on() {
    return () => {}
  },
  get(name) {
    return name === "attachments" ? attachments : undefined
  },
  logger: {
    warn(message) {
      process.stderr.write(`${message}\n`)
    },
  },
}

const dispose = apply(context, {
  approvalMode: "off",
  headless: true,
  toolTimeoutMs: 60_000,
})

let sequence = 0
function execution(name) {
  const callId = `smoke-${++sequence}`
  return {
    callId,
    rootCallId: callId,
    name,
    arguments: {},
    agent: { id: "smoke-session" },
    signal: new AbortController().signal,
    token: Symbol(callId),
    deferContext() {},
    concludeTurn() {},
  }
}

function tool(name) {
  const found = registered.find(item => item.name === name)
  assert.ok(found, `${name} was not registered`)
  return found
}

try {
  const html = encodeURIComponent("<!doctype html><title>DSH Browser Smoke</title><main><h1>ready</h1><button>Continue</button><svg width='64' height='32' aria-label='smoke chart'><rect width='64' height='32' fill='navy'/></svg></main>")
  const started = await tool("browser_start").execute(
    { url: `data:text/html,${html}` },
    execution("browser_start"),
  )
  assert.equal(started.status, "success")
  assert.match(started.output, /DSH Browser Smoke|ready|Navigated to data:/)

  const scripted = await tool("browser_execute_script").execute(
    { script: "return document.title" },
    execution("browser_execute_script"),
  )
  assert.equal(scripted.status, "success")
  assert.match(scripted.output, /DSH Browser Smoke/)

  const viewId = [...started.output.matchAll(/\[view:([^\]]+)\]/g)]
    .map(match => match[1])
    .find(id => id !== "ID")
  assert.ok(viewId, "the SVG should be indexed as a visual element")
  const viewed = await tool("browser_view_elements").execute(
    { viewIds: [viewId] },
    execution("browser_view_elements"),
  )
  assert.equal(viewed.status, "success")
  assert.equal(viewed.images.length, 1)
  assert.equal(viewed.artifacts.length, 1)
  assert.equal(savedImages, 1)

  process.stdout.write(JSON.stringify({
    status: "success",
    registeredTools: registered.length,
    startSummary: started.summary,
    scriptSummary: scripted.summary,
    screenshotSummary: viewed.summary,
    persistedImages: savedImages,
  }, null, 2) + "\n")
} finally {
  await dispose()
}
