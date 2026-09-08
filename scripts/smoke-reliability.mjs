import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { apply } from "../lib/index.js"
import { Session, SessionId } from "@deepseek-ai/dsh-session"

const html = `<!doctype html><title>Reliability fixture</title>
<style>body{margin:0}#list{height:240px;overflow:auto;width:350px}#spacer{height:2400px;position:relative}.row{position:absolute;height:40px}#tail{height:2200px}</style>
<input id="query" name="query"><input id="agree" type="checkbox"><select id="city"><option>Paris</option><option>Berlin</option></select>
<button id="apply" onclick="setTimeout(()=>document.getElementById('result').textContent='Filter applied',150)">Apply</button>
<button id="nothing">No effect</button><p id="result">Waiting</p>
<div id="shadow"></div><div id="list"><div id="spacer"></div></div><div id="tail">bottom</div>
<script>
document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<input id="note">';
const list=document.getElementById('list'), spacer=document.getElementById('spacer');
function rows(){let start=Math.floor(list.scrollTop/40);spacer.innerHTML=Array.from({length:7},(_,i)=>start+i).filter(i=>i<60).map(i=>'<div class="row" style="top:'+i*40+'px"><a href="#item-'+i+'">Item '+i+'</a></div>').join('')}
list.addEventListener('scroll',rows);rows();
</script>`
let fixture = html
let redirect = false
const server = createServer((req, res) => {
  if (redirect && req.url === "/") { res.writeHead(302, { Location: "/other" }); res.end(); return }
  res.setHeader("Content-Type", "text/html")
  res.end(req.url === "/other" ? "<h1>Elsewhere</h1>" : fixture)
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const url = `http://127.0.0.1:${server.address().port}/`
const registered = []
const context = {
  provide(name, value) { this[name] = value; return () => { delete this[name] } },
  tools: { register(tool) { registered.push(tool); return () => {} } },
  systemPrompt: { section() { return () => {} } }, on() { return () => {} }, get() {}, logger: { warn() {} },
}
const dispose = apply(context, { approvalMode: "off", headless: true })
const session = Session.create(SessionId("reliability-smoke"))
let seq = 0
async function call(name, args = {}) {
  const callId = `reliability-${++seq}`
  return registered.find(t => t.name === name).execute(args, {
    callId, rootCallId: callId, name, arguments: args, agent: { id: String(session.id), session },
    signal: new AbortController().signal, token: Symbol(), deferContext() {}, concludeTurn() {},
  })
}
try {
  await call("browser_start", { url })
  const manager = context.browserRuntime.getManager(String(session.id))
  const tab = manager.getActiveTab()
  const page = tab.page
  const missing = await call("browser_click", { elementIndex: 99999999 })
  assert.equal(missing.status, "error")

  // Capture a checkpoint with live form state, nested scroll and main scroll.
  await page.evaluate(() => {
    document.querySelector("#query").value = "engineer"
    document.querySelector("#agree").checked = true
    document.querySelector("#city").value = "Berlin"
    document.querySelector("#shadow").shadowRoot.querySelector("input").value = "saved note"
    document.querySelector("#list").scrollTop = 480
    window.scrollTo(0, 500)
  })
  const snapshot = await call("browser_execute_script", { script: "return document.title" })
  const stateId = snapshot.output.match(/stateId: (tab\d+-dom\d+(?:\.\d+)?)/)?.[1]
  assert.ok(stateId)
  await call("browser_goto", { url: url + "other" })
  const restored = await call("browser_restore_state", { stateId })
  assert.equal(restored.status, "success")
  const values = await page.evaluate(() => ({
    query: document.querySelector("#query").value, agree: document.querySelector("#agree").checked,
    city: document.querySelector("#city").value, nested: document.querySelector("#list").scrollTop, main: window.scrollY,
    shadow: document.querySelector("#shadow").shadowRoot.querySelector("input").value,
  }))
  assert.deepEqual(values, { query: "engineer", agree: true, city: "Berlin", nested: 480, main: 500, shadow: "saved note" })
  assert.equal(restored.metadata.restoration.verified, true)
  fixture = html.replace('<input id="query" name="query">', '<input id="query" name="query" readonly>')
  const partial = await call("browser_restore_state", { stateId })
  assert.equal(partial.status, "partial")
  assert.ok(partial.metadata.restoration.failed > 0)
  assert.equal(await page.$eval("#query", el => el.value), "", "read-only fields must not be overwritten")
  fixture = html
  redirect = true
  const redirected = await call("browser_restore_state", { stateId })
  assert.equal(redirected.status, "partial")
  assert.equal(redirected.metadata.restoration.reason, "url_mismatch")
  redirect = false
  const missingState = await call("browser_restore_state", { stateId: `${tab.id}-dom999999.1` })
  assert.equal(missingState.status, "error")
  assert.equal(page.url(), url + "other", "expired checkpoint must not navigate")

  // Coverage from an earlier layout must not survive inserting new content at the top.
  await call("browser_goto", { url })
  await call("browser_scroll_to_page", { container: 0, page: 1 })
  assert.ok(tab.domService.getExplorationBars(tab.lastDomId).get(0).explored.includes(0))
  await call("browser_execute_script", { script: "const p=document.createElement('p');p.textContent='New unseen listing';document.body.prepend(p)" })
  assert.ok(!tab.domService.getExplorationBars(tab.lastDomId).get(0).explored.includes(0), "new content invalidates old covered positions")

  await call("browser_goto", { url })
  function indexFor(id) {
    return [...tab.domService.getLatestSelectorMap()].find(([, n]) => n.attributes?.id === id)?.[0]
  }
  const entered = await call("browser_input", { elementIndex: indexFor("query"), text: "developer" })
  assert.equal(entered.status, "success")
  assert.equal(entered.metadata.inputValueVerified, true)
  await page.evaluate(() => { document.querySelector("#query").maxLength = 3 })
  const truncated = await call("browser_input", { elementIndex: indexFor("query"), text: "too long", pressEnter: true })
  assert.equal(truncated.status, "error")
  assert.equal(truncated.metadata.errorCode, "input_value_mismatch")
  await page.evaluate(() => { document.querySelector("#query").removeAttribute("maxlength") })
  const applied = await call("browser_click", { elementIndex: indexFor("apply"), expectText: "Filter applied" })
  assert.equal(applied.status, "success")
  assert.equal(applied.metadata.verification.verified, true)
  const unchanged = await call("browser_click", { elementIndex: indexFor("nothing"), expectText: "Will never exist" })
  assert.equal(unchanged.status, "error")
  assert.equal(unchanged.metadata.verification.verified, false)
  await page.evaluate(() => {
    const button = document.querySelector("#nothing"), rect = button.getBoundingClientRect()
    const overlay = document.createElement("div")
    overlay.id = "occluder"
    Object.assign(overlay.style, { position: "fixed", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px", zIndex: "999999" })
    document.body.append(overlay)
  })
  const occluded = await call("browser_click", { elementIndex: indexFor("nothing") })
  assert.equal(occluded.status, "error")
  assert.equal(occluded.metadata.errorCode, "element_occluded")

  await call("browser_goto", { url })
  const seen = new Set()
  let scrolls = 0
  while (scrolls < 14) {
    const items = await page.evaluate(() => [...document.querySelectorAll(".row")].filter(n => {
      const r = n.getBoundingClientRect(), box = document.querySelector("#list").getBoundingClientRect()
      return r.top >= box.top && r.bottom <= box.bottom
    }).map(n => Number(n.textContent.match(/\d+/)[0])))
    items.forEach(i => seen.add(i))
    const map = tab.domService.getLatestScrollContainerMap()
    const container = [...map].find(([, node]) => node.attributes?.id === "list")?.[0]
    assert.ok(container)
    const before = await page.$eval("#list", el => el.scrollTop)
    await call("browser_scroll_next_screen", { container, direction: "down" })
    const after = await page.$eval("#list", el => el.scrollTop)
    assert.ok(after - before <= 240, "virtual rows must not be skipped by an expanded-screen jump")
    scrolls++
    if (after === before) break
  }
  assert.equal(seen.size, 60, `All 60 virtual rows must be observed, got ${seen.size}`)
  console.log(JSON.stringify({ status: "success", restored: values, verifiedPostconditions: true, virtualRows: seen.size, scrolls }))
} finally {
  await dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
