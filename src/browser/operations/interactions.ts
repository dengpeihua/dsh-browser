import { verifyPostconditions } from "../verification.js"
import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { VALUE_SETTABLE_INPUT_TYPES } from "../dom/tree/clickable-detector.js"
import type { EnhancedDOMTreeNode } from "../dom/types/dom-node.js"
import type { TabState } from "../manager.js"
import { operationError, waitForBrowserDelay, type BrowserOperation } from "../runtime.js"

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
        return operationError(`Click [${elementIndex}]`, "element_not_found", `Element [${elementIndex}] not found or not clickable in the current DOM.`)
      }
      return tab.domService.withClient(async () => {
        const live = await tab.domService.getElementState(elementData.node)
        if (!live.connected || live.disabled) return operationError(`Click [${elementIndex}]`, "element_unavailable", "Element is detached or disabled; refresh the page state before retrying.")
        if (elementData.isSelectOption) {
          await tab.domService.selectOption(elementData.node)
          tab.domService.recordInteraction(elementData.node.backendNodeId, "select", elementData.renderedLine)
          await waitForBrowserDelay(200, context.signal)
          const verification = await verifyPostconditions(tab.page, args, context.signal)
          const outcome = verification.requested && !verification.verified ? "error" : "success"
          const note = verification.requested ? (verification.verified ? " Postcondition verified." : " Postcondition failed.") : " Action dispatched; outcome not verified. Check the returned page before claiming success."
          const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
          const label = elementData.renderedLine?.trim() ?? `option [${elementIndex}]`
          return { title: `Select ${label}`, status: outcome, output: `Selected ${label}${note}${dom.output}`, observation: dom.observation, metadata: { verification, task: "not_evaluated" } }
        }

        const isHit = await tab.domService.hitTestAtPoint(elementData.node)
        if (!isHit) {
          return operationError(`Click [${elementIndex}]`, "element_occluded", `Element [${elementIndex}] is occluded by another element. Try closing overlays or scrolling.`)
        }
        const cssX = elementData.rect.x + elementData.rect.width / 2
        const cssY = elementData.rect.y + elementData.rect.height / 2
        await tab.domService.click(cssX, cssY)
        tab.domService.recordInteraction(elementData.node.backendNodeId, "click", elementData.renderedLine)
        await waitForBrowserDelay(500, context.signal)
        const verification = await verifyPostconditions(tab.page, args, context.signal)
        const outcome = verification.requested && !verification.verified ? "error" : "success"
        const note = verification.requested ? (verification.verified ? " Postcondition verified." : " Postcondition failed.") : " Action dispatched; outcome not verified. Check the returned page before claiming success."
        const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
        const label = elementData.renderedLine?.trim() ?? `element [${elementIndex}]`
        return { title: `Click ${label}`, status: outcome, output: `Clicked ${label}${note}${dom.output}`, observation: dom.observation, metadata: { verification, task: "not_evaluated" } }
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
        return operationError(`Input [${elementIndex}]`, "element_not_found", `Element [${elementIndex}] not found in the current DOM.`)
      }
      if (!elementData.isFill) {
        return operationError(`Input [${elementIndex}]`, "not_input", `Element [${elementIndex}] is not an input element. Use browser_click instead.`)
      }
      return tab.domService.withClient(async () => {
        const before = await tab.domService.getElementState(elementData.node)
        if (!before.connected || before.disabled || before.readOnly) return operationError(`Input [${elementIndex}]`, "element_unavailable", "Element is detached, disabled or read-only; input was not performed.")
        if (isValueSettableElement(elementData.node)) {
          await tab.domService.setInputValue(elementData.node, text)
        } else {
          const isHit = await tab.domService.hitTestAtPoint(elementData.node)
          if (!isHit) {
            return operationError(`Input [${elementIndex}]`, "element_occluded", `Element [${elementIndex}] is occluded. Try closing overlays or scrolling.`)
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
        const expectedValue = clear || isValueSettableElement(elementData.node) ? text : before.value + text
        const afterInput = await tab.domService.getElementState(elementData.node)
        const inputValueVerified = afterInput.connected && afterInput.value === expectedValue
        if (!inputValueVerified) {
          const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
          return { status: "error", title: `Input [${elementIndex}]`, output: `Input value did not match the requested value; Enter was not pressed.${dom.output}`, observation: dom.observation, metadata: { errorCode: "input_value_mismatch", task: "not_evaluated" } }
        }
        if (pressEnter) await tab.domService.pressEnter()
        await waitForBrowserDelay(300, context.signal)
        const verification = await verifyPostconditions(tab.page, args, context.signal)
        const outcome = verification.requested && !verification.verified ? "error" : "success"
        const note = verification.requested ? (verification.verified ? " Postcondition verified." : " Postcondition failed.") : " Action dispatched; outcome not verified. Check the returned page before claiming success."
        const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
        const label = elementData.renderedLine?.trim() ?? `element <${elementIndex}>`
        return {
          title: `Input "${text}" into [${elementIndex}]`,
          status: outcome,
          output: `Input "${text}" into ${label}${pressEnter ? " and pressed Enter" : ""}${note}${dom.output}`,
          observation: dom.observation,
          metadata: { verification, inputValueVerified, task: "not_evaluated" },
        }
      })
    }, context.signal)
  },
}
