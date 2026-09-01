import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { navigatePage, waitForBrowserDelay, type BrowserOperation } from "../runtime.js"

export const browserNewTab: BrowserOperation = {
  id: "browser_new_tab",
  description: "Open a new Chromium tab and optionally navigate it to a URL.",
  async execute(args, context) {
    context.manager.ensureStarted()
    const url = typeof args.url === "string" && args.url.length > 0 ? args.url : undefined
    return context.manager.enqueue(async (isLast) => {
      const tab = await context.manager.newTab()
      let finalUrl = tab.page.url()
      if (url) {
        finalUrl = await navigatePage(tab, url, context.signal)
        await waitForBrowserDelay(2000, context.signal)
      }
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: `New tab${url ? ` → ${finalUrl}` : ""}`,
        output: `Opened new tab${url ? ` and navigated to ${finalUrl}` : ""}${dom.output}`,
        metadata: { tabId: tab.id, url: finalUrl, domId: dom.domId },
      }
    }, context.signal)
  },
}

export const browserSwitchTab: BrowserOperation = {
  id: "browser_switch_tab",
  description: "Switch the active Chromium tab by its DSH browser tab ID.",
  async execute(args, context) {
    context.manager.ensureStarted()
    const tabId = String(args.tabId)
    return context.manager.enqueue(async (isLast) => {
      const tab = await context.manager.switchTab(tabId)
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: `Switch to ${tabId}`,
        output: `Switched to tab ${tabId}: ${tab.page.url()}${dom.output}`,
        metadata: { tabId, domId: dom.domId },
      }
    }, context.signal)
  },
}

export const browserCloseTab: BrowserOperation = {
  id: "browser_close_tab",
  description: "Close one or more Chromium tabs; without tabIds, close the active tab.",
  async execute(args, context) {
    context.manager.ensureStarted()
    return context.manager.enqueue(async (isLast) => {
      const provided = Array.isArray(args.tabIds) ? args.tabIds.map(String) : []
      const targets = provided.length > 0 ? provided : [context.manager.getActiveTab().id]
      for (const id of targets) await context.manager.closeTab(id)
      let domOutput = ""
      if (context.manager.hasActiveTab()) {
        domOutput = isLast() ? (await getPageDom(context.manager)).output : skippedDomOutput().output
      }
      return {
        title: `Close tab${targets.length > 1 ? "s" : ""}: ${targets.join(", ")}`,
        output: `Closed tab${targets.length > 1 ? "s" : ""}: ${targets.join(", ")}${domOutput}`,
        metadata: {},
      }
    }, context.signal)
  },
}
