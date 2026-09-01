import type { TabState, BrowserManager } from "./manager"
/**
 * Build model-facing DOM output and retain the snapshot chain needed to decode it.
 *
 * getPageDom synchronizes the active tab, captures and caches a new snapshot,
 * chooses full, incremental, added, or nochange output against the previous
 * snapshot, and appends tab and scroll metadata.
 */

const INCREMENTAL_DIFF_RATIO_THRESHOLD = 0.3

// DOM delimiter markers for downstream omit processing
const DOM_START = "<!-- DOM_START"
const DOM_END = "<!-- DOM_END -->"

export interface DomResult {
  /** Formatted string to append to tool output */
  output: string
  /** The domId of this snapshot */
  domId: string
  /** The tabId */
  tabId: string
  /** full = complete DOM (new base), incremental = small diff (preserves base), added = large diff (new base), nochange = nothing changed */
  mode: "full" | "incremental" | "added" | "nochange"
}

interface ExplorationData {
  explored: number[]
  current: number[]
  unexplored: number[]
}

/**
 * Order logic of toRanges: Sort - > Merge consecutive pages Code - > Output interlocking text P1, P1-3
 */
function toRanges(pages: number[]): string {
  if (pages.length === 0) return ""
  const sorted = [...pages].sort((a, b) => a - b)
  const [first, ...rest] = sorted
  if (first === undefined) return ""
  const ranges: string[] = []
  let start = first
  let end = start
  for (const page of rest) {
    if (page === end + 1) {
      end = page
    } else {
      ranges.push(start === end ? `P${start}` : `P${start}-${end}`)
      start = page
      end = start
    }
  }
  ranges.push(start === end ? `P${start}` : `P${start}-${end}`)
  return ranges.join(",")
}

/**
 * buildScrollBar computes the total, current pages, and unexplored pages, then joins them into one status line.
 */
function buildScrollBar(data: ExplorationData): string {
  const total = data.explored.length + data.current.length + data.unexplored.length
  const parts: string[] = [`${total} pages`]
  if (data.current.length > 0) parts.push(`viewing ${toRanges(data.current)}`)
  if (data.unexplored.length > 0) {
    const currentSet = new Set(data.current)
    const adjacentToView = data.unexplored.some((p) => currentSet.has(p - 1) || currentSet.has(p + 1))
    const jumpHint = !adjacentToView ? ` (use browser_scroll_to_page to jump directly)` : ""
    parts.push(`unexplored ${toRanges(data.unexplored)}${jumpHint}`)
  } else {
    parts.push("fully explored — if target not found, try a different approach")
  }
  return parts.join(" | ")
}

/**
 * formatExplorationBars in the order of execution: When data are available, the container by container scrollMap; no data returns an empty string.
 */
function formatExplorationBars(
  explorationBars?: Map<number, ExplorationData> | null,
): string {
  if (!explorationBars) return ""
  const parts: string[] = []
  for (const [index, data] of explorationBars) {
    parts.push(`[container:${index}] ${buildScrollBar(data)}`)
  }
  if (parts.length === 0) return ""
  return `\nscrollMap:\n${parts.join("\n")}`
}

/**
 * formatTabList: Only if more tab returns the list; space is left when single tab to avoid invalid noise.
 */
function formatTabList(
  tabs: { id: string; title: string; url: string; isActive: boolean }[],
): string {
  if (tabs.length <= 1) return ""
  const lines = tabs.map(
    (t) => `- ${t.isActive ? "[active] " : ""}[tab:${t.id}] ${t.title} (${t.url.slice(0, 80)})`,
  )
  return `\n**Tabs**:\n${lines.join("\n")}`
}

/**
 * Order of implementation of getPageDom:
 * Take activeTab with domService.
 * 2 Invert: generateDomId - extractCurrentDomTree - renderDomTree - computeViewportStats .
 * Cache snapshot (setCachedDomTree).
 * 4) If previousDomId exists, call getDiffStats and choose nochange, incremental, or added mode.
 * Updates lastDomId with a combination of diff hints, tabs and scroll information to form a returned text with DOM marks.
 */
export async function getPageDom(
  manager: BrowserManager,
  tab?: TabState,
): Promise<DomResult> {
  await manager.syncActiveTab()
  const activeTab = tab ?? manager.getActiveTab()
  const { domService } = activeTab
  const tabId = activeTab.id

  return domService.withClient(async () => {
    // The last round of renderDomTree will inject visual numbers into the page; it must be cleaned first, otherwise the snapshot will treat the tool's own overlay as a page DOM change.
    await domService.cleanupHighlightsBeforeSnapshot()
    const domId = domService.generateDomId()
    const stateId = `${tabId}-${domId.split(".")[0]}`
    const previousDomId = activeTab.lastDomId

    // Extract and render DOM tree (settle wait happens inside buildTree)
    const domTree = await domService.extractCurrentDomTree({ expand: 0.8 })
    const renderResult = await domService.renderDomTree(domTree)
    const url = activeTab.page.url()
    const viewportStats = await domService.computeViewportStats(renderResult.scrollContainerMap)
    const explorationBars = domService.getExplorationBars(domId)
    const tabList = manager.listTabs()

    // Cache the snapshot
    domService.setCachedDomTree(
      domId,
      domTree,
      renderResult.selectorMap,
      renderResult.scrollContainerMap,
      renderResult.visualElementMap,
      url,
      viewportStats,
      0.8,
      renderResult.hasOverlay,
      renderResult.topElementCount,
    )

    // Try diff when we have a previous snapshot on the same tab
    let diffMode: "full" | "incremental" | "added" | "nochange" = "full"
    let domHtml = renderResult.html

    if (previousDomId) {
      const diffStats = domService.getDiffStats(previousDomId, domId)

      if (diffStats !== null) {
        if (diffStats.added === 0 && diffStats.removed === 0) {
          activeTab.lastDomId = domId
          return {
            output: `\n\n${DOM_START} ${domId} tab:${tabId} mode:nochange -->\nNo DOM changes detected after the previous action.\n${DOM_END}`,
            domId,
            tabId,
            mode: "nochange" as const,
          }
        }

        const isIncremental =
          Math.max(diffStats.addedRatio, diffStats.removedRatio) < INCREMENTAL_DIFF_RATIO_THRESHOLD

        if (isIncremental) {
          const diffTree = domService.getDiffTree(previousDomId, domId, "both")
          if (diffTree) {
            const diffResult = await domService.renderDomTree(diffTree, { incrementalDiff: true })
            domHtml = diffResult.html
            diffMode = "incremental"
          }
        } else {
          const diffTree = domService.getDiffTree(previousDomId, domId, "added")
          if (diffTree) {
            const diffResult = await domService.renderDomTree(diffTree)
            domHtml = diffResult.html
            diffMode = "added"
          }
        }
      }
    }

    activeTab.lastDomId = domId

    // Build output with delimiter markers
    const overlayNotice = renderResult.hasOverlay
      ? "\n**Notice**: An overlay (modal/dialog) is covering the page. Handle or dismiss it first."
      : ""
    const bars = formatExplorationBars(explorationBars)
    const tabs = formatTabList(tabList)
    const diffTip =
      diffMode === "incremental"
        ? "\n**Tip**: Elements prefixed with `+|` are newly added and `-|` are removed since the previous action. Removed elements are no longer interactive."
        : diffMode === "added"
          ? "\n**Tip**: Elements prefixed with `+|` are newly appeared since the previous action."
          : ""

    const header = diffMode === "incremental" || diffMode === "added" ? "## Incremental DOM updates" : "## Current Page DOM Structure"

    const retentionTip = "\n**Reminder**: This DOM snapshot will be replaced after your next browser action. Record any important data (answers, values, navigation cues) in your text output now — unrecorded information will be lost."

    const content = `(stateId: ${stateId})\n${header}\n${tabs}\n\n${domHtml}${bars}${overlayNotice}${diffTip}${retentionTip}`

    return {
      output: `\n\n${DOM_START} ${domId} tab:${tabId} mode:${diffMode} -->\n${content}\n${DOM_END}`,
      domId,
      tabId,
      mode: diffMode,
    }
  })
}

const DOM_SKIPPED_MSG = "\n\n(DOM extraction deferred — it will be included in the last concurrent browser tool's output.)"

/**
 * skippedDomOutput: Resumes the fixed-space block when the output DOM is delayed under the scene, without error or interruption.
 */
export function skippedDomOutput(): DomResult {
  return {
    output: DOM_SKIPPED_MSG,
    domId: "",
    tabId: "",
    mode: "nochange",
  }
}
