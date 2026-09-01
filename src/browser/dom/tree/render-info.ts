/**
 * Render-metadata computation for enhanced DOM trees.
 *
 * The pipeline initializes visibility, interactivity, fillability, and scroll
 * ownership; performs frame-aware elementFromPoint checks; marks candidates and
 * overlays; collects click-listener signatures; and demotes duplicate listener
 * descendants. It mutates each node's renderInfo and does not allocate the
 * model-facing element index.
 */

import { type EnhancedDOMTreeNode, NodeType } from '../types/dom-node';
import { ClickableElementDetector } from './clickable-detector';
import { checkElementVisibility, type ParentFrameState } from './visibility';
import type { CDPClient } from '../../cdp/client';
import type { OOPIFManager } from '../../cdp/oopif-manager';

/** Optional parameter for computeRenderInfo() */
export interface ComputeRenderInfoOptions {
  /**
   * An extension of the visible range in “pages”; 1 indicates an extension of one view height up and down, and of one view width up and down.
   * is used to identify elements close to the current view that have not yet been shown.
   */
  expand?: number;
}

/**
 * Calculates the rendering information of the whole tree DOM in five fixed phases, all results written in situ at renderInfo at node.
 */
export async function computeRenderInfo(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  options?: ComputeRenderInfoOptions,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const expand = options?.expand;

  // Step 1 : Initialize all nodes and calculate expandedViewportPosition through a visible check.
  initRenderInfo(root, undefined, [], expand);

  // Step 2 : Determines whether the visible nodes are at the interactive caller through the result of the central node of the browser.
  await checkTopElements(root, cdpClient, oopifManager);

  // Step 3 : Combining interactive, top-cut, extended view and hidden original control rule tags for candidate nodes.
  markInteractiveCandidates(root);

  // Step 4 : Also send the original and frame click of the candidate.
  await fetchClickListenerSignatures(root, cdpClient, oopifManager);

  // Step 5 : Compare the target targets and the listener signatures of the ancestors and descendants and mark the repeat listening nodes.
  deduplicateByListeners(root);
}

const SCROLLABLE_OVERFLOW_VALUES = new Set([
  'auto',
  'scroll',
  'overlay',
  'hidden',
]);
const OVERLAY_COVERAGE_THRESHOLD = 0.75;
const HIGHLIGHT_CONTAINER_ID = '__elements_highlight_container__';
const COMMON_CONTAINER_TAGS = new Set([
  'div',
  'main',
  'section',
  'article',
  'aside',
  'nav',
  'body',
  'html',
]);

interface ViewportSize {
  width: number;
  height: number;
}

/**
 * Walking through plain subtrees, Shadow DOM and iframe documents, using the largest area of HTML node clientRects as the main viewer.
 * Choosing the largest viewport rather than the first HTML node avoids treating a smaller iframe document as the top-level viewport.
 */
function getMainViewportSize(root: EnhancedDOMTreeNode): ViewportSize | null {
  let bestArea = 0;
  let viewport: ViewportSize | null = null;

  const visit = (node: EnhancedDOMTreeNode): void => {
    if (node.nodeName === 'HTML') {
      const clientRects = node.snapshotNode?.clientRects;
      if (clientRects && clientRects.width > 0 && clientRects.height > 0) {
        const area = clientRects.width * clientRects.height;
        if (area > bestArea) {
          bestArea = area;
          viewport = {
            width: clientRects.width,
            height: clientRects.height,
          };
        }
      }
    }

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      visit(shadowRoot);
    }
    if (node.contentDocument) {
      visit(node.contentDocument);
    }
  };

  visit(root);
  return viewport;
}

function getViewportCoverageRatio(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: ViewportSize,
): number {
  // The elements rectangular shall be reduced to [0, viewport.width] x [0, viewport.height] and the intersection shall be divided by the area of view.
  const overlapLeft = Math.max(0, bounds.x);
  const overlapTop = Math.max(0, bounds.y);
  const overlapRight = Math.min(viewport.width, bounds.x + bounds.width);
  const overlapBottom = Math.min(viewport.height, bounds.y + bounds.height);
  const overlapWidth = Math.max(0, overlapRight - overlapLeft);
  const overlapHeight = Math.max(0, overlapBottom - overlapTop);
  const overlapArea = overlapWidth * overlapHeight;
  const viewportArea = viewport.width * viewport.height;

  return viewportArea > 0 ? overlapArea / viewportArea : 0;
}

/**
 * Special reservation only for originals select, checkbox, radio who are frequently replaced by the assembly library: when opacity0 or any dimension 0
 * returns true at this time. visibility.ts allows such controls to continue to participate in semantics and candidate judgement, rather than to hide directly by normal zero-sized elements.
 */
function isVisuallyHiddenNativeControl(node: EnhancedDOMTreeNode): boolean {
  if (node.nodeType !== NodeType.ELEMENT_NODE) {
    return false;
  }

  const tag = node.nodeName.toLowerCase();

  // The UI assembly library often sets the original select to opacity:0 or zero dimensions, and then draws a custom drop box at Shadow DOM in the upstream caller.
  const isHiddenSelect = tag === 'select';

  const isHiddenCheckboxRadio =
    tag === 'input' &&
    ['checkbox', 'radio'].includes(
      (node.attributes?.type ?? 'text').toLowerCase(),
    );

  if (!isHiddenSelect && !isHiddenCheckboxRadio) {
    return false;
  }

  const bounds = node.snapshotNode?.bounds;
  const opacityRaw = node.snapshotNode?.computedStyles?.opacity ?? '1';
  const opacity = Number.parseFloat(opacityRaw);
  const isOpacityHidden = Number.isFinite(opacity) && opacity <= 0;
  const isZeroSize = !!bounds && (bounds.width <= 0 || bounds.height <= 0);

  return isOpacityHidden || isZeroSize;
}

/**
 * Determines whether the node is an independent scrolling container.
 *
 * Order of calculation: Compare scrollRects with clientRects first; content width or height must be at least 1px, 1px is floater Enter
 * Portability. Check then whether overflow in the corresponding direction allows scscrolling. When styles are missing, only the common container labels are used in a conservative loop.
 */
function checkIsScrollable(
  node: EnhancedDOMTreeNode,
  htmlFrames: EnhancedDOMTreeNode[],
): boolean {
  // Scscrolling on top HTML/BODY belongs to the main page (container 0), without a scrolling container; HTML/BODY in iframe allows independent scscrolling.
  const tag = node.nodeName.toLowerCase();
  const isInIframe = htmlFrames.some(
    f => f.nodeName === 'IFRAME' || f.nodeName === 'FRAME',
  );
  if ((tag === 'html' || tag === 'body') && !isInIframe) return false;

  const snapshot = node.snapshotNode;
  if (!snapshot?.scrollRects || !snapshot?.clientRects) return false;

  const hasVerticalScroll =
    snapshot.scrollRects.height > snapshot.clientRects.height + 1;
  const hasHorizontalScroll =
    snapshot.scrollRects.width > snapshot.clientRects.width + 1;

  if (!hasVerticalScroll && !hasHorizontalScroll) return false;

  const styles = snapshot.computedStyles;
  if (!styles) {
    return COMMON_CONTAINER_TAGS.has(node.nodeName.toLowerCase());
  }

  const overflowY = styles['overflow-y'] ?? styles['overflow'] ?? 'visible';
  const overflowX = styles['overflow-x'] ?? styles['overflow'] ?? 'visible';

  const result =
    (hasVerticalScroll && SCROLLABLE_OVERFLOW_VALUES.has(overflowY)) ||
    (hasHorizontalScroll && SCROLLABLE_OVERFLOW_VALUES.has(overflowX));

  return result;
}

/**
 * Finds the first scrollable node in Shadow DOM and transfers it backendNodeId to the subnode Light DOM projected via slot.
 */
function findShadowScrollContainer(
  shadowRoots: EnhancedDOMTreeNode[],
): number | undefined {
  for (const shadowRoot of shadowRoots) {
    const result = findFirstScrollable(shadowRoot);
    if (result !== undefined) return result;
  }
  return undefined;
}

function findFirstScrollable(node: EnhancedDOMTreeNode): number | undefined {
  if (node.renderInfo?.isScrollable) {
    return node.backendNodeId;
  }
  for (const child of node.childrenNodes ?? []) {
    const result = findFirstScrollable(child);
    if (result !== undefined) return result;
  }
  return undefined;
}

/**
 * Phase 1 initializes renderInfo across the tree and calculates isVisible and expandedViewportPosition from frame-aware visibility.
 *
 * Order of execution of single nodes:
 * Identification of Shadow host and iframe host.
 * 2. ClickableElementDetector judge interactive/fill capacity based on labels, properties, ARIA, cursor and Snapshot.
 * 3. Identify primary controls that are visually hidden by the assembly library and calculate whether the current node forms a new scrolling container.
 * 4. checkElementVisibility() Combine CSS, size, recent scscrolling view, frame fatherhood and expand range to calculate visibility.
 * 5. Write the results into renderInfo; the new scrolling container ID is passed to descendants, while the current node records the parent scrolling container ID.
 * 6. Recursed Shadow DOM to locate the scrolling container, then returned to the normal sub-node that may be projected by slot, and finally returned
 * iframe contentDocument, passing the iframe's visible, directional, or hidden state into the subdocument.
 */
function initRenderInfo(
  node: EnhancedDOMTreeNode,
  parentScrollableId?: number,
  htmlFrames: EnhancedDOMTreeNode[] = [],
  expand?: number,
  parentFrameState: ParentFrameState = 'visible',
): void {
  // First recognizes whether the current node carries a sub-document Shadow DOM or iframe.
  const shadowRoots = node.shadowRoots ?? [];
  const isShadowHost = shadowRoots.length > 0;
  const isIframeHost = node.contentDocument !== undefined;

  // Interactivity and refillability are independently judged before visibility; the subsequent candidacy is combined with the top-life median.
  const isInteractive = ClickableElementDetector.isInteractive(node);
  const isFill = ClickableElementDetector.isFillable(node);
  node.renderInfo.isVisuallyHiddenNativeControl =
    isVisuallyHiddenNativeControl(node);

  const isScrollable = checkIsScrollable(node, htmlFrames);
  const scrollableId = isScrollable ? node.backendNodeId : parentScrollableId;

  // Calculates frame/scrolling container perception of visibility in the same absolute system and the direction of extended view.
  const visResult = checkElementVisibility(
    node,
    htmlFrames,
    expand,
    parentFrameState,
  );

  // Update the current node in situ; isTopElement will be recalculated at 2, so reset here to false.
  node.renderInfo.isVisible = visResult.isVisible;
  node.renderInfo.isInteractive = isInteractive;
  node.renderInfo.isTopElement = false;
  node.renderInfo.expandedViewportPosition = visResult.expandedViewportPosition;
  node.renderInfo.isScrollable = isScrollable;
  node.renderInfo.scrollableContainerId = parentScrollableId;
  node.renderInfo.isSelectOption = false;
  node.renderInfo.isShadowHost = isShadowHost;
  node.renderInfo.isIframeHost = isIframeHost;
  node.renderInfo.isFill = isFill;

  // The iframe/frame element and the HTML root with frameId are recorded for descendants for subsequent local viewing.
  const updatedFrames = [...htmlFrames];
  if (
    node.nodeType === NodeType.ELEMENT_NODE &&
    (node.nodeName.toUpperCase() === 'IFRAME' ||
      node.nodeName.toUpperCase() === 'FRAME')
  ) {
    updatedFrames.push(node);
  }
  if (
    node.nodeType === NodeType.ELEMENT_NODE &&
    node.nodeName === 'HTML' &&
    node.frameId
  ) {
    updatedFrames.push(node);
  }

  // Recursive order starts with Shadow Root in order to first find the scrolling container.
  // Handle first Shadow Root and find its internal scrolling container so that the child node Light DOM projected by slot succeeds correctly ID.
  // For example, ion-content may place Light DOM into a Shadow DOM `<main><slot /></main>`.
  for (const shadowRoot of shadowRoots) {
    initRenderInfo(
      shadowRoot,
      scrollableId,
      updatedFrames,
      expand,
      parentFrameState,
    );
  }

  // After returning from a shadow root, expose its nearest scroll container to subsequent regular children.
  let childScrollableId = scrollableId;
  if (isShadowHost) {
    const shadowScrollId = findShadowScrollContainer(shadowRoots);
    if (shadowScrollId !== undefined) {
      childScrollableId = shadowScrollId;
    }
  }

  // Reprocess Light DOM subnodes; they may be physically displayed in a scrolling container Shadow DOM by slot.
  const children = node.childrenNodes ?? [];
  for (const child of children) {
    initRenderInfo(
      child,
      childScrollableId,
      updatedFrames,
      expand,
      parentFrameState,
    );
  }

  // Final processing of iframe sub-document: Calculating the host's own state and spreading it to contentDocument.
  if (node.contentDocument) {
    let iframeState: ParentFrameState = parentFrameState;
    if (parentFrameState === 'visible') {
      // The parent frame continues to calculate the sub-document status based on the host 's position on the parent page when it is visible.
      const iframeVis = checkElementVisibility(node, htmlFrames, expand);
      if (iframeVis.isVisible) {
        iframeState = 'visible';
      } else if (iframeVis.expandedViewportPosition) {
        iframeState = iframeVis.expandedViewportPosition;
      } else {
        iframeState = 'hidden';
      }
    }
    // When the parent frame is already in an extended direction or is completely hidden, the sub-document is directly inherited and is no longer subject to local error to the top.
    initRenderInfo(
      node.contentDocument,
      scrollableId,
      updatedFrames,
      expand,
      iframeState,
    );
  }
}

/**
 * Up to CDP trace through CDP at most when the centre node is not in the enhanced tree (e.g. unrecorded Shadow DOM internal node or pseudo elements)
 * maxDepth Layer. If the target itself or the target is associated with the frame ancestors on the way, indicate that the hit node is still relevant to the target; CDP query failed,
 * At root node or beyond depth is treated as irrelevant.
 */
async function checkHitNodeParentChain(
  sendCmd: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  hitBackendNodeId: number,
  targetBackendNodeId: number,
  targetAncestors: Set<number>,
  nodeByBackendId: Map<number, EnhancedDOMTreeNode>,
  maxDepth = 20,
): Promise<boolean> {
  let currentBackendNodeId = hitBackendNodeId;

  for (let depth = 0; depth < maxDepth; depth++) {
    try {
      const nodeInfo = await sendCmd<{
        node: { nodeId: number; backendNodeId: number; parentId?: number };
      }>('DOM.describeNode', {
        backendNodeId: currentBackendNodeId,
        depth: 0,
      });

      const parentNodeId = nodeInfo.node.parentId;
      if (!parentNodeId) return false;

      const parentInfo = await sendCmd<{
        node: { backendNodeId: number };
      }>('DOM.describeNode', { nodeId: parentNodeId, depth: 0 });

      const parentBackendNodeId = parentInfo.node.backendNodeId;

      if (parentBackendNodeId === targetBackendNodeId) return true;
      if (targetAncestors.has(parentBackendNodeId)) return true;

      const parentNode = nodeByBackendId.get(parentBackendNodeId);
      if (parentNode) {
        let current = parentNode.parentNode;
        while (current) {
          if (current.backendNodeId === targetBackendNodeId) return true;
          current = current.parentNode;
        }
        return false;
      }

      currentBackendNodeId = parentBackendNodeId;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Run document.elementFromPoint(x, y) in the target CDP session and convert the returned remote object to
 * nodeId and steady backendNodeId. Remote objects are released as far as possible after conversion; returns undefined when the page fails to hit the element.
 */
export async function elementFromPoint(
  sendCmd: <T>(method: string, params?: Record<string, unknown>) => Promise<T>,
  centerX: number,
  centerY: number,
): Promise<number | undefined> {
  const evalResult = await sendCmd<{
    result: { objectId?: string; subtype?: string };
  }>('Runtime.evaluate', {
    expression: `document.elementFromPoint(${centerX}, ${centerY})`,
    returnByValue: false,
  });

  if (!evalResult.result.objectId || evalResult.result.subtype === 'null') {
    return undefined;
  }

  const domNode = await sendCmd<{ nodeId: number }>('DOM.requestNode', {
    objectId: evalResult.result.objectId,
  });

  await sendCmd('Runtime.releaseObject', {
    objectId: evalResult.result.objectId,
  }).catch(() => {});

  const describeResult = await sendCmd<{
    node: { backendNodeId: number };
  }>('DOM.describeNode', { nodeId: domNode.nodeId, depth: 0 });

  return describeResult.node.backendNodeId;
}

/**
 * Phase 2: use a central point hit test to determine whether visible nodes are shielded by unrelated elements.
 *
 * Order of calculation:
 * Traverse regular children, Shadow Roots, and iframe subdocuments, collect only isVisible=true nodes, and create a
 * backendNodeId - Queries for nodes.
 * 2. Collect ancestor IDs that belong to the same OOPIF session; stop at session boundaries to avoid mixing CDP contexts.
 * 3. The normal node uses the coordinates of the centre of the top viewport absolutePosition and the local coordinates of Snapshot bounds for the OOPIF node,
 * and send the command to the corresponding OOPIF session.
 * 4. Mark isTopElement when elementFromPoint hits the target itself, an ancestor, or a descendant.
 * checkHitNodeParentChain performs the relationship check. Missing coordinates, misses, and CDP errors produce false.
 */
async function checkTopElements(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const nodesToCheck: EnhancedDOMTreeNode[] = [];
  const nodeByBackendId = new Map<number, EnhancedDOMTreeNode>();

  const collectNodes = (node: EnhancedDOMTreeNode) => {
    if (node.renderInfo.isVisible) {
      nodesToCheck.push(node);
      nodeByBackendId.set(node.backendNodeId, node);
    }
    for (const child of node.childrenNodes ?? []) {
      collectNodes(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      collectNodes(shadowRoot);
    }
    if (node.contentDocument) {
      collectNodes(node.contentDocument);
    }
  };
  collectNodes(root);

  if (nodesToCheck.length === 0) return;

  // Builds a collection of ancestors in the same CDP session; stops at iframe/OOPIF session borders.
  const getAncestorBackendIds = (node: EnhancedDOMTreeNode): Set<number> => {
    const ancestors = new Set<number>();
    const sessionId = node.oopifSessionId;
    let current = node.parentNode;
    while (current) {
      if (current.oopifSessionId !== sessionId) break;
      ancestors.add(current.backendNodeId);
      current = current.parentNode;
    }
    return ancestors;
  };

  const checkPromises = nodesToCheck.map(async node => {
    // absolutePosition is the coordinates of the top-level viewport and has been superimposed iframe offset; if missing, back Snapshot bounds.
    const pos = node.absolutePosition ?? node.snapshotNode?.bounds;
    if (!pos) {
      node.renderInfo.isTopElement = false;
      return;
    }
    const centerX = Math.round(pos.x + pos.width / 2);
    const centerY = Math.round(pos.y + pos.height / 2);

    const ancestors = getAncestorBackendIds(node);

    // Select the main CDPClient or OOPIF according to the node attribution for session exclusive.
    const sendCmd =
      node.oopifSessionId && oopifManager
        ? <T>(method: string, params?: Record<string, unknown>) =>
            oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
        : <T>(method: string, params?: Record<string, unknown>) =>
            cdpClient.sendCommand<T>(method, params);

    try {
      // elementFromPoint() in OOPIF session only recognizes the local coordinates of the subpages and therefore cannot be called absolutePosition.
      let hitBackendNodeId: number | undefined;
      if (node.oopifSessionId && oopifManager) {
        const localBounds = node.snapshotNode?.bounds;
        if (!localBounds) {
          node.renderInfo.isTopElement = false;
          return;
        }
        const localX = Math.round(localBounds.x + localBounds.width / 2);
        const localY = Math.round(localBounds.y + localBounds.height / 2);
        hitBackendNodeId = await elementFromPoint(sendCmd, localX, localY);
      } else {
        hitBackendNodeId = await elementFromPoint(sendCmd, centerX, centerY);
      }

      if (hitBackendNodeId === undefined) {
        node.renderInfo.isTopElement = false;
        return;
      }

      node.renderInfo.hitBackendNodeId = hitBackendNodeId;

      if (hitBackendNodeId === node.backendNodeId) {
        node.renderInfo.isTopElement = true;
        return;
      }

      if (ancestors.has(hitBackendNodeId)) {
        node.renderInfo.isTopElement = true;
        return;
      }

      // Descendants of hit targets (e.g. span in buttons) also indicate that the focus of the target is not overshadowed by irrelevant elements.
      const hitNode = nodeByBackendId.get(hitBackendNodeId);
      if (hitNode) {
        const hitAncestors = getAncestorBackendIds(hitNode);
        if (hitAncestors.has(node.backendNodeId)) {
          node.renderInfo.isTopElement = true;
          return;
        }
      } else {
        // When the hit node is unenhanced (often within Shadow DOM), replace the CDP parent-recognition relationship.
        const isRelated = await checkHitNodeParentChain(
          sendCmd,
          hitBackendNodeId,
          node.backendNodeId,
          ancestors,
          nodeByBackendId,
        );
        if (isRelated) {
          node.renderInfo.isTopElement = true;
          return;
        }
      }

      node.renderInfo.isTopElement = false;
    } catch {
      node.renderInfo.isTopElement = false;
    }
  });

  await Promise.all(checkPromises);
}

/**
 * Stage 3: Mark candidate nodes for subsequent cropping, highlighting and serialization; elementIndex is not yet allocated.
 *
 * Order of calculation:
 * 1. Collect the currently visible element nodes and the extended visual nodes with expandedViewportPosition over and over again.
 * 2. The mask is only detected when there is an extended visual node: the candidate mask must be visible, fixed/absolute, allowed pointer-events,
 * Not HTML/BODY or the bright layer of this item, with at least 75 % coverage of the main view; the highest of paintOrder is isOverlay .
 * 3. If the extension node is drawn in less order than the mask, mark isBlockedByOverlay.
 * 4. An interactive node is a candidate if it meets any of the following conditions: the centre is at the top, within the extended view, or the semantic is still required
 * Visible but hidden original select/checkbox/radio control.
 * Candidates select will also be marked as descendants option/optgroup.
 */
function markInteractiveCandidates(root: EnhancedDOMTreeNode): void {
  const expandElements: EnhancedDOMTreeNode[] = [];
  const visibleElements: EnhancedDOMTreeNode[] = [];

  const markSelectDescendantsAsCandidates = (
    node: EnhancedDOMTreeNode,
  ): void => {
    const visit = (current: EnhancedDOMTreeNode): void => {
      if (current.nodeType === NodeType.ELEMENT_NODE) {
        const tagName = current.nodeName.toLowerCase();
        if (tagName === 'option' || tagName === 'optgroup') {
          current.renderInfo.isCandidate = true;
          current.renderInfo.isSelectOption = true;
        }
      }

      for (const child of current.childrenNodes ?? []) {
        visit(child);
      }
      for (const shadowRoot of current.shadowRoots ?? []) {
        visit(shadowRoot);
      }
      if (current.contentDocument) {
        visit(current.contentDocument);
      }
    };

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
  };

  const collectElements = (node: EnhancedDOMTreeNode): void => {
    if (node.renderInfo?.isVisible && node.nodeType === NodeType.ELEMENT_NODE) {
      visibleElements.push(node);
    }
    if (node.renderInfo?.expandedViewportPosition !== undefined) {
      expandElements.push(node);
    }

    for (const child of node.childrenNodes ?? []) {
      collectElements(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      collectElements(shadowRoot);
    }
    if (node.contentDocument) {
      collectElements(node.contentDocument);
    }
  };
  collectElements(root);

  let highestOverlayPaintOrder: number | undefined;
  let highestOverlayNode: EnhancedDOMTreeNode | undefined;

  if (expandElements.length > 0) {
    const viewport = getMainViewportSize(root);
    if (viewport) {
      const largeVisibleElements = visibleElements.filter(node => {
        const tagName = node.nodeName.toLowerCase();
        if (tagName === 'html' || tagName === 'body') {
          return false;
        }
        if (node.attributes.id === HIGHLIGHT_CONTAINER_ID) {
          return false;
        }

        // Only fixed or absolutely positioned elements can qualify as full-screen overlays here.
        const styles = node.snapshotNode?.computedStyles;
        const position = styles?.['position'];
        if (position !== 'fixed' && position !== 'absolute') {
          return false;
        }

        // pointer-events:none does not truncate interaction, and therefore is not considered a shield.
        if (styles?.['pointer-events'] === 'none') {
          return false;
        }

        const bounds = node.absolutePosition ?? node.snapshotNode?.bounds;
        if (!bounds) {
          return false;
        }

        const coverageRatio = getViewportCoverageRatio(bounds, viewport);
        return coverageRatio >= OVERLAY_COVERAGE_THRESHOLD;
      });

      if (largeVisibleElements.length > 0) {
        highestOverlayNode = largeVisibleElements.reduce((highest, node) => {
          const highestPaintOrder = highest.snapshotNode?.paintOrder ?? 0;
          const nodePaintOrder = node.snapshotNode?.paintOrder ?? 0;
          return nodePaintOrder > highestPaintOrder ? node : highest;
        });
        highestOverlayPaintOrder =
          highestOverlayNode.snapshotNode?.paintOrder ?? 0;
        highestOverlayNode.renderInfo.isOverlay = true;
      }
    }
  }

  // The second pass combines overlay results with interaction and top-element checks to choose final candidates.
  const processNode = (node: EnhancedDOMTreeNode): void => {
    if (!node.renderInfo) return;

    if (node.renderInfo.expandedViewportPosition !== undefined) {
      const nodePaintOrder = node.snapshotNode?.paintOrder ?? 0;
      node.renderInfo.isBlockedByOverlay =
        highestOverlayPaintOrder !== undefined &&
        highestOverlayPaintOrder > nodePaintOrder;
    }

    if (node.renderInfo.isInteractive) {
      if (node.renderInfo.isTopElement) {
        node.renderInfo.isCandidate = true;
      } else if (node.renderInfo.expandedViewportPosition !== undefined) {
        node.renderInfo.isCandidate = true;
      } else if (
        node.renderInfo.isVisuallyHiddenNativeControl &&
        node.renderInfo.isVisible
      ) {
        node.renderInfo.isCandidate = true;
      }
    }

    if (
      node.renderInfo.isCandidate &&
      node.nodeType === NodeType.ELEMENT_NODE &&
      node.nodeName.toLowerCase() === 'select'
    ) {
      node.renderInfo.isSelect = true;
      markSelectDescendantsAsCandidates(node);
    }

    for (const child of node.childrenNodes ?? []) {
      processNode(child);
    }
    for (const shadowRoot of node.shadowRoots ?? []) {
      processNode(shadowRoot);
    }
    if (node.contentDocument) {
      processNode(node.contentDocument);
    }
  };

  processNode(root);
}

/**
 * Creates a CDP command sender that binds the context of the current node: OOPIF takes its exclusive session and the main frame node CDPClient.
 */
function createSendCommand(
  node: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): <T>(method: string, params?: Record<string, unknown>) => Promise<T> {
  if (node.oopifSessionId && oopifManager) {
    const sessionId = node.oopifSessionId;
    return <T>(method: string, params?: Record<string, unknown>) =>
      oopifManager.sendCommand<T>(sessionId, method, params);
  }
  return <T>(method: string, params?: Record<string, unknown>) =>
    cdpClient.sendCommand<T>(method, params);
}

interface CDPEventListener {
  type: string;
  scriptId: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * The processor extraction function to be performed on the page: to check the current element and up to 50 layers of ancestors, covering React, Vue2/ 3, jQuery,
 * The inline onclick is covered by the back of the CDP primary event listening query.
 */
const EXTRACT_ELEMENT_HANDLERS_JS = `
function() {
  var handlers = [];

  function extractFromElement(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.startsWith('__reactProps$') || key.startsWith('__reactInternalInstance$')) {
        var props = el[key];
        if (props && typeof props.onClick === 'function') {
          handlers.push(props.onClick.toString());
        }
      }
      if (key.startsWith('__reactEvents$')) {
        var events = el[key];
        if (events && typeof events.onClick === 'function') {
          handlers.push(events.onClick.toString());
        }
      }
    }

    if (el.__vue__) {
      var vm = el.__vue__;
      if (vm.$listeners && typeof vm.$listeners.click === 'function') {
        handlers.push(vm.$listeners.click.toString());
      }
      if (vm._events && vm._events.click) {
        var clicks = vm._events.click;
        for (var j = 0; j < clicks.length; j++) {
          if (typeof clicks[j] === 'function') handlers.push(clicks[j].toString());
        }
      }
    }

    if (el.__vueParentComponent) {
      var vnode = el.__vueParentComponent;
      if (vnode.props && typeof vnode.props.onClick === 'function') {
        handlers.push(vnode.props.onClick.toString());
      }
    }

    if (typeof jQuery !== 'undefined' && jQuery._data) {
      try {
        var jqEvents = jQuery._data(el, 'events');
        if (jqEvents && jqEvents.click) {
          for (var k = 0; k < jqEvents.click.length; k++) {
            if (typeof jqEvents.click[k].handler === 'function') {
              handlers.push(jqEvents.click[k].handler.toString());
            }
          }
        }
      } catch(e) {}
    }
  }

  // Current element itself
  extractFromElement(this);

  // 2. Walk the ancestor chain to find click handlers.
  var el = this.parentElement;
  var depth = 0;
  while (el && depth < 50) {
    extractFromElement(el);
    el = el.parentElement;
    depth++;
  }

  return handlers;
}
`;

/**
 * Collect click-listener signatures for one node.
 * 1. DOM.resolveNode resolves backendNodeId to a remote object in the current session.
 * 2. DOMDebugger.getEventListeners records native click listeners by script location.
 * 3. Runtime.callFunctionOn runs the extractor above and records inline/delegated handlers by function source.
 * Failures are ignored and any signatures collected so far are returned, preventing one
 * inaccessible node from aborting render-info calculation for the whole tree.
 */
async function getClickListenerSignatures(
  node: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<string[]> {
  const sigs: string[] = [];
  const sendCmd = createSendCommand(node, cdpClient, oopifManager);
  try {
    const resolved = await sendCmd<{
      object: { objectId?: string };
    }>('DOM.resolveNode', { backendNodeId: node.backendNodeId });

    const objectId = resolved?.object?.objectId;
    if (!objectId) return sigs;

    // 1. CDP Native event listeners.
    const result = await sendCmd<{
      listeners: CDPEventListener[];
    }>('DOMDebugger.getEventListeners', { objectId });

    for (const l of result?.listeners ?? []) {
      if (l.type === 'click') {
        sigs.push(`native:${l.scriptId}:${l.lineNumber}:${l.columnNumber}`);
      }
    }

    // Frame processors such as 2. React, Vue and jQuery
    const fwResult = await sendCmd<{
      result: { value?: string[] };
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: EXTRACT_ELEMENT_HANDLERS_JS,
      returnByValue: true,
    });

    const fwHandlers = fwResult?.result?.value;
    if (Array.isArray(fwHandlers)) {
      for (const h of fwHandlers) {
        sigs.push(`framework:${h}`);
      }
    }
  } catch {
    // The elements in the dynamic page may be invalid or unable to be parsed; at this point, an empty signature is kept and other candidates continue to be processed.
  }
  return sigs;
}

/**
 * Stage 4: Batch access to all clicks on the isCandidate node.
 * This must run after markInteractiveCandidates(); the traversal currently follows only childrenNodes and does not enter
 * shadowRoots or contentDocument. DOM.enable Failed to process as "may have been enabled " , followed by a search for candidate nodes.
 */
async function fetchClickListenerSignatures(
  root: EnhancedDOMTreeNode,
  cdpClient: CDPClient,
  oopifManager?: OOPIFManager,
): Promise<void> {
  const allCandidates: EnhancedDOMTreeNode[] = [];
  const collectAll = (node: EnhancedDOMTreeNode) => {
    if (node.renderInfo?.isCandidate) {
      allCandidates.push(node);
    }
    for (const child of node.childrenNodes ?? []) {
      collectAll(child);
    }
  };
  collectAll(root);

  if (allCandidates.length === 0) return;

  try {
    await cdpClient.sendCommand('DOM.enable');
  } catch {
    // The DOM domain may already be enabled and will not interrupt subsequent candidate queries.
  }

  await Promise.all(
    allCandidates.map(async node => {
      const sigs = await getClickListenerSignatures(
        node,
        cdpClient,
        oopifManager,
      );
      if (node.renderInfo) {
        node.renderInfo.clickListenerSignatures = sigs;
      }
    }),
  );
}

function collectCandidateDescendants(
  node: EnhancedDOMTreeNode,
): EnhancedDOMTreeNode[] {
  const result: EnhancedDOMTreeNode[] = [];
  const visit = (n: EnhancedDOMTreeNode, isRoot: boolean) => {
    if (!isRoot && n.renderInfo?.isCandidate) {
      result.push(n);
    }
    for (const child of n.childrenNodes ?? []) {
      visit(child, false);
    }
  };
  visit(node, true);
  return result;
}

/**
 * Phase 5: compare candidate ancestors and descendants top-down to mark duplicate listeners.
 *
 * The current phase and collectCandidateDescendants () go only along childrenNodes. For every ancestor:
 * 1. In the same OOPIF session, if a descendant resolves to the ancestor's backend node
 *    rather than itself, mark it as a duplicate and record listenerHostId.
 * 2. Otherwise, require the same hit target and require every descendant listener signature
 *    to be present on the ancestor. Signatures alone are insufficient because delegated
 *    handlers may branch on event.target.
 * 3. Continue comparing below duplicate nodes; mark the ancestor that owns the listener as isListenerHost.
 */
function deduplicateByListeners(root: EnhancedDOMTreeNode): void {
  const visit = (node: EnhancedDOMTreeNode) => {
    if (node.renderInfo?.isDuplicateListener) return;

    if (node.renderInfo?.isCandidate) {
      const descendants = collectCandidateDescendants(node);
      for (const desc of descendants) {
        if (desc.renderInfo?.isDuplicateListener) continue;
        if (!desc.renderInfo) continue;

        // Rule 1: require the same frame and hit target, excluding a descendant that hits itself.
        if (
          node.oopifSessionId === desc.oopifSessionId &&
          node.renderInfo.hitBackendNodeId !== undefined &&
          desc.renderInfo.hitBackendNodeId ===
            node.renderInfo.hitBackendNodeId &&
          desc.renderInfo.hitBackendNodeId !== desc.backendNodeId
        ) {
          desc.renderInfo.isDuplicateListener = true;
          desc.renderInfo.listenerHostId = node.backendNodeId;
          node.renderInfo.isListenerHost = true;
          continue;
        }

        // Rule 2: descendant listener signatures must be a subset of the ancestor's and both must hit the same target.
        // Signatures alone are insufficient because delegated handlers often branch on event.target.
        const parentSigs = node.renderInfo.clickListenerSignatures;
        const childSigs = desc.renderInfo.clickListenerSignatures;
        if (!parentSigs || parentSigs.length === 0) continue;
        if (!childSigs || childSigs.length === 0) continue;
        if (
          node.renderInfo.hitBackendNodeId === undefined ||
          desc.renderInfo.hitBackendNodeId === undefined ||
          desc.renderInfo.hitBackendNodeId !== node.renderInfo.hitBackendNodeId
        )
          continue;

        const parentSigSet = new Set(parentSigs);
        const isSubset = childSigs.every(sig => parentSigSet.has(sig));
        if (isSubset) {
          desc.renderInfo.isDuplicateListener = true;
          desc.renderInfo.listenerHostId = node.backendNodeId;
          node.renderInfo.isListenerHost = true;
        }
      }
    }

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
  };

  visit(root);
}
