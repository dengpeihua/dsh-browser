import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { navigatePage, reloadPage, type BrowserOperation } from "../runtime.js"

export const browserGoto: BrowserOperation = {
  id: "browser_goto",
  description: "Navigate the active Chromium tab to a URL and return the verified final URL and DOM update.",
  async execute(args, context) {
    context.manager.ensureStarted()
    const requestedUrl = String(args.url)
    return context.manager.enqueue(async (isLast) => {
      const finalUrl = await navigatePage(context.manager.getActiveTab(), requestedUrl, context.signal)
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: `Navigate to ${finalUrl}`,
        output: `Navigated to ${finalUrl}${dom.output}`,
        metadata: { url: finalUrl, domId: dom.domId },
      }
    }, context.signal)
  },
}

export const browserRefresh: BrowserOperation = {
  id: "browser_refresh",
  description: "Reload the active tab and return its verified URL and current DOM update.",
  async execute(_args, context) {
    context.manager.ensureStarted()
    return context.manager.enqueue(async (isLast) => {
      const finalUrl = await reloadPage(context.manager.getActiveTab(), context.signal)
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: "Refresh page",
        output: `Page refreshed${dom.output}`,
        metadata: { url: finalUrl, domId: dom.domId },
      }
    }, context.signal)
  },
}

export const browserRestoreState: BrowserOperation = {
  id: "browser_restore_state",
  description: "Revisit the cached URL for a DOM stateId. Form values, scroll position, modal state, and SPA memory are not restored.",
  async execute(args, context) {
    const stateId = String(args.stateId)
    const match = stateId.match(/^(tab\d+)-(dom\d+)$/)
    if (!match) {
      return { title: "Restore state", output: `Invalid stateId format: "${stateId}". Expected "tabN-domN".`, metadata: {} }
    }
    const tabId = match[1]
    const domId = match[2]
    if (!tabId || !domId) throw new Error(`Unable to parse stateId ${stateId}`)
    const tab = context.manager.getTab(tabId)
    if (!tab) {
      return { title: "Restore state", output: `Tab "${tabId}" not found. It may have been closed.`, metadata: {} }
    }
    return context.manager.enqueue(async (isLast) => {
      await context.manager.switchTab(tabId)
      const snapshotUrl = tab.domService.getCachedUrl(domId)
      if (!snapshotUrl) {
        return {
          title: `Revisit ${stateId}`,
          output: `State ${stateId} no longer has a cached URL; no navigation was performed.`,
          metadata: {},
        }
      }
      const finalUrl = await navigatePage(tab, snapshotUrl, context.signal)
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: `Revisit ${stateId}`,
        output: `Revisited ${finalUrl} from ${stateId}. Only the URL was restored; transient page state was not.${dom.output}`,
        metadata: { url: finalUrl, domId: dom.domId },
      }
    }, context.signal)
  },
}
