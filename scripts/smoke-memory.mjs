// Real-host A/B comparison. Only decisions are scripted; prices, observations and tools are real.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { recallBrowserMemory } from "../lib/index.js"

const flatten = messages => messages.flatMap(m => m.content).flatMap(b => b.type === "tool-result" ? b.content : [b]).filter(b => b.type === "text").map(b => b.text).join("\n")
function lastRecall(messages) {
  const results = messages.flatMap(m => m.content).filter(b => b.type === "tool-result")
  const output = results.at(-1).content.find(b => b.type === "text").text
  return JSON.parse(output.slice(output.indexOf("\n") + 1))
}

export async function runMemorySmoke(ctx) {
  let aVisits = 0
  let cVisits = 0
  const server = createServer((request, response) => {
    if (request.url === "/C") cVisits++
    const name = request.url === "/B" ? "B" : "A"
    const price = name === "B" ? 200 : ++aVisits > 1 ? 90 : 100
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(`<title>商品 ${name}</title><main><h1>商品 ${name}</h1><p>商品 ${name} 价格 ${price} 元</p></main>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const origin = `http://127.0.0.1:${server.address().port}`
  class PriceAdapter extends LlmAdapter {
    step = 0
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream(options) {
      const text = flatten(options.messages)
      const latest = text.match(/Latest observation: (obs-[a-f0-9]+)\./)?.[1]
      const quote = (name, price) => {
        const line = text.split("\n").find(l => l.includes(`商品 ${name}`) && l.includes(`${price} 元`) && !l.startsWith("{"))
        assert.ok(line, `actual DOM evidence for ${name} ${price} is visible`)
        return line
      }
      const record = (id, name, price, evidence) => ["browser_record_facts", { observations: [{ observationId: id, facts: [{ entity: `商品 ${name}`, attribute: "price", value: `${price} 元`, evidence }] }] }]
      let action
      switch (++this.step) {
        case 1: action = ["browser_start", { url: `${origin}/A` }]; break
        case 2: this.a = latest; action = ["browser_goto", { url: `${origin}/B` }]; break
        case 3:
          this.b = latest
          this.bQuote = quote("B", 200)
          assert.match(text, /商品 A 价格 100 元/, "unrecorded A remains readable after visiting B")
          action = ["browser_goto", { url: `${origin}/C` }]
          break
        case 4:
          assert.match(text, /Save task facts before further browsing/)
          assert.equal(cVisits, 0, "review guard fires before browser side effects")
          action = ["browser_recall", { observationId: this.a }]
          break
        case 5: {
          const recalled = lastRecall(options.messages)
          assert.equal(recalled.observation.source.url, `${origin}/A`)
          const evidence = recalled.observation.content.split("\n").find(l => l.includes("商品 A 价格 100 元"))
          action = record(this.a, "A", 100, evidence)
          break
        }
        case 6: action = record(this.b, "B", 200, this.bQuote); break
        case 7: action = ["browser_goto", { url: `${origin}/A` }]; break
        case 8: action = record(latest, "A", 90, quote("A", 90)); break
        case 9: action = ["browser_close_tab", { tabIds: ["tab0"] }]; break
        case 10: action = ["browser_recall", { includeHistory: true }]; break
        case 11:
          assert.deepEqual(lastRecall(options.messages).facts.filter(f => f.entity === "商品 A").map(f => f.value), ["100 元", "90 元"])
          action = ["browser_recall", {}]
          break
        default: {
          const facts = lastRecall(options.messages).facts
          assert.equal(facts.length, 2)
          const a = facts.find(f => f.entity === "商品 A")
          const b = facts.find(f => f.entity === "商品 B")
          assert.equal(a.value, "90 元")
          assert.equal(b.value, "200 元")
          assert.equal(a.source.url, `${origin}/A`)
          assert.equal(b.source.url, `${origin}/B`)
          const difference = parseInt(b.value) - parseInt(a.value)
          assert.equal(difference, 110)
          this.answer = `已记录的价格：A ${a.value}，B ${b.value}；A 便宜 ${difference} 元。来源：${a.source.url}、${b.source.url}`
          yield { type: "block-start", index: 0, blockType: "text" }
          yield { type: "text-delta", index: 0, text: this.answer }
          yield { type: "block-end", index: 0, block: { type: "text", text: this.answer } }
          yield { type: "finish", reason: { kind: "stop" } }
          return
        }
      }
      const [name, args] = action
      const id = `price-${this.step}`
      const argumentsJson = JSON.stringify(args)
      yield { type: "block-start", index: 0, blockType: "tool-call" }
      yield { type: "tool-call-delta", index: 0, id, name, argumentsDelta: argumentsJson }
      yield { type: "block-end", index: 0, block: { type: "tool-call", id, name, arguments: argumentsJson } }
      yield { type: "finish", reason: { kind: "tool-calls" } }
    }
  }
  try {
    const adapter = new PriceAdapter()
    ctx.llm.registerAdapter(["price-fixture"], adapter)
    const agent = ctx.agentLoop.create(SessionId("browser-price-memory"), { provider: "price-fixture", model: "fixture" })
    agent.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "比较两个页面中商品 A、B 的价格，保存来源，并更新重新观察到的价格。" }] }))
    await agent.whenIdle()
    assert.equal(adapter.step, 12, JSON.stringify(agent.session.events.slice(-5)))
    assert.match(adapter.answer, /110 元/)
    const errors = agent.session.events.filter(e => e.type === "tool/result" && e.surfaceOp === "append" && e.data.message.content[0].isError)
    assert.equal(errors.length, 1, "only the deliberately blocked navigation fails")
    assert.match(JSON.stringify(errors), /Save task facts before further browsing/)
    assert.deepEqual(recallBrowserMemory(ctx.agentLoop.create(SessionId("other-price-session"), { provider: "price-fixture", model: "fixture" }).session, {}).facts, [])
    const nodes = [...agent.session.surface.nodes]
    agent.session.append("user/message", createUserMessage({ source: { kind: "plugin", plugin: "test-compactor" }, content: [{ type: "text", text: "Generic task summary without prices" }] }), { surfaceOp: { op: "replace", start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: nodes })
    const replay = Session.create(agent.id, JSON.parse(JSON.stringify(agent.session.events)))
    ctx.browserRuntime.prepareContext(replay)
    assert.match(flatten(replay.deriveMessages()), /90 元/)
    assert.match(flatten(replay.deriveMessages()), /200 元/)
    assert.equal(recallBrowserMemory(replay, { includeHistory: true }).facts.length, 3)
    assert.equal(cVisits, 0)
    console.log(JSON.stringify({ memoryScenario: "success", hostRequests: adapter.step, savedFactVersions: 3, latestPrices: [90, 200], difference: 110, blockedNavigationBeforeSideEffect: true, replayAfterCompaction: true }))
  } finally {
    await ctx.browserRuntime.cleanupSession("browser-price-memory")
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
