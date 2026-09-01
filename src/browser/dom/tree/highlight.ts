/**
 * Candidate numbering and optional page overlays.
 *
 * Candidate nodes receive stable backendNodeId-based indexes and populate the
 * selector map. When highlighting is enabled, the module writes data-hl-idx to
 * real elements and injects one overlay script per relevant frame or OOPIF
 * session. Per-node or per-frame injection failures do not invalidate indexes
 * successfully assigned elsewhere.
 */

import type { EnhancedDOMTreeNode } from "../types/dom-node"
import type { CDPClient } from "../../cdp/client"
import type { OOPIFManager } from "../../cdp/oopif-manager"
import { nodeKey } from "../utils/index"

export type DOMSelectorMap = Map<number, EnhancedDOMTreeNode>

/**
 * Creates a CDP command sender to bind the current node session.
 * You can send a sub-session to a cross-process iframe when oopifSessionId and OOPIFManager is available; otherwise, to the main session.
 */
function createSendCommand(
  node: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): <T>(method: string, params?: Record<string, unknown>) => Promise<T> {
  if (node.oopifSessionId && oopifManager) {
    const sessionId = node.oopifSessionId
    return <T>(method: string, params?: Record<string, unknown>) =>
      oopifManager.sendCommand<T>(sessionId, method, params)
  }
  return <T>(method: string, params?: Record<string, unknown>) => cdpClient.sendCommand<T>(method, params)
}

const HIGHLIGHT_ATTR = "data-hl-idx"
const HIGHLIGHT_CONTAINER_ID = "__elements_highlight_container__"

/**
 * Assign highlight indexes first, then optionally draw visible highlight boxes on the page.
 * Returns selectorMap for subsequent interactive tools to search for nodes by model numbering.
 *
 * @paramroot - Cropped tree to process; function changes renderInfo.highlightIndex of node
 * @paramcdpClient - Client CDP with browser main session End
 * @paramoopifManager - Select Manager to manage cross-process iframe sub-sessions
 * @paramlookup - An optional original tree index; when available, highlightIndex will be returned to the original tree node
 * @param options.highlight - Whether to inject visible highlight covers into the page; only visible transmission false is closed, default access
 */
export async function assignAndHighlight(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
  lookup?: Map<string, EnhancedDOMTreeNode>,
  options?: { highlight?: boolean },
): Promise<DOMSelectorMap> {
  // Step 1 always executes the numbering: closing the visual high does not affect the numbering in the model text or the interactive query table.
  const selectorMap = assignHighlightIndices(root, lookup)
  if (options?.highlight !== false) {
    // The 2 step is optional to project the numbering on the real page and to wait for the full end of the current round of cleanup, marking and scripting.
    await highlightElements(selectorMap, cdpClient, oopifManager)
  }
  // The 3 step returns the same map, which the caller will cache with the current DOM snapshot.
  return selectorMap
}

/**
 * Allocation of highlightIndex to candidate nodes for filtering conditions, using backendNodeId directly.
 * Within the life cycle of the same CDP session, backendNodeId is more stable than the ad hoc generation of serial numbers, so model reading
 * Where there is an incremental difference, the numbering previously seen in the full DOM may continue to be used.
 */
function assignHighlightIndices(
  root: EnhancedDOMTreeNode,
  originalLookup?: Map<string, EnhancedDOMTreeNode>,
): DOMSelectorMap {
  const selectorMap: DOMSelectorMap = new Map()

  // The cropping phase has spread over the boundary Shadow DOM/iframe so that only childrenNodes is needed here for the Depth of father and son.
  const visit = (node: EnhancedDOMTreeNode): void => {
    // The four sets of conditions are subject in order: they must be candidates, exclude select containers, handle repeated listening exceptions, and exclude general offscreen candidates.
    if (
      node.renderInfo?.isCandidate &&
      !node.renderInfo.isSelect &&
      (!node.renderInfo?.isDuplicateListener || node.renderInfo.isSelectOption || node.renderInfo.isFill) &&
      (!node.renderInfo.expandedViewportPosition || node.renderInfo.diffStatus === "removed")
    ) {
      // Currently achieves the use of backendNodeId keys that also serve as page labels, model numbers and selectorMap and do not create consecutive serial numbers.
      const id = node.backendNodeId
      node.renderInfo.highlightIndex = id
      selectorMap.set(id, node)

      // root is a pruned copy; the original node is recovered using a composite nodeKey across frame to enable the cache, debug output and subsequent consumers to see the same number.
      const originalNode = originalLookup?.get(nodeKey(node))
      if (originalNode?.renderInfo) {
        originalNode.renderInfo.highlightIndex = id
      }
    }

    // Continue to visit descendants regardless of the current node ' s own number and avoid missing candidate elements below the container node.
    for (const child of node.childrenNodes ?? []) {
      visit(child)
    }
  }

  // Synchronizes from root to root; the tree, the selected original tree and the map are all written when the function returns.
  visit(root)
  return selectorMap
}

/**
 * Write data-hl-idx on each candidate element and inject the dynamic highlight script into every frame that contains candidates.
 */
async function highlightElements(
  selectorMap: DOMSelectorMap,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  // With no candidates, avoid page injection; this path does not proactively remove an existing overlay.
  if (selectorMap.size === 0) return

  try {
    await cdpClient.sendCommand("DOM.enable")
  } catch {
    // DOM may already be enabled; continue and let per-node resolution handle unavailable targets.
  }

  // Clears the previous wave of highlight before remarking to ensure that old attributes, overlays and event listeners are not superimposed.
  await cleanupHighlights(cdpClient, oopifManager)

  // Collects frameId for the main session; undefined for the main document itself.
  const frameIds = new Set<string | undefined>()
  // The frame execution context, which does not belong to the main session, is recollected separately by sessionId.
  const oopifSessionIds = new Set<string>()

  // Parse the true nodes individually in selectorMap and write them to data-hl-idx by CDP.
  for (const [index, node] of selectorMap) {
    try {
      // Subsequent resolveNode and callFunctionOn must be taken to the same address, otherwise the backendNodeId of OOPIF cannot be correctly deciphered.
      const sendCmd = createSendCommand(node, cdpClient, oopifManager)

      const result = await sendCmd<{
        object: { objectId?: string }
      }>("DOM.resolveNode", { backendNodeId: node.backendNodeId })

      const objectId = result?.object?.objectId
      // No objectId indicates that node is invalid, insoluble or non-operational Runtime objects; skipping this element but continuing to process other nodes.
      if (!objectId) continue

      // callFunctionOn with this element this sets the properties in the context of the element itself frame without having to cross document.
      await sendCmd("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() { this.setAttribute('${HIGHLIGHT_ATTR}', '${index}'); }`,
        awaitPromise: false,
      })

      if (node.oopifSessionId) {
        oopifSessionIds.add(node.oopifSessionId)
      } else {
        // (a) frameId for the element IFRAME/FRAME points to its carrying sub frame and the element itself is actually located in the parent frame ;
        // Therefore, when highlighting the host element, parentNode.frameId should be recorded as a script injection target.
        const tag = node.nodeName?.toUpperCase()
        if (tag === "IFRAME" || tag === "FRAME") {
          frameIds.add(node.parentNode?.frameId)
        } else {
          frameIds.add(node.frameId)
        }
      }
    } catch {
      // Dynamic page elements may have been deleted or sessions may have been switched; the remaining candidates are not blocked by the cell block failure.
    }
  }

  // All element tags are completed and generate only one script text, which is repeated for each context.
  const script = generateDynamicHighlightScript()

  // The main frame and the co-source frame remain away from the main CDP session, but the son frame needs to create its own world of isolation.
  for (const frameId of frameIds) {
    try {
      if (!frameId) {
        // When contextId is not specified, Runtime.evaluate is executed by default in the main document.
        await cdpClient.sendCommand("Runtime.evaluate", {
          expression: script,
          awaitPromise: false,
        })
      } else {
        // Use an isolated world so highlight globals cannot conflict with page scripts while retaining document access.
        const contextResult = await cdpClient.sendCommand<{
          executionContextId: number
        }>("Page.createIsolatedWorld", {
          frameId,
          worldName: "__highlight__",
          grantUniveralAccess: true,
        })
        if (contextResult?.executionContextId) {
          await cdpClient.sendCommand("Runtime.evaluate", {
            expression: script,
            contextId: contextResult.executionContextId,
            awaitPromise: false,
          })
        }
      }
    } catch (error) {
      // frame may be navigated or removed after marking; silently ignores the injection of frame.
    }
  }

  // OOPIF must be executed directly in its sub-session; first, the sessionId that may expire as a result of re-adding.
  if (oopifManager) {
    for (const rawSessionId of oopifSessionIds) {
      const sessionId = oopifManager.resolveSessionId(rawSessionId)
      try {
        await oopifManager.sendCommand(sessionId, "Runtime.evaluate", {
          expression: script,
          awaitPromise: false,
        })
      } catch (error) {
        // OOPIF may be navigating, reconstructing or being removed in processing; silently ignores the injection failure of the session.
      }
    }
  }
}

/**
 * Runs the cleanup logic in the main document, all co-sources frame and all known OOPIF to remove old listeners, properties and overlay containers.
 */
export async function cleanupHighlights(cdpClient: CDPClient, oopifManager?: OOPIFManager): Promise<void> {
  // This script will be executed separately in each document: the cleanup function saved in the previous round is first called and then the clearance tag properties are returned.
  const cleanupScript = `
(function() {
  if (window._highlightCleanupFunctions) {
    window._highlightCleanupFunctions.forEach(function(fn) { fn(); });
    window._highlightCleanupFunctions = [];
  }
  var c = document.getElementById('${HIGHLIGHT_CONTAINER_ID}');
  if (c) { try { if (typeof c.hidePopover === 'function') c.hidePopover(); } catch(e) {} c.remove(); }
  function removeAttrDeep(root) {
    root.querySelectorAll('[${HIGHLIGHT_ATTR}]').forEach(function(el) {
      el.removeAttribute('${HIGHLIGHT_ATTR}');
    });
    root.querySelectorAll('*').forEach(function(el) {
      if (el.shadowRoot) removeAttrDeep(el.shadowRoot);
    });
  }
  removeAttrDeep(document);
})();
`
  try {
    // Step 1: Clean up the main document.
    await cdpClient.sendCommand("Runtime.evaluate", {
      expression: cleanupScript,
      awaitPromise: false,
    })
    // Step 2 : Read the main session frame tree, collect all the congener frame and clean it up in isolation.
    const frameTree = await cdpClient.sendCommand<{
      frameTree: {
        frame: { id: string }
        childFrames?: Array<{ frame: { id: string } }>
      }
    }>("Page.getFrameTree")
    const subFrames = collectFrameIds(frameTree?.frameTree)
    for (const frameId of subFrames) {
      try {
        const ctx = await cdpClient.sendCommand<{
          executionContextId: number
        }>("Page.createIsolatedWorld", {
          frameId,
          worldName: "__highlight_cleanup__",
          grantUniveralAccess: true,
        })
        if (ctx?.executionContextId) {
          await cdpClient.sendCommand("Runtime.evaluate", {
            expression: cleanupScript,
            contextId: ctx.executionContextId,
            awaitPromise: false,
          })
        }
      } catch {
        // frame may have been removed after getFrameTree; the remaining frame continues to be cleared.
      }
    }
  } catch {
    // The main document or frame tree cleanup failed without blocking the remarking of the current wheel; the subsequent OOPIF cleanup will continue.
  }

  // Step 3: OOPIF In the context of the execution of the main tree frame , the currently saved sub-sessions of the manager must be cleaned separately.
  if (oopifManager) {
    for (const session of oopifManager.getSessions()) {
      try {
        await oopifManager.sendCommand(session.sessionId, "Runtime.evaluate", {
          expression: cleanupScript,
          awaitPromise: false,
        })
      } catch {
        // OOPIF may have been removed or re-added; single session failure does not affect other sessions.
      }
    }
  }
}

/**
 * Priority is given to collecting all sub-items frameId from Page.getFrameTree in depth; root frameId does not add the result.
 */
function collectFrameIds(
  frameTree:
    | {
        frame: { id: string }
        childFrames?: Array<{
          frame: { id: string }
          childFrames?: Array<any>
        }>
      }
    | undefined,
): string[] {
  // When no childFrames arrives at the returning leaf, return empty arrays for upper-level extension.
  if (!frameTree?.childFrames) return []
  const ids: string[] = []
  for (const child of frameTree.childFrames) {
    // Add each direct child before recursively adding its descendants, preserving parent-first order.
    ids.push(child.frame.id)
    ids.push(...collectFrameIds(child))
  }
  return ids
}

/**
 * Generates a self-included script that will be executed on the page frame; here only the string is spelled and the actual execution takes place in highlightElements().
 */
function generateDynamicHighlightScript(): string {
  // Colours are recycled by highlightIndex; when numbering is stable, the same colour is usually maintained for cross-scanning of the same element.
  const colors = [
    "#FF0000",
    "#00FF00",
    "#0000FF",
    "#FFA500",
    "#800080",
    "#008080",
    "#FF69B4",
    "#4B0082",
    "#FF4500",
    "#2E8B57",
    "#DC143C",
    "#4682B4",
  ]

  return `
(function() {
  var CONTAINER_ID = '${HIGHLIGHT_CONTAINER_ID}';
  var ATTR = '${HIGHLIGHT_ATTR}';
  var colors = ${JSON.stringify(colors)};

  // Recursively search for tagged elements and penetrates the accessible border Shadow DOM.
  function findMarkedElements(root) {
    var result = [];
    var els = root.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < els.length; i++) result.push(els[i]);
    // Normal querySelectorAll will not enter Shadow Root, so all elements will be listed and returned to shadowRoot, which is open.
    var allEls = root.querySelectorAll('*');
    for (var j = 0; j < allEls.length; j++) {
      if (allEls[j].shadowRoot) {
        var shadowResults = findMarkedElements(allEls[j].shadowRoot);
        for (var k = 0; k < shadowResults.length; k++) result.push(shadowResults[k]);
      }
    }
    return result;
  }
  var elements = findMarkedElements(document);
  // The current frame without successfully marked elements does not create an empty container or register an event listener.
  if (elements.length === 0) return;

  // Use fixed full-view transparent containers to carry all frames and labels and to prohibit receiving pointer events and avoid blocking page interaction.
  var container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.style.position = 'fixed';
  container.style.pointerEvents = 'none';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.zIndex = '2147483647';
  container.style.backgroundColor = 'transparent';
  // The browser supports Popover API by placing the container in top layer so that it can be displayed on dialog/popover.
  if (typeof container.showPopover === 'function') {
    container.setAttribute('popover', 'manual');
    document.body.appendChild(container);
    try { container.showPopover(); } catch(e) { /* Return normal document stacking process when failure */ }
  } else {
    document.body.appendChild(container);
  }

  var cleanupFunctions = [];

  elements.forEach(function(element) {
    // Numbering determines the colour slot; add 1A to the base colour to generate a low transparency background colour.
    var index = parseInt(element.getAttribute(ATTR), 10);
    var colorIndex = index % colors.length;
    var baseColor = colors[colorIndex];
    var backgroundColor = baseColor + '1A';

    var overlays = [];
    var label = null;
    var labelWidth = 20;
    var labelHeight = 16;

    function updatePositions() {
      // An element may have multiple rectangles, such as inline elements that cross multiple lines; each valid rectangular corresponds to one overlay.
      var rects = element.getClientRects();

      for (var i = 0; i < rects.length; i++) {
        var rect = rects[i];
        // Zero width or zero height rectangles have no visible area; old frames are hidden to handle rect volume or size changes after layout changes.
        if (rect.width === 0 || rect.height === 0) {
          if (overlays[i]) overlays[i].style.display = 'none';
          continue;
        }

        var overlay = overlays[i];
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.style.position = 'fixed';
          overlay.style.border = '2px solid ' + baseColor;
          overlay.style.backgroundColor = backgroundColor;
          overlay.style.pointerEvents = 'none';
          overlay.style.boxSizing = 'border-box';
          container.appendChild(overlay);
          overlays[i] = overlay;
        }

        overlay.style.top = rect.top + 'px';
        overlay.style.left = rect.left + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.display = 'block';
      }

      // When a new round of rect quantities becomes smaller, the old box is hidden to avoid remaining after scscrolling or changing lines.
      for (var j = rects.length; j < overlays.length; j++) {
        overlays[j].style.display = 'none';
      }

      if (rects.length > 0) {
        // An element only creates a numbering label and uses the first rectangular as a positioning benchmark.
        var firstRect = rects[0];

        if (!label) {
          label = document.createElement('div');
          label.style.position = 'fixed';
          label.style.background = baseColor;
          label.style.color = 'white';
          label.style.padding = '1px 4px';
          label.style.borderRadius = '4px';
          label.style.fontSize = Math.min(12, Math.max(8, firstRect.height / 2)) + 'px';
          label.style.pointerEvents = 'none';
          label.textContent = index;
          container.appendChild(label);

          if (label.offsetWidth > 0) labelWidth = label.offsetWidth;
          if (label.offsetHeight > 0) labelHeight = label.offsetHeight;
        }

        // Default to the top right corner of the first rectangle.
        var labelTop = firstRect.top + 2;
        var labelLeft = firstRect.left + firstRect.width - labelWidth - 2;

        // Element frames are moved to the top when the label does not exist, and the left edge is prevented from crossing.
        if (firstRect.width < labelWidth + 4 || firstRect.height < labelHeight + 4) {
          labelTop = firstRect.top - labelHeight - 2;
          labelLeft = firstRect.left + firstRect.width - labelWidth;
          if (labelLeft < 0) labelLeft = firstRect.left;
        }

        // The coordinates are eventually attached to viewport to ensure that the label does not run out of the visual area.
        labelTop = Math.max(0, Math.min(labelTop, window.innerHeight - labelHeight));
        labelLeft = Math.max(0, Math.min(labelLeft, window.innerWidth - labelWidth));

        label.style.top = labelTop + 'px';
        label.style.left = labelLeft + 'px';
        label.style.display = 'block';
      } else if (label) {
        label.style.display = 'none';
      }
    }

    updatePositions();

    // The HF scroll/resize event is subject to light currents at a minimum update interval of 16ms .
    var lastCall = 0;
    var throttledUpdate = function() {
      var now = performance.now();
      if (now - lastCall < 16) return;
      lastCall = now;
      updatePositions();
    };

    window.addEventListener('scroll', throttledUpdate, true);
    window.addEventListener('resize', throttledUpdate);

    // Saves the reverse action corresponding to this element; the next round cleanupHighlights() will be called in a uniform manner to prevent leakage of the listening.
    cleanupFunctions.push(function() {
      window.removeEventListener('scroll', throttledUpdate, true);
      window.removeEventListener('resize', throttledUpdate);
      overlays.forEach(function(o) { o.remove(); });
      if (label) label.remove();
    });
  });

  // Hangs window on the current frame so that the cleanup script of the next round of injection can find all the cleanup functions.
  window._highlightCleanupFunctions = cleanupFunctions;
})();
`
}
