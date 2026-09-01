/**
 * Module overview
 * Responsibility: Browser DOM visual-element detection used by the DOM service.
 * Usage: Runs after CDP DOM, accessibility, and layout snapshots are captured and contributes stable data for snapshot indexes, positioning, and rendering.
 * State and failure boundaries: Frame ownership, backend node IDs, model reference numbers, and incremental state must remain consistent across navigation and OOPIF changes.
 * Maintenance: When changing heuristics, verify cross-frame, dynamic-page, Shadow DOM, state-restoration, adjacent-test, and public-type paths.
 */

/**
 * Visual Element Map
 *
 * Collects visual top elements (img/svg/table/etc.) keyed by backendNodeId.
 * Used by tools to look up visual elements for viewing/inspection.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { isVisualTopNode, encodeViewId } from '../utils/index';

/** Maps encoded view ID (e.g. "ife") → node for visual top elements */
export type VisualElementMap = Map<string, EnhancedDOMTreeNode>;

/**
 * Build visual element map keyed by encoded view ID.
 */
export function buildVisualElementMap(
  root: EnhancedDOMTreeNode,
): VisualElementMap {
  const map: VisualElementMap = new Map();

  const visit = (node: EnhancedDOMTreeNode): void => {
    if (
      node.nodeType === NodeType.ELEMENT_NODE &&
      node.renderInfo?.isTopElement &&
      isVisualTopNode(node)
    ) {
      map.set(encodeViewId(node.backendNodeId), node);
    }

    for (const child of node.childrenNodes ?? []) {
      visit(child);
    }
  };

  visit(root);
  return map;
}
