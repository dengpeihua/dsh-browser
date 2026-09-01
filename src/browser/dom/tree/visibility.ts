/**
 * Frame-aware element visibility.
 *
 * Visibility combines computed style, geometry, the nearest scroll-container
 * viewport, iframe ancestry, and an optional expanded viewport. Results are
 * either visible, hidden, or outside the viewport in one expansion direction.
 * All rectangles use the same absolute coordinate system; missing geometry is
 * treated as invisible.
 */

import type { EnhancedDOMTreeNode, DOMRect } from '../types/dom-node';
import { NodeType } from '../types/dom-node';

type ExpandedViewportPosition = 'above' | 'below' | 'left' | 'right';

export interface VisibilityResult {
  isVisible: boolean;
  /** The element is outside the visible viewport but inside the expanded frame viewport. */
  expandedViewportPosition?: ExpandedViewportPosition;
}

interface ContainerViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Checks whether elements are visible in its local view.
 * The visible state of the ancestor frame/container is transmitted down through parentFrameState alone, so expand is always calculated in relation to the nearest scrolling ancestor;
 * If there is no scrollable ancestry, calculate it relative to the current page view.
 *
 * Check order:
 * Visibility (display, visibility, opacity).
 * The geometric boundary of the element exists and is valid.
 * 3. Whether the element intersects with the nearest container ' s viewport or is within the extension expand.
 */
export type ParentFrameState = 'visible' | ExpandedViewportPosition | 'hidden';

export function checkElementVisibility(
  node: EnhancedDOMTreeNode,
  htmlFrames: EnhancedDOMTreeNode[],
  expand?: number,
  parentFrameState: ParentFrameState = 'visible',
): VisibilityResult {
  // Step 1: No style and geometric data without snapshots can be shown.
  if (!node.snapshotNode) {
    return { isVisible: false };
  }

  // Step 2: Read the calculation style CSS that affects visibility.
  const computedStyles = node.snapshotNode.computedStyles ?? {};

  const display = (computedStyles.display ?? '').toLowerCase();
  const visibility = (computedStyles.visibility ?? '').toLowerCase();
  const opacity = computedStyles.opacity ?? '1';

  // When the parent frame has been determined to be completely hidden, the child node is no longer partially calculated.
  if (parentFrameState === 'hidden') {
    return { isVisible: false };
  }

  // CSS clearly hidden elements are neither visible nor entering the extension area.
  if (display === 'none' || visibility === 'hidden') {
    return { isVisible: false };
  }

  // Use absolute coordinates to ensure that the element rectangle is compared with the container rectangle in the same coordinate system.
  const elementBounds = node.absolutePosition ?? node.snapshotNode.bounds;
  const opacityValue = Number.parseFloat(opacity);

  if (!elementBounds) {
    return { isVisible: false };
  }

  // Some UI libraries hide the original checkbox/radio visually, and then delegate clicks to container elements such as label.
  // For this type of tagged primary control, even if it is wide or transparent 0, it is retained in the tree to facilitate Agent understanding of form status and semantics.
  if (
    !node.renderInfo.isVisuallyHiddenNativeControl &&
    (elementBounds.width <= 0 ||
      elementBounds.height <= 0 ||
      (Number.isFinite(opacityValue) && opacityValue <= 0))
  ) {
    return { isVisible: false };
  }

  const frameResult = checkFrameVisibility(
    node,
    elementBounds,
    htmlFrames,
    expand,
  );

  if (parentFrameState !== 'visible') {
    // When the parent frame is located in the extension area, the parent frame will be given direction as long as the child nodes are visible in the local view or are also in the local extension area.
    // The child nodes are not marked as really visible here, because the carrying parent frame itself is still outside the current view.
    if (frameResult.state === 'visible' || frameResult.state === 'expand') {
      return {
        isVisible: false,
        expandedViewportPosition: parentFrameState,
      };
    }
    return { isVisible: false };
  }

  // When the parent frame is visible, the result of the calculation is used directly against the current node.
  if (frameResult.state === 'visible') {
    return { isVisible: true };
  }
  if (frameResult.state === 'expand') {
    return {
      isVisible: false,
      expandedViewportPosition: frameResult.direction,
    };
  }
  return { isVisible: false };
}

type FrameVisibilityResult =
  | { state: 'visible' }
  | { state: 'expand'; direction: ExpandedViewportPosition }
  | { state: 'hidden' };

/**
 * The visual rectangle is constructed for nodes in the absolute system of coordinates.
 * clientRects provides the visible viewport size, while absolutePosition anchors the
 * rectangle in page coordinates.
 *
 * body/html inside an iframe may report a clientRect smaller than the actual visible area, such as a 384px body inside a 500px iframe.
 * At this point, the larger size of the host iframe is used as a visual view, as this part of the window iframe is actually visible.
 */
function getNodeViewportRect(
  node: EnhancedDOMTreeNode,
): ContainerViewport | null {
  const anchor = node.absolutePosition ?? node.snapshotNode?.bounds;
  const clientRect = node.snapshotNode?.clientRects;

  if (!anchor) {
    return null;
  }

  if (clientRect && clientRect.width > 0 && clientRect.height > 0) {
    let width = clientRect.width;
    let height = clientRect.height;

    // For body/html inside an iframe, expand to the host iframe size when it is larger.
    const tag = node.nodeName.toLowerCase();
    if (tag === 'body' || tag === 'html') {
      const iframeViewport = getIframeHostViewport(node);
      if (iframeViewport) {
        width = Math.max(width, iframeViewport.width);
        height = Math.max(height, iframeViewport.height);
      }
    }

    return {
      x: anchor.x + clientRect.x,
      y: anchor.y + clientRect.y,
      width,
      height,
    };
  }

  if (anchor.width <= 0 || anchor.height <= 0) {
    return null;
  }

  return {
    x: anchor.x,
    y: anchor.y,
    width: anchor.width,
    height: anchor.height,
  };
}

/**
 * Search the host iframe from inside iframe up along parentNode and return to the width of clientRects.
 * Example: body/html -> IFRAME.
 */
function getIframeHostViewport(
  node: EnhancedDOMTreeNode,
): { width: number; height: number } | null {
  let current = node.parentNode;
  while (current) {
    const tag = current.nodeName.toUpperCase();
    if (tag === 'IFRAME' || tag === 'FRAME') {
      const cr = current.snapshotNode?.clientRects;
      if (cr && cr.width > 0 && cr.height > 0) {
        return { width: cr.width, height: cr.height };
      }
      return null;
    }
    current = current.parentNode;
  }
  return null;
}

/**
 * Returns a local view formed by the nearest scrolling ancestors; continues to search up when no effective rectangle exists.
 */
function getScrollableAncestorViewport(
  node: EnhancedDOMTreeNode,
): ContainerViewport | null {
  let current = node.parentNode;
  while (current) {
    if (current.renderInfo?.isScrollable) {
      const viewport = getNodeViewportRect(current);
      if (viewport) {
        return viewport;
      }
    }

    current = current.parentNode;
  }

  return null;
}

/**
 * Returns the HTML view of the current page when there is no scrollable ancestor.
 * Find the current HTML along node.parentNode ; if not, find the backup HTML at the end of htmlFrames .
 */
function getPageViewport(
  node: EnhancedDOMTreeNode,
  htmlFrames: EnhancedDOMTreeNode[],
): ContainerViewport | null {
  let current: EnhancedDOMTreeNode | undefined = node;
  while (current) {
    if (
      current.nodeType === NodeType.ELEMENT_NODE &&
      current.nodeName === 'HTML' &&
      current.snapshotNode?.clientRects
    ) {
      return getNodeViewportRect(current);
    }

    current = current.parentNode;
  }

  for (let i = htmlFrames.length - 1; i >= 0; i--) {
    const frame = htmlFrames[i];
    if (!frame) continue;
    if (
      frame.nodeType === NodeType.ELEMENT_NODE &&
      frame.nodeName === 'HTML' &&
      frame.snapshotNode?.clientRects
    ) {
      return getNodeViewportRect(frame);
    }
  }

  return null;
}

/**
 * Calculates the state of the element relative to the local view.
 * Returns three-state instead of simple boolean values: visible for rectangle intersections; expand for centrepoints within extension ranges; hidden for both.
 */
function checkFrameVisibility(
  node: EnhancedDOMTreeNode,
  elementBounds: DOMRect,
  htmlFrames: EnhancedDOMTreeNode[],
  expand?: number,
): FrameVisibilityResult {
  const containerViewport =
    getScrollableAncestorViewport(node) ?? getPageViewport(node, htmlFrames);
  if (!containerViewport) {
    return { state: 'visible' };
  }

  const vpLeft = containerViewport.x;
  const vpTop = containerViewport.y;
  const vpRight = vpLeft + containerViewport.width;
  const vpBottom = vpTop + containerViewport.height;

  const inH =
    elementBounds.x + elementBounds.width > vpLeft && elementBounds.x < vpRight;
  const inV =
    elementBounds.y + elementBounds.height > vpTop &&
    elementBounds.y < vpBottom;

  if (inH && inV) {
    return { state: 'visible' };
  }

  if (expand !== undefined && expand > 0) {
    // expand In units: vertical by container height, horizontal by container width, converted to pixel distance.
    const expandV = expand * containerViewport.height;
    const expandH = expand * containerViewport.width;
    const centerX = elementBounds.x + elementBounds.width / 2;
    const centerY = elementBounds.y + elementBounds.height / 2;
    const inHExpand = centerX > vpLeft - expandH && centerX < vpRight + expandH;
    const inVExpand = centerY > vpTop - expandV && centerY < vpBottom + expandV;

    if (centerY < vpTop && centerY > vpTop - expandV && inHExpand)
      return { state: 'expand', direction: 'above' };
    if (centerY >= vpBottom && centerY < vpBottom + expandV && inHExpand)
      return { state: 'expand', direction: 'below' };
    if (centerX < vpLeft && centerX > vpLeft - expandH && inVExpand)
      return { state: 'expand', direction: 'left' };
    if (centerX >= vpRight && centerX < vpRight + expandH && inVExpand)
      return { state: 'expand', direction: 'right' };
  }

  return { state: 'hidden' };
}
