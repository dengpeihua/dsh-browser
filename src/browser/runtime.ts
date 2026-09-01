import type { OutputLimiter } from "../output-limiter.js"
import type { BrowserToolId } from "../tool-schemas.js"
import type { TabState } from "./manager.js"
import { BrowserManager } from "./manager.js"

export interface BrowserAttachment {
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif"
  filename: string
  dataUrl: string
}

interface BrowserOperationResult {
  title: string
  output: string
  metadata: Record<string, unknown>
  attachments?: BrowserAttachment[]
}

interface BrowserOperationContext {
  manager: BrowserManager
  signal: AbortSignal
  outputLimiter: OutputLimiter
}

export interface BrowserOperation {
  id: BrowserToolId
  description: string
  execute(args: Record<string, unknown>, context: BrowserOperationContext): Promise<BrowserOperationResult>
}

function abortError(): Error {
  const error = new Error("Browser tool execution was aborted")
  error.name = "AbortError"
  return error
}

export function throwIfBrowserAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

export function waitForBrowserDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfBrowserAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function ensureHealthyPageUrl(url: string, requested: string): string {
  if (!url || url.startsWith("chrome-error://")) {
    throw new Error(`Navigation to ${requested} failed; Chromium ended on ${url || "an empty URL"}`)
  }
  return url
}

async function abortableNavigation<T>(tab: TabState, signal: AbortSignal, operation: Promise<T>): Promise<T> {
  throwIfBrowserAborted(signal)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void tab.cdpSession.send("Page.stopLoading").catch(() => {})
      reject(abortError())
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

export async function navigatePage(tab: TabState, requestedUrl: string, signal: AbortSignal): Promise<string> {
  await abortableNavigation(tab, signal, tab.page.goto(requestedUrl, { waitUntil: "domcontentloaded" }))
  throwIfBrowserAborted(signal)
  return ensureHealthyPageUrl(tab.page.url(), requestedUrl)
}

export async function reloadPage(tab: TabState, signal: AbortSignal): Promise<string> {
  const requestedUrl = tab.page.url()
  await abortableNavigation(tab, signal, tab.page.reload({ waitUntil: "domcontentloaded" }))
  throwIfBrowserAborted(signal)
  return ensureHealthyPageUrl(tab.page.url(), requestedUrl)
}
