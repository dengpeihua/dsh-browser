import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { waitForBrowserDelay, type BrowserOperation } from "../runtime.js"

function currentPage(info: { scrollY: number; viewportHeight: number }): number {
  if (info.viewportHeight <= 0) return 0
  return Math.round((info.scrollY / info.viewportHeight) * 10) / 10
}

function direction(value: unknown): "up" | "down" {
  return value === "up" ? "up" : "down"
}

export const browserRevealOffscreen: BrowserOperation = {
  id: "browser_reveal_offscreen",
  description: "Reveal content from an OFF-SCREEN block, optionally locating a specific target in the selected scroll container.",
  async execute(args, context) {
    const move = direction(args.direction)
    const container = Number(args.container)
    const target = typeof args.target === "string" && args.target.length > 0 ? args.target : undefined
    const tab = context.manager.getActiveTab()
    const { domService } = tab
    return context.manager.enqueue(async (isLast) => {
      if (target) {
        const node = await domService.scrollToOffscreenElementByIndex(target, container, move)
        if (node) {
          await waitForBrowserDelay(300, context.signal)
          const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
          return {
            title: `Scroll to "${target}" in [container:${container}]`,
            output: `Scrolled to element in container [${container}]: ${target}${dom.output}`,
            metadata: {},
          }
        }
      }
      const info = await domService.getScrollInfoByIndex(container)
      const beforePos = currentPage(info)
      const horizontal = container > 0 && (domService.getScrollContainerNode(container)?.renderInfo?.isHorizontalScroll ?? false)
      let targetX = info.scrollX
      let targetY = info.scrollY
      const sign = move === "down" ? 1 : -1
      if (horizontal) targetX += sign * info.viewportWidth * 0.9
      else targetY += sign * info.viewportHeight * 0.9
      await domService.scrollToPositionByIndex(container, targetX, targetY)
      await waitForBrowserDelay(300, context.signal)
      const next = await domService.getScrollInfoByIndex(container)
      const afterPos = currentPage(next)
      const atStart = horizontal ? next.scrollX <= 0 : next.scrollY <= 0
      const atEnd = horizontal
        ? next.scrollX + next.viewportWidth >= next.totalWidth - 1
        : next.scrollY + next.viewportHeight >= next.totalHeight - 1
      const boundary = move === "up" && atStart
        ? " (Already at the TOP of the page)"
        : move === "down" && atEnd ? " (Already at the BOTTOM of the page)" : ""
      const targetHint = target
        ? ` Target "${target}" was not found. Use browser_execute_script with __find() and scrollIntoView() for a targeted fallback.`
        : ""
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: `Scroll ${move} [container:${container}]`,
        output: `Scrolled ${move} on container [${container}]: P${beforePos} -> P${afterPos}${boundary}${targetHint}${dom.output}`,
        metadata: {},
      }
    }, context.signal)
  },
}

export const browserScrollNextScreen: BrowserOperation = {
  id: "browser_scroll_next_screen",
  description: "Advance to unseen content in a scroll container, one expanded screen at a time.",
  async execute(args, context) {
    const move = direction(args.direction)
    const container = Number(args.container)
    const tab = context.manager.getActiveTab()
    const { domService } = tab
    return context.manager.enqueue(async (isLast) => {
      const info = await domService.getScrollInfoByIndex(container)
      const beforePos = currentPage(info)
      const expand = domService.getLatestExpand() ?? 1
      const horizontal = container > 0 && (domService.getScrollContainerNode(container)?.renderInfo?.isHorizontalScroll ?? false)
      const sign = move === "down" ? 1 : -1
      const targetX = horizontal ? info.scrollX + sign * (0.9 + expand) * info.viewportWidth : info.scrollX
      const targetY = horizontal ? info.scrollY : info.scrollY + sign * (0.9 + expand) * info.viewportHeight
      await domService.scrollToPositionByIndex(container, targetX, targetY)
      await waitForBrowserDelay(300, context.signal)
      const next = await domService.getScrollInfoByIndex(container)
      const afterPos = currentPage(next)
      const atStart = horizontal ? next.scrollX <= 0 : next.scrollY <= 0
      const atEnd = horizontal
        ? next.scrollX + next.viewportWidth >= next.totalWidth - 1
        : next.scrollY + next.viewportHeight >= next.totalHeight - 1
      const boundary = move === "down" && atEnd
        ? " (Reached the BOTTOM of the page)"
        : move === "up" && atStart ? " (Reached the TOP of the page)" : ""
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: `Scroll ${move} next screen [container:${container}]`,
        output: `Scrolled ${move} to next screen on container [${container}]: P${beforePos} -> P${afterPos}${boundary}${dom.output}`,
        metadata: {},
      }
    }, context.signal)
  },
}

export const browserScrollToPage: BrowserOperation = {
  id: "browser_scroll_to_page",
  description: "Jump to a known page position in a scroll container.",
  async execute(args, context) {
    const page = Number(args.page)
    const container = Number(args.container)
    const tab = context.manager.getActiveTab()
    const { domService } = tab
    return context.manager.enqueue(async (isLast) => {
      const info = await domService.getScrollInfoByIndex(container)
      const beforePos = currentPage(info)
      const horizontal = container > 0 && (domService.getScrollContainerNode(container)?.renderInfo?.isHorizontalScroll ?? false)
      const targetX = horizontal ? page * info.viewportWidth : info.scrollX
      const targetY = horizontal ? info.scrollY : page * info.viewportHeight
      await domService.scrollToPositionByIndex(container, targetX, targetY)
      await waitForBrowserDelay(300, context.signal)
      const next = await domService.getScrollInfoByIndex(container)
      const afterPos = currentPage(next)
      const atStart = horizontal ? next.scrollX <= 0 : next.scrollY <= 0
      const atEnd = horizontal
        ? next.scrollX + next.viewportWidth >= next.totalWidth - 1
        : next.scrollY + next.viewportHeight >= next.totalHeight - 1
      const boundary = atStart && atEnd
        ? " (Content fits in one page)"
        : atStart ? " (At the TOP of the page)" : atEnd ? " (At the BOTTOM of the page)" : ""
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return {
        title: `Scroll to P${page} [container:${container}]`,
        output: `Scrolled to target page on container [${container}]: P${beforePos} -> P${afterPos}${boundary}${dom.output}`,
        metadata: {},
      }
    }, context.signal)
  },
}
