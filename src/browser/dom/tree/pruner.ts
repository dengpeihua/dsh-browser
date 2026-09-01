/**
 * In-place pruning for model-facing DOM trees.
 *
 * The pruner flattens normal, Shadow DOM, and iframe child boundaries, then
 * repeatedly removes empty branches and unwraps redundant structural shells
 * until stable. Text, visual elements, listener hosts, and useful candidates
 * remain. When an original-tree lookup is provided, pruning reasons are written
 * back to the matching original nodes.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { mergeInlineNodes } from './inline-merger';
import { NAME_FROM_CONTENT_ROLES } from '../types/ax';
import { markPruneReason, isVisualElement } from '../utils/index';

const MAX_ITERATIONS = 100;

/**
 * In-situ cropping of DOM trees and repeated execution to nodes without change.
 *
 * @param root - Tree to prune; boundary fields, childrenNodes, candidate state, and cached text may be modified in place.
 * @param lookup - Optional original-tree index; when present, pruneReason is written back to the matching original node.
 */
export function pruneTree(
  root: EnhancedDOMTreeNode,
  lookup?: Map<string, EnhancedDOMTreeNode>,
): void {
  // Step 1 : Merge text in consecutive line elements and reduce text fragments for subsequent judgement.
  mergeInlineNodes(root);

  // Step 2 : Remove the border of Shadow DOM and iframe documents first, leaving the follow-up logic only childrenNodes .
  flattenBoundaries(root);

  // Use an empty Map when not calling lookup to align the cropping path; at this time markPruneReason () cannot find the original node, but does not write back the reason for the diagnosis.
  const effectiveLookup = lookup ?? new Map<string, EnhancedDOMTreeNode>();

  let changed = true;
  let iteration = 0;

  while (changed && iteration < MAX_ITERATIONS) {
    iteration++;

    // Step 3: The total number of nodes before and after the round is used to determine whether the nodes have actually been removed.
    const countBefore = countNodes(root);

    // The body does not enter pruneNode () at all and only starts with the root ' s child node, which is then replaced by the root ' s child node array.
    root.childrenNodes = pruneChildren(
      root,
      root.childrenNodes ?? [],
      effectiveLookup,
    );

    const countAfter = countNodes(root);
    changed = countBefore !== countAfter;

    if (changed) {
      // There are no additional side effects of the current branch; changed = true is only responsible for allowing while to run another round to identify emerging cropping opportunities following structural changes.
    }
  }
}

/**
 * Recursive elimination of tree boundaries: maintain the original normal subnode order and add Shadow Root and contentDocument direct subnode.
 * Boundary containers themselves do not enter the final childrenNodes; the parentNode elevated node is replaced by the current host node.
 */
function flattenBoundaries(node: EnhancedDOMTreeNode): void {
  const merged: EnhancedDOMTreeNode[] = [];

  for (const child of node.childrenNodes ?? []) {
    merged.push(child);
  }

  if (node.shadowRoots) {
    for (const shadow of node.shadowRoots) {
      for (const child of shadow.childrenNodes ?? []) {
        child.parentNode = node;
        merged.push(child);
      }
    }
    node.shadowRoots = undefined;
  }

  if (node.contentDocument) {
    for (const child of node.contentDocument.childrenNodes ?? []) {
      child.parentNode = node;
      merged.push(child);
    }
    node.contentDocument = undefined;
  }

  node.childrenNodes = merged;

  for (const child of node.childrenNodes) {
    flattenBoundaries(child);
  }
}

function countNodes(node: EnhancedDOMTreeNode): number {
  // The current node count 1 is cumulatively distributed to all descendants in childrenNodes; this count is used only to determine if the cropping is constricted.
  let count = 1;
  for (const child of node.childrenNodes ?? []) {
    count += countNodes(child);
  }
  return count;
}

function pruneChildren(
  parent: EnhancedDOMTreeNode,
  children: EnhancedDOMTreeNode[],
  lookup: Map<string, EnhancedDOMTreeNode>,
): EnhancedDOMTreeNode[] {
  const result: EnhancedDOMTreeNode[] = [];

  for (const child of children) {
    // A child may become 0 , retain 1 , or when the shell is removed, it becomes several elevated grandchildren.
    const processed = pruneNode(child, lookup);
    for (const node of processed) {
      // Amends the parent pointer to parent to receive the returned value of this group, regardless of the level at which the node was originally located.
      node.parentNode = parent;
    }
    result.push(...processed);
  }

  return result;
}

function pruneNode(
  node: EnhancedDOMTreeNode,
  lookup: Map<string, EnhancedDOMTreeNode>,
): EnhancedDOMTreeNode[] {
  // Bottom-up: A set of subnodes that have stabilized a round must be obtained before determining whether the current node is still a necessary structural layer.
  node.childrenNodes = pruneChildren(node, node.childrenNodes ?? [], lookup);

  // The root has no parent that could receive promoted children, so retain it unconditionally.
  if (!node.parentNode) return [node];

  // Priority 1: remove a subtree blocked by an overlay, regardless of its text or candidate status.
  if (node.renderInfo?.isBlockedByOverlay) {
    markPruneReason(lookup, node, 'blocked-by-overlay: removed');
    return [];
  }

  // Priority 2: To retain the current top-of-view text, the extended version of the visual text and the text removed in the difference tree, which represents the old content.
  if (
    node.nodeType === NodeType.TEXT_NODE &&
    (node.renderInfo.isTopElement ||
      node.renderInfo.expandedViewportPosition !== undefined ||
      node.renderInfo.diffStatus === 'removed')
  )
    return [node];

  // Priority 3: retain independently rendered visual elements and cache an SVG use href as readable icon text.
  if (isVisualElement(node)) {
    const useHref = extractSvgUseHref(node);
    if (useHref) {
      node.renderInfo.cachedText = useHref;
    }
    return [node];
  }

  // Priority 4: demote duplicate-listener candidates whose nearest candidate ancestor exposes the same content, avoiding duplicate actions.
  // Select options must remain candidates and are excluded from this rule.
  if (
    node.renderInfo?.isCandidate &&
    node.renderInfo.isDuplicateListener &&
    !node.renderInfo.isSelectOption
  ) {
    const ancestor = findAncestorCandidate(node);
    if (ancestor && isSameContent(node, ancestor)) {
      markPruneReason(lookup, node, 'duplicate-listener: unwrapped');
      node.renderInfo.isCandidate = false;
    }
  }

  // Priority 5: retain a listener host as the structural anchor for descendant listeners, even when it has little content.
  if (node.renderInfo?.isListenerHost) return [node];

  // Priority 6: retain candidates with text, whitelisted attributes, or visual content; demote empty candidates before structural pruning.
  if (node.renderInfo?.isCandidate) {
    if (hasContent(node)) return [node];
    markPruneReason(lookup, node, 'empty-candidate: demoted');
    node.renderInfo.isCandidate = false;
  }

  // Priority 7: evaluate structural redundancy. Most removals unwrap the current element and promote its children to the parent.
  const isOnlyChild = node.parentNode.childrenNodes?.length === 1;
  const hasNoChildren = (node.childrenNodes?.length ?? 0) === 0;
  const noCandidateInSubtree = !hasDescendantCandidate(node);

  if (isOnlyChild) {
    // An only-child wrapper adds no sibling grouping information, so unwrap it and promote its children.
    markPruneReason(lookup, node, 'only-child: unwrapped');
    return node.childrenNodes ?? [];
  }
  if (hasNoChildren) {
    // Remove an empty leaf that is not text, a visual element, a listener host, or a candidate.
    markPruneReason(lookup, node, 'empty-leaf: unwrapped');
    return node.childrenNodes ?? [];
  }
  if (noCandidateInSubtree) {
    // When there is no interactive candidate within the branch, the current container no longer assumes the role of candidate grouping; the shell is removed but the previously adopted sub-content is retained.
    markPruneReason(lookup, node, 'no-candidate-in-subtree: unwrapped');
    return node.childrenNodes ?? [];
  }

  // The current node contains candidates and there are still several subnodes, and this layer needs to be retained to express the structural relationship between candidates.
  return [node];
}

/** To determine whether the present node or any descendants still have a candidate to determine the structural significance of the container layer. */
function hasDescendantCandidate(node: EnhancedDOMTreeNode): boolean {
  if (node.renderInfo?.isCandidate) return true;
  for (const child of node.childrenNodes ?? []) {
    if (hasDescendantCandidate(child)) return true;
  }
  return false;
}

/**
 * Determines whether visual elements exist before the current node reaches the lower candidate boundary.
 * The branch is discontinued when a candidate child node is encountered, since its visual content should belong to the sub-node and not to the current candidate.
 */
function hasVisualElementTillNextCandidate(node: EnhancedDOMTreeNode): boolean {
  if (isVisualElement(node)) return true;
  for (const child of node.childrenNodes ?? []) {
    if (child.renderInfo?.isCandidate) continue;
    if (hasVisualElementTillNextCandidate(child)) return true;
  }
  return false;
}

/**
 * A node has content when it contributes cached/aggregated text, whitelisted attributes,
 * or visual elements before the next candidate boundary.
 */
function hasContent(node: EnhancedDOMTreeNode): boolean {
  const text =
    node.renderInfo.cachedText !== undefined
      ? node.renderInfo.cachedText
      : getAllTextTillNextCandidate(node);
  const hasAttrs = hasWhitelistedAttributes(node);
  return !!(text || hasAttrs || hasVisualElementTillNextCandidate(node));
}

/**
 * Collects text below the current node, before the next candidate or visual element.
 *
 * order of calculation: scan each of the direct subnodes; candidate and visual elements each carry the content and do not cross the current node to extract the text; normal text nodes
 * After trim insert arrays, and the other nodes are then grouped. Finally removes the empty strings, connects them with spaces and presses them into one space.
 * If DOM text is empty and the name AX role allows "from content" then the barrier-free name will be used.
 */
export function getAllTextTillNextCandidate(node: EnhancedDOMTreeNode): string {
  const texts: string[] = [];
  for (const child of node.childrenNodes ?? []) {
    if (child.renderInfo?.isCandidate) continue;
    if (isVisualElement(child)) continue;
    if (child.nodeType === NodeType.TEXT_NODE && child.nodeValue) {
      texts.push(child.nodeValue.trim());
    } else {
      texts.push(getAllTextTillNextCandidate(child));
    }
  }
  const result = texts.filter(Boolean).join(' ').replace(/\s+/g, ' ');
  if (
    !result &&
    node.axNode?.role &&
    NAME_FROM_CONTENT_ROLES.has(node.axNode.role)
  ) {
    return node.axNode.name?.trim() ?? '';
  }
  return result;
}

/** As long as there is at least one selected model readable attribute at the node, it is considered to be attribute content. */
function hasWhitelistedAttributes(node: EnhancedDOMTreeNode): boolean {
  const wa = node.whitelistedAttributes;
  return !!wa && Object.keys(wa).length > 0;
}

/**
 * Strictly compare a descendant's whitelisted attributes with an ancestor's: both sets
 * must contain the same keys and values.
 */
function hasSameWhitelistedAttributes(
  desc: EnhancedDOMTreeNode,
  ancestor: EnhancedDOMTreeNode,
): boolean {
  const descAttrs = desc.whitelistedAttributes ?? {};
  const ancestorAttrs = ancestor.whitelistedAttributes ?? {};
  const descEntries = Object.entries(descAttrs);
  const ancestorEntries = Object.entries(ancestorAttrs);

  if (descEntries.length !== ancestorEntries.length) {
    return false;
  }

  return descEntries.every(([key, value]) => ancestorAttrs[key] === value);
}

/** From the direct parent node, you can look up for the most recent “candidature and non-repeat listening” ancestors. */
function findAncestorCandidate(
  node: EnhancedDOMTreeNode,
): EnhancedDOMTreeNode | undefined {
  let ancestor = node.parentNode;
  while (ancestor) {
    if (
      ancestor.renderInfo?.isCandidate &&
      !ancestor.renderInfo.isDuplicateListener
    ) {
      return ancestor;
    }
    ancestor = ancestor.parentNode;
  }
  return undefined;
}

/**
 * Determine whether a descendant repeats its ancestor: non-empty descendant text must be
 * contained in the ancestor text, and the whitelisted attributes must match exactly.
 * Empty descendant text skips the text check, but attributes must still match.
 */
function isSameContent(
  desc: EnhancedDOMTreeNode,
  ancestor: EnhancedDOMTreeNode,
): boolean {
  const descText = getAllTextTillNextCandidate(desc);
  const ancestorText = getAllTextTillNextCandidate(ancestor);
  if (descText && !ancestorText.includes(descText)) return false;
  return hasSameWhitelistedAttributes(desc, ancestor);
}

/** Collect href/xlink:href values from descendant SVG use elements that reference symbol paths. */
function extractSvgUseHref(node: EnhancedDOMTreeNode): string | undefined {
  const hrefs: string[] = [];
  collectUseHrefs(node, hrefs);
  return hrefs.length > 0 ? hrefs.join(' ') : undefined;
}

/** Depth priority goes through the subtree SVG and insert all use references in the order in which they appear. */
function collectUseHrefs(node: EnhancedDOMTreeNode, hrefs: string[]): void {
  if (node.nodeName.toLowerCase() === 'use' && node.attributes) {
    const href = node.attributes['href'] || node.attributes['xlink:href'];
    if (href) hrefs.push(href);
  }
  for (const child of node.childrenNodes ?? []) {
    collectUseHrefs(child, hrefs);
  }
}
