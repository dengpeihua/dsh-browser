import type { Page } from "puppeteer-core"
import { throwIfBrowserAborted, waitForBrowserDelay } from "./runtime.js"

type Locator = { path: string[]; signature: string }
type Field = Locator & { value?: string; checked?: boolean; selected?: string[]; open?: boolean }
type Scroll = Locator & { x: number; y: number }
export interface PageCheckpoint {
  url: string
  fields: Field[]
  scrolls: Scroll[]
  window: { x: number; y: number }
  omitted: number
}

/** Runs entirely in the document. Open shadow roots use a chain of scoped CSS selectors. */
function inDocument(mode: "capture" | "restore" | "verify", saved?: PageCheckpoint) {
  const signature = (el: Element) => JSON.stringify([
    el.tagName, el.getAttribute("id"), el.getAttribute("name"), el.getAttribute("type"),
    el.getAttribute("aria-label"), el.getAttribute("placeholder"),
  ])
  const selector = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`
    const segments: string[] = []
    let current: Element | null = el
    while (current) {
      const tag = current.tagName.toLowerCase()
      const siblings: Element[] = current.parentElement ? [...current.parentElement.children].filter(n => n.tagName === current!.tagName) : []
      segments.unshift(`${tag}:nth-of-type(${siblings.length ? siblings.indexOf(current) + 1 : 1})`)
      current = current.parentElement
    }
    return segments.join(" > ")
  }
  const locate = (ref: Locator): HTMLElement | undefined => {
    let root: Document | ShadowRoot = document
    let element: Element | undefined
    for (let i = 0; i < ref.path.length; i++) {
      const matches: NodeListOf<Element> = root.querySelectorAll(ref.path[i])
      if (matches.length !== 1) return
      const found: Element = matches[0]
      element = found
      if (i < ref.path.length - 1) {
        if (!found.shadowRoot) return
        root = found.shadowRoot
      }
    }
    return element instanceof HTMLElement && signature(element) === ref.signature ? element : undefined
  }
  const allowed = (el: HTMLElement) => {
    if (el instanceof HTMLInputElement) {
      return !["password", "file", "hidden", "submit", "button", "reset", "image"].includes(el.type) && !el.disabled && !el.readOnly
    }
    return (el instanceof HTMLTextAreaElement && !el.disabled && !el.readOnly)
      || (el instanceof HTMLSelectElement && !el.disabled) || el instanceof HTMLDetailsElement
  }
  const readField = (el: HTMLElement): Pick<Field, "value" | "checked" | "selected" | "open"> => {
    if (el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)) return { checked: el.checked }
    if (el instanceof HTMLSelectElement) return { selected: [...el.selectedOptions].map(o => o.value) }
    if (el instanceof HTMLDetailsElement) return { open: el.open }
    return { value: (el as HTMLInputElement | HTMLTextAreaElement).value }
  }
  if (mode === "capture") {
    const state: PageCheckpoint = { url: location.href, fields: [], scrolls: [], window: { x: scrollX, y: scrollY }, omitted: 0 }
    const visit = (root: Document | ShadowRoot, prefix: string[]) => {
      for (const el of root.querySelectorAll("*")) {
        if (!(el instanceof HTMLElement) || el.closest("#__elements_highlight_container__")) continue
        const ref = { path: [...prefix, selector(el)], signature: signature(el) }
        if (el.matches("input,textarea,select,details")) {
          if (allowed(el)) {
            const value = readField(el)
            if (JSON.stringify(value).length <= 8000 && state.fields.length < 500) state.fields.push({ ...ref, ...value })
            else state.omitted++
          } else if (el.matches('input[type="password"],input[type="file"]')) state.omitted++
        }
        if (el.matches("iframe,dialog,[contenteditable=true]")) state.omitted++
        const css = getComputedStyle(el)
        if (el !== document.scrollingElement && ((el.scrollHeight > el.clientHeight && /auto|scroll/.test(css.overflowY))
          || (el.scrollWidth > el.clientWidth && /auto|scroll/.test(css.overflowX)))) {
          if (state.scrolls.length < 200) state.scrolls.push({ ...ref, x: el.scrollLeft, y: el.scrollTop })
          else state.omitted++
        }
        if (el.shadowRoot) visit(el.shadowRoot, ref.path)
      }
    }
    visit(document, [])
    return { state, failed: 0, restored: 0 }
  }
  if (!saved || location.href !== saved.url) return { failed: 1, restored: 0 }
  let failed = 0, restored = 0
  for (const field of saved.fields) {
    if (location.href !== saved.url) return { failed: failed + 1, restored }
    const el = locate(field)
    if (!el || !allowed(el)) { failed++; continue }
    const { path: _path, signature: _signature, ...expected } = field
    if (mode === "restore" && JSON.stringify(readField(el)) !== JSON.stringify(expected)) {
      if (field.checked !== undefined && el instanceof HTMLInputElement) el.checked = field.checked
      else if (field.selected && el instanceof HTMLSelectElement) {
        for (const option of el.options) option.selected = field.selected.includes(option.value)
      } else if (field.open !== undefined && el instanceof HTMLDetailsElement) el.open = field.open
      else if (field.value !== undefined && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
        // Use the native setter so framework change trackers observe a real update.
        const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, field.value)
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }))
    }
    if (JSON.stringify(readField(el)) === JSON.stringify(expected)) restored++
    else failed++
  }
  for (const scroll of saved.scrolls) {
    const el = locate(scroll)
    if (!el) { failed++; continue }
    if (mode === "restore") el.scrollTo({ left: scroll.x, top: scroll.y, behavior: "instant" })
    if (Math.abs(el.scrollLeft - scroll.x) <= 2 && Math.abs(el.scrollTop - scroll.y) <= 2) restored++
    else failed++
  }
  if (mode === "restore") window.scrollTo({ left: saved.window.x, top: saved.window.y, behavior: "instant" })
  if (Math.abs(scrollX - saved.window.x) <= 2 && Math.abs(scrollY - saved.window.y) <= 2) restored++
  else failed++
  return { failed, restored }
}

export async function capturePageCheckpoint(page: Page): Promise<PageCheckpoint> {
  const result = await page.evaluate(inDocument, "capture" as const)
  if (!result.state) throw new Error("Unable to capture browser checkpoint")
  return result.state
}

export async function restorePageCheckpoint(page: Page, checkpoint: PageCheckpoint, signal: AbortSignal) {
  throwIfBrowserAborted(signal)
  if (page.url() !== checkpoint.url) return { verified: false, failed: 1, restored: 0, omitted: checkpoint.omitted, reason: "url_mismatch" }
  await page.evaluate(inDocument, "restore" as const, checkpoint)
  await waitForBrowserDelay(300, signal)
  throwIfBrowserAborted(signal)
  const result = await page.evaluate(inDocument, "verify" as const, checkpoint)
  throwIfBrowserAborted(signal)
  return { verified: result.failed === 0 && checkpoint.omitted === 0, failed: result.failed, restored: result.restored, omitted: checkpoint.omitted }
}
