import test from "node:test"
import assert from "node:assert/strict"
import { Session, SessionId } from "@deepseek-ai/dsh-session"
import { createUserMessage } from "@deepseek-ai/dsh-llm"
import * as browser from "../lib/index.js"
import { Context } from "@deepseek-ai/cordis"
import SessionStore from "@deepseek-ai/dsh-session"
import { PersistenceCoordinator } from "@deepseek-ai/dsh-session-persistence"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const fresh = () => Session.create(SessionId("memory-test"))
function observe(session, name, price, url = `https://shop.test/${name}`) {
  const domId = `dom${session.seq}`
  const callId = `call${session.seq}`
  const text = `Product ${name}: ${price} yuan`
  const observation = { version: 1, runtimeId: "live", tabId: "tab0", domId, mode: "full", output: text, fullOutput: text, url, title: name, capturedAt: "2026-09-08T00:00:00.000Z" }
  session.append("tool/call", { turn: 1, step: 1, callId, name: "browser_goto", arguments: "{}" })
  const event = session.append("tool/result", {
    turn: 1, step: 1, meta: { browserContext: { version: 1, observation } },
    message: createUserMessage({ source: { kind: "tool", callId }, content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }] }),
  }, { surfaceOp: "append" })
  return { event, observation, text }
}
const review = (o, name, price) => ({ observationId: browser.browserObservationId(o.observation), facts: [{ entity: name, attribute: "price", value: `${price} yuan`, evidence: o.text }] })
const messages = s => JSON.stringify(s.deriveMessages())

test("cross-page prices survive DOM retirement with source URLs and exact evidence", () => {
  assert.equal(typeof browser.recordBrowserFacts, "function", "Host needs a durable fact recording API")
  const s = fresh()
  const a = observe(s, "A", 100)
  browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
  const b = observe(s, "B", 200)
  browser.recordBrowserFacts(s, { observations: [review(b, "B", 200)] })
  browser.prepareBrowserContext(s, "live", undefined, browser.readBrowserMemory(s).reviewed)
  browser.prepareBrowserMemory(s)
  assert.doesNotMatch(messages(s), /Product A: 100 yuan/)
  const facts = browser.recallBrowserMemory(s, {}).facts
  assert.deepEqual(facts.map(f => [f.entity, f.value, f.source.url]), [["A", "100 yuan", "https://shop.test/A"], ["B", "200 yuan", "https://shop.test/B"]])
  assert.match(messages(s), /100 yuan/)
  assert.match(messages(s), /200 yuan/)
})

test("unreviewed old observations remain visible and stop further browsing until reviewed", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  observe(s, "B", 200)
  browser.prepareBrowserContext(s, "live", undefined, browser.readBrowserMemory(s).reviewed)
  assert.match(messages(s), /Product A: 100 yuan/)
  assert.throws(() => browser.guardBrowserMemory(s), /browser_record_facts/)
  browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
  assert.doesNotThrow(() => browser.guardBrowserMemory(s))
})

test("unsupported quotes, fabricated values and unknown sources fail atomically", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  const before = s.events.length
  const good = review(a, "A", 100)
  for (const bad of [
    { ...good, observationId: "unknown" },
    { ...good, facts: [{ ...good.facts[0], evidence: "Product A: 999 yuan" }] },
    { ...good, facts: [{ ...good.facts[0], value: "999 yuan" }] },
    { ...good, facts: [] },
  ]) assert.throws(() => browser.recordBrowserFacts(s, { observations: [good, bad] }))
  assert.equal(s.events.length, before)
})

test("recording old evidence later cannot overwrite a newer price; history remains queryable", () => {
  const s = fresh()
  const a100 = observe(s, "A", 100)
  const a90 = observe(s, "A", 90)
  browser.recordBrowserFacts(s, { observations: [review(a90, "A", 90)] })
  browser.recordBrowserFacts(s, { observations: [review(a100, "A", 100)] })
  assert.deepEqual(browser.recallBrowserMemory(s, {}).facts.map(f => f.value), ["90 yuan"])
  assert.equal(browser.recallBrowserMemory(s, { includeHistory: true }).facts.length, 2)
  const other = observe(s, "A", 80, "https://another-shop.test/A")
  browser.recordBrowserFacts(s, { observations: [review(other, "A", 80)] })
  assert.equal(browser.recallBrowserMemory(s, {}).facts.length, 2, "different vendors keep separate claims")
})

test("generic compaction and session replay restore facts without reviving old tool calls", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
  browser.prepareBrowserMemory(s)
  const nodes = [...s.surface.nodes]
  s.append("user/message", createUserMessage({ source: { kind: "plugin", plugin: "test-compactor" }, content: [{ type: "text", text: "Generic summary" }] }), { surfaceOp: { op: "replace", start: nodes[0], end: nodes.at(-1) }, sourceEventSeqs: nodes })
  const replay = Session.create(s.id, JSON.parse(JSON.stringify(s.events)))
  browser.prepareBrowserMemory(replay)
  assert.match(messages(replay), /100 yuan/)
  assert.match(messages(replay), /https:\/\/shop.test\/A/)
  const size = replay.events.length
  browser.prepareBrowserMemory(replay)
  assert.equal(replay.events.length, size, "memory projection is idempotent")
  assert.deepEqual(browser.recallBrowserMemory(replay, {}), browser.recallBrowserMemory(s, {}))
})

test("forgotten observations are readable from the archive; irrelevant reviews are explicit", () => {
  const s = fresh()
  const a = observe(s, "A", 100)
  const id = browser.browserObservationId(a.observation)
  const record = browser.recallBrowserMemory(s, { observationId: id })
  assert.equal(record.observation.content, a.text)
  assert.equal(record.observation.source.url, "https://shop.test/A")
  browser.recordBrowserFacts(s, { observations: [{ observationId: id, facts: [], reason: "This product is outside the user's requested comparison." }] })
  assert.equal(browser.readBrowserMemory(s).reviewed.has(id), true)
  assert.deepEqual(browser.recallBrowserMemory(s, {}).facts, [])
  assert.throws(() => browser.recallBrowserMemory(fresh(), { observationId: id }), /Unknown browser observation/)
})

test("memory output is paginated without deleting old facts and rejects invalid paging", () => {
  const s = fresh()
  for (let i = 0; i < 25; i++) {
    const o = observe(s, `Product${i}`, i)
    browser.recordBrowserFacts(s, { observations: [review(o, `Product${i}`, i)] })
  }
  browser.prepareBrowserMemory(s)
  assert.ok(messages(s).length < 30000)
  assert.equal(browser.recallBrowserMemory(s, { limit: 10 }).nextOffset, 10)
  assert.equal(browser.recallBrowserMemory(s, { offset: 20, limit: 10 }).facts.length, 5)
  assert.equal(browser.recallBrowserMemory(s, { query: "Product0" }).facts.length, 1)
  assert.throws(() => browser.recallBrowserMemory(s, { offset: -1 }))
  assert.throws(() => browser.recallBrowserMemory(s, { limit: 0 }))
  const updated = observe(s, "Product0", 999)
  browser.recordBrowserFacts(s, { observations: [review(updated, "Product0", 999)] })
  browser.prepareBrowserMemory(s)
  const snapshot = s.deriveMessages().find(m => m.source.kind === "plugin" && m.source.plugin === "dsh-browser:task-memory")
  assert.match(snapshot.content[0].text, /"entity":"Product0".*"value":"999 yuan"/, "updated facts must return to the recent working-memory preview")
})

test("facts survive the real DSH persistence cold-load gate from a disk artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-memory-persistence-"))
  const file = join(directory, "session.json")
  const context = new Context()
  try {
    const s = fresh()
    const a = observe(s, "A", 100)
    browser.recordBrowserFacts(s, { observations: [review(a, "A", 100)] })
    browser.prepareBrowserMemory(s)
    const stored = { meta: { id: s.id, version: 0, createdAt: Date.now() }, events: s.events }
    await writeFile(file, JSON.stringify(stored))
    await context.plugin(SessionStore)
    const load = async () => JSON.parse(await readFile(file, "utf8"))
    const backend = {
      name: "disk-fixture",
      async loadStored(id) { return id === s.id ? { ...await load(), revision: "disk-fixture:1" } : undefined },
      async readStoredRevision(id) { return id === s.id ? "disk-fixture:1" : undefined },
      async appendBatch() { throw new Error("This cold-read fixture must not append") },
      async commitRepair() { throw new Error("Complete fixture needs no repair") },
      async list() { return [stored.meta] },
    }
    const persistence = new PersistenceCoordinator(context, backend)
    const loaded = await persistence.load(s.id)
    const replay = Session.create(s.id, loaded.events)
    assert.equal(browser.recallBrowserMemory(replay, {}).facts[0].value, "100 yuan")
    assert.deepEqual(browser.recallBrowserMemory(replay, {}), browser.recallBrowserMemory(s, {}))
  } finally {
    await context.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
