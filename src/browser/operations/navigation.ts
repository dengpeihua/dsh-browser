import { restorePageCheckpoint } from "../page-state.js"
import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { operationError, navigatePage, reloadPage, type BrowserOperation } from "../runtime.js"

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
        observation: dom.observation,
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
        observation: dom.observation,
        metadata: { url: finalUrl, domId: dom.domId },
      }
    }, context.signal)
  },
}

export const browserRestoreState: BrowserOperation = {
  id: "browser_restore_state",
  description: "Restore a cached checkpoint URL, supported native form values, selections, details and scroll positions; report incomplete restoration explicitly.",
  async execute(args, context) {
    const stateId = String(args.stateId)
    const match = stateId.match(/^(tab\d+)-(dom\d+(?:\.\d+)?)$/)
    if (!match) {
      return operationError("Restore state", "invalid_state_id", `Invalid stateId format: "${stateId}". Expected "tabN-domN" or "tabN-domN.M".`)
    }
    const tabId = match[1]
    const domId = match[2]
    if (!tabId || !domId) throw new Error(`Unable to parse stateId ${stateId}`)
    const tab = context.manager.getTab(tabId)
    if (!tab) {
      return operationError("Restore state", "tab_not_found", `Tab "${tabId}" not found. It may have been closed.`)
    }
    return context.manager.enqueue(async (isLast) => {
      await context.manager.switchTab(tabId)
      const snapshotUrl = tab.domService.getCachedUrl(domId)
      const checkpoint = tab.domService.getPageCheckpoint(domId)
      if (!snapshotUrl || !checkpoint) {
        return {
          status: "error",
          title: `Restore ${stateId}`,
          output: `State ${stateId} no longer has a cached checkpoint; no navigation was performed.`,
          metadata: { errorCode: "checkpoint_unavailable" },
        }
      }
      const finalUrl = await navigatePage(tab, snapshotUrl, context.signal)
      const restoration = await restorePageCheckpoint(tab.page, checkpoint, context.signal)
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        status: restoration.verified ? "success" : "partial",
        title: `Restore ${stateId}`,
        output: `Restored checkpoint ${stateId} at ${finalUrl}: ${restoration.restored} checks passed, ${restoration.failed} failed, ${restoration.omitted} unsupported or excluded items. ${restoration.verified ? "Captured fields and scroll positions verified." : "Restoration incomplete; inspect the current page."} Arbitrary SPA memory and login state are not restored.${dom.output}`,
        observation: dom.observation,
        metadata: { url: finalUrl, domId: dom.domId, restoration },
      }
    }, context.signal)
  },
}
