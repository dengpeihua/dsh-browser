import type { Page } from "puppeteer-core"
import { throwIfBrowserAborted, waitForBrowserDelay } from "./runtime.js"

/** Explicit postconditions are separate from dispatching a browser action or completing a task. */
export async function verifyPostconditions(page: Page, args: Record<string, unknown>, signal: AbortSignal) {
  throwIfBrowserAborted(signal)
  const text = typeof args.expectText === "string" ? args.expectText : undefined
  const url = typeof args.expectUrl === "string" ? args.expectUrl : undefined
  if (text === undefined && url === undefined) {
    return { verified: false, requested: false, checks: [] as Array<{ kind: string; passed: boolean }> }
  }
  const deadline = Date.now() + 5000
  let checks: Array<{ kind: string; passed: boolean }> = []
  do {
    throwIfBrowserAborted(signal)
    checks = []
    if (url !== undefined) checks.push({ kind: "url", passed: page.url() === url })
    if (text !== undefined) {
      try {
        const visibleText = await page.evaluate(() => document.body?.innerText ?? "")
        checks.push({ kind: "visible_text", passed: visibleText.includes(text) })
      } catch (error) {
        // Navigation can replace the execution context between the URL and text checks.
        if (!/Execution context was destroyed|Cannot find context/.test(String(error))) throw error
        checks.push({ kind: "visible_text", passed: false })
      }
    }
    throwIfBrowserAborted(signal)
    if (checks.every(check => check.passed)) return { verified: true, requested: true, checks }
    if (Date.now() >= deadline) break
    await waitForBrowserDelay(100, signal)
  } while (true)
  return { verified: false, requested: true, checks }
}
