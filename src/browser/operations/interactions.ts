import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { VALUE_SETTABLE_INPUT_TYPES } from "../dom/tree/clickable-detector.js"
import type { EnhancedDOMTreeNode } from "../dom/types/dom-node.js"
import type { TabState } from "../manager.js"
import { waitForBrowserDelay, type BrowserOperation } from "../runtime.js"

function findSelectAncestor(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode | undefined {
  let current = node.parentNode
  while (current) {
    if (current.nodeName.toLowerCase() === "select") return current
    current = current.parentNode
  }
  return undefined
}

function isValueSettableElement(node: EnhancedDOMTreeNode): boolean {
  const tagName = node.nodeName.toLowerCase()
  if (tagName === "input") {
    return VALUE_SETTABLE_INPUT_TYPES.has((node.attributes?.type ?? "text").toLowerCase())
  }
  return node.attributes?.role === "slider"
}

async function getElementDataByIndex(tab: TabState, elementIndex: number, signal: AbortSignal) {
  const selectorMap = tab.domService.getLatestSelectorMap()
  if (!selectorMap) return null
  const node = selectorMap.get(elementIndex)
  if (!node) return null
  const interactionNode = node.renderInfo?.isSelectOption ? (findSelectAncestor(node) ?? node) : node

  return tab.domService.withClient(async () => {
    let rect = await tab.domService.getElementRect(interactionNode)
    const scrollInfo = await tab.domService.getScrollInfoByIndex(0).catch(() => ({
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 1280,
      viewportHeight: 900,
      totalWidth: 1280,
      totalHeight: 900,
    }))
    const inViewport = rect.y + rect.height > 0
      && rect.y < scrollInfo.viewportHeight
      && rect.x + rect.width > 0
      && rect.x < scrollInfo.viewportWidth
    if (!inViewport) {
      await tab.domService.scrollToElement(interactionNode)
      await waitForBrowserDelay(150, signal)
      rect = await tab.domService.getElementRect(interactionNode)
    }
    return {
      node,
      rect,
      isFill: node.renderInfo?.isFill ?? false,
      isSelectOption: node.renderInfo?.isSelectOption ?? false,
      renderedLine: node.renderInfo?.renderedLine,
    }
  })
}

export const browserClick: BrowserOperation = {
  id: "browser_click",
  description: "Click a [N] or <N> element from the current DOM snapshot. Reveal off-screen elements first.",
  async execute(args, context) {
    const elementIndex = Number(args.elementIndex)
    const tab = context.manager.getActiveTab()
    return context.manager.enqueue(async (isLast) => {
      const elementData = await getElementDataByIndex(tab, elementIndex, context.signal)
      if (!elementData) {
        return { title: `Click [${elementIndex}]`, output: `Element [${elementIndex}] not found or not clickable in the current DOM.`, metadata: {} }
      }
      return tab.domService.withClient(async () => {
        if (elementData.isSelectOption) {
          await tab.domService.selectOption(elementData.node)
          tab.domService.recordInteraction(elementData.node.backendNodeId, "select", elementData.renderedLine)
          await waitForBrowserDelay(200, context.signal)
          const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
          const label = elementData.renderedLine?.trim() ?? `option [${elementIndex}]`
          return { title: `Select ${label}`, output: `Selected ${label}${dom.output}`, metadata: {} }
        }

        const isHit = await tab.domService.hitTestAtPoint(elementData.node)
        if (!isHit) {
          return { title: `Click [${elementIndex}]`, output: `Element [${elementIndex}] is occluded by another element. Try closing overlays or scrolling.`, metadata: {} }
        }
        const cssX = elementData.rect.x + elementData.rect.width / 2
        const cssY = elementData.rect.y + elementData.rect.height / 2
        await tab.domService.click(cssX, cssY)
        tab.domService.recordInteraction(elementData.node.backendNodeId, "click", elementData.renderedLine)
        await waitForBrowserDelay(500, context.signal)
        const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
        const label = elementData.renderedLine?.trim() ?? `element [${elementIndex}]`
        return { title: `Click ${label}`, output: `Clicked ${label}${dom.output}`, metadata: {} }
      })
    }, context.signal)
  },
}

export const browserInput: BrowserOperation = {
  id: "browser_input",
  description: "Enter text into a <N> input from the current DOM snapshot, optionally clearing it and pressing Enter.",
  async execute(args, context) {
    const elementIndex = Number(args.elementIndex)
    const text = String(args.text)
    const clear = typeof args.clear === "boolean" ? args.clear : true
    const pressEnter = typeof args.pressEnter === "boolean" ? args.pressEnter : false
    const tab = context.manager.getActiveTab()
    return context.manager.enqueue(async (isLast) => {
      const elementData = await getElementDataByIndex(tab, elementIndex, context.signal)
      if (!elementData) {
        return { title: `Input [${elementIndex}]`, output: `Element [${elementIndex}] not found in the current DOM.`, metadata: {} }
      }
      if (!elementData.isFill) {
        return { title: `Input [${elementIndex}]`, output: `Element [${elementIndex}] is not an input element. Use browser_click instead.`, metadata: {} }
      }
      return tab.domService.withClient(async () => {
        if (isValueSettableElement(elementData.node)) {
          await tab.domService.setInputValue(elementData.node, text)
        } else {
          const isHit = await tab.domService.hitTestAtPoint(elementData.node)
          if (!isHit) {
            return { title: `Input [${elementIndex}]`, output: `Element [${elementIndex}] is occluded. Try closing overlays or scrolling.`, metadata: {} }
          }
          const cssX = elementData.rect.x + elementData.rect.width / 2
          const cssY = elementData.rect.y + elementData.rect.height / 2
          await tab.domService.click(cssX, cssY)
          await waitForBrowserDelay(100, context.signal)
          if (clear) {
            await tab.page.keyboard.down("Control")
            await tab.page.keyboard.press("a")
            await tab.page.keyboard.up("Control")
            await waitForBrowserDelay(50, context.signal)
          }
          await tab.page.keyboard.type(text)
        }
        tab.domService.recordInteraction(elementData.node.backendNodeId, "input", elementData.renderedLine)
        if (pressEnter) await tab.domService.pressEnter()
        await waitForBrowserDelay(300, context.signal)
        const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
        const label = elementData.renderedLine?.trim() ?? `element <${elementIndex}>`
        return {
          title: `Input "${text}" into [${elementIndex}]`,
          output: `Input "${text}" into ${label}${pressEnter ? " and pressed Enter" : ""}${dom.output}`,
          metadata: {},
        }
      })
    }, context.signal)
  },
}
