/**
 * Model-facing DOM text serialization.
 *
 * The renderer consumes a pruned and numbered EnhancedDOMTreeNode tree. It emits
 * model-facing element lines, off-screen regions, diff markers, and interaction
 * history without recomputing visibility or candidacy. In incremental mode it
 * skips only subtrees that contain no changed node and writes stable renderedLine
 * fingerprints back to the corresponding cached original nodes.
 */

import type {
  EnhancedDOMTreeNode,
  InteractionRecord,
} from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import { getAllTextTillNextCandidate } from '../tree/pruner';
import {
  nodeKey,
  STRUCTURAL_CHILD_TAGS,
  isVisualTopNode,
  isVisualElement,
  encodeViewId,
} from '../utils/index';

/**
 * Reads a unified list of direct subnodes. Upstream pruneTree() has already put normal subnodes, ShadowRoot and iframecontentDocument
 * The content is spread to childrenNodes, so there are no more three different borders.
 */
function getAllChildren(node: EnhancedDOMTreeNode): EnhancedDOMTreeNode[] {
  return node.childrenNodes ?? [];
}

/**
 * Check the presence of candidate nodes or independent visual elements among the ancestors. Such ancestors aggregate the text of the next generation, and the current node cannot be re-exported when hit.
 * Otherwise the same text appears in both the parent element line and the text node line.
 */
function hasCandidateOrVisualAncestor(node: EnhancedDOMTreeNode): boolean {
  let ancestor = node.parentNode;
  while (ancestor) {
    if (ancestor.renderInfo.isCandidate || isVisualElement(ancestor)) {
      return true;
    }
    ancestor = ancestor.parentNode;
  }
  return false;
}

/**
 * Build the serialized attribute string and remove information duplicated by the node text.
 *
 * Order of calculation:
 * 1. Return an empty attribute string and the original text when no whitelisted attributes exist.
 * 2. Shallow-copy the attributes so deduplication never mutates the node's stored data.
 * Delete this semantic information if role is identical to the lowercase label name.
 * 4. Compare attribute values with text after trim: property values overwrite text and ultimately empty line text; text contains attribute values
 * , text overwhelms the attribute, deleting it. When the two are equal, the former situation is followed, with priority being given to retaining the attribute.
 * 5. Spell the remaining properties as `key ='value' and connect them in spaces.
 *
 * returns `{attrsStr, text} '; returned text may be an empty string if the attribute already expresses the same content.
 */
export function buildAttributesString(
  node: EnhancedDOMTreeNode,
  text: string,
): { attrsStr: string; text: string } {
  const attrs = node.whitelistedAttributes;
  if (!attrs || Object.keys(attrs).length === 0) return { attrsStr: '', text };

  const attributesToInclude = { ...attrs };

  // Delete the redundant syntax: role has the same message as the label name.
  if (
    attributesToInclude.role &&
    node.nodeName.toLowerCase() === attributesToInclude.role
  ) {
    delete attributesToInclude.role;
  }

  // The attribute value and the text contain each other while retaining the longer party; the attribute is preferred when the length and content are equal.
  const trimmedText = text.trim();
  let suppressText = false;
  if (trimmedText) {
    for (const key of Object.keys(attributesToInclude)) {
      const attrVal = attributesToInclude[key]?.trim();
      if (!attrVal) continue;
      if (attrVal.includes(trimmedText)) {
        suppressText = true; // Properties already overwrite text, and eventually no longer output line text.
      } else if (trimmedText.includes(attrVal)) {
        delete attributesToInclude[key]; // text already overwrites the attribute value and deletes the duplicate attribute.
      }
    }
  }

  if (Object.keys(attributesToInclude).length === 0)
    return { attrsStr: '', text: suppressText ? '' : text };

  const attrsStr = Object.entries(attributesToInclude)
    .map(([key, value]) => `${key}='${value}'`)
    .join(' ');
  return { attrsStr, text: suppressText ? '' : text };
}

const MAX_OFFSCREEN_TEXT = 50;

/** A variable state that is shared at a depth is used to maintain the partitions and result lines outside the screen in order of output. */
interface RenderState {
  currentZone: 'above' | 'below' | 'left' | 'right' | undefined;
  lines: string[];
  /** backendNodeId - > an interactive historical record for labelling elements previously operated by the model. */
  interactionMap?: Map<number, InteractionRecord[]>;
  /** Skip a subtree only when neither it nor any descendant contains a diff. */
  incrementalDiff?: boolean;
}

/**
 * Converts the historical interactive records of the same element to a modelable HTML comment.
 *
 * Number of times click and select only; input start with the three parameters text, clear/append and pressEnter and output each group
 * Number of times. The caller has filtered the record with backendNodeId and renderedLine and this function is only about aggregation and fusion.
 */
function buildInteractionAnnotation(records: InteractionRecord[]): string {
  const parts: string[] = [];

  const clicks = records.filter(r => r.action === 'click');
  const selects = records.filter(r => r.action === 'select');
  const inputs = records.filter(r => r.action === 'input');

  if (clicks.length > 0) {
    parts.push(`you already clicked this element ${clicks.length} times`);
  }
  if (selects.length > 0) {
    parts.push(`you already selected this element ${selects.length} times`);
  }
  if (inputs.length > 0) {
    // Grouping by the same input parameter (text/clear/pressEnter) to avoid double output of multiple equivalent notes.
    const groups = new Map<
      string,
      { text: string; clear: string; enter: string; count: number }
    >();
    for (const inp of inputs) {
      const text = String(inp.params?.text ?? '');
      const clear = inp.params?.clear !== false ? 'clear' : 'append';
      const enter = inp.params?.pressEnter ? '+Enter' : '';
      const key = `${text}|${clear}|${enter}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, { text, clear, enter, count: 1 });
      }
    }
    for (const { text, clear, enter, count } of groups.values()) {
      const times = count > 1 ? ` ${count} times` : '';
      parts.push(`you already input "${text}" here${times} (${clear}${enter})`);
    }
  }

  return `<!-- ${parts.join('; ')} -->`;
}

/**
 * Public entry point for rendering a DOM tree as text.
 *
 * @param node - The root that has been calculated upstream renderInfo, cropped and numbered; null indicates an output empty string
 * @paramdepth - Initial indent depth, general call 0; one tab for each level Arguments
 * @paramlookup - A composite key index of the original DOM tree to write back from the crop copy to the original nodes
 * @paraminteractionMap - Historical interactive records grouped by backendNodeId
 * @paramoptions.incrementalDiff - Output only added/removed difference nodes and skip completely undifferentiated subtrees
 */
export function renderToHtml(
  node: EnhancedDOMTreeNode | null,
  depth = 0,
  lookup?: Map<string, EnhancedDOMTreeNode>,
  interactionMap?: Map<number, InteractionRecord[]>,
  options?: { incrementalDiff?: boolean },
): string {
  const state: RenderState = {
    currentZone: undefined,
    lines: [],
    interactionMap,
    incrementalDiff: options?.incrementalDiff,
  };
  // Recursive calls share one state so off-screen section boundaries follow final depth-first output order.
  renderNode(node, depth, lookup, state);
  // Close an off-screen section that remains open after the traversal ends.
  if (state.currentZone) state.lines.push('=== END OFF-SCREEN ===');
  return state.lines.join('\n');
}

/** In depth, priority is given to checking for differences among descendants; the incremental mode uses it as a whole to skip a completely unchanged sub-tree. */
function hasDiffDescendant(node: EnhancedDOMTreeNode): boolean {
  for (const child of getAllChildren(node)) {
    if (child.renderInfo?.diffStatus || hasDiffDescendant(child)) return true;
  }
  return false;
}

function renderNode(
  node: EnhancedDOMTreeNode | null,
  depth: number,
  lookup: Map<string, EnhancedDOMTreeNode> | undefined,
  state: RenderState,
): void {
  if (!node) return;

  const renderInfo = node.renderInfo;

  // Step 1 : Only the top node, extended mouth node, removed node, hidden primary control or select option are eligible for output.
  const shouldRender =
    renderInfo &&
    (renderInfo.isTopElement ||
      renderInfo.expandedViewportPosition !== undefined ||
      renderInfo.diffStatus === 'removed' ||
      renderInfo.isVisuallyHiddenNativeControl ||
      renderInfo.isSelectOption);

  // A non-rendered structural wrapper stays transparent: render its children at the same depth.
  if (!shouldRender) {
    for (const child of getAllChildren(node)) {
      renderNode(child, depth, lookup, state);
    }
    return;
  }

  // In incremental mode, skip a subtree only when neither this node nor any descendant has a diff; ancestors of changed descendants still render as context.
  if (
    state.incrementalDiff &&
    !renderInfo.diffStatus &&
    !hasDiffDescendant(node)
  ) {
    return;
  }

  // Collapse left into above and right into below so model-facing off-screen regions use two directions.
  const rawZone = renderInfo.expandedViewportPosition;
  const nodeZone =
    rawZone === 'left' ? 'above' : rawZone === 'right' ? 'below' : rawZone;

  // Step 4 : When the node area changes, close the old outside screen and open the new outside screen area as necessary; undefined indicates the current window of view.
  if (nodeZone !== state.currentZone) {
    if (state.currentZone) state.lines.push('=== END OFF-SCREEN ===');
    if (nodeZone) {
      const scrollIdx = renderInfo.scrollContainerIndex ?? 0;
      const suffix = ` [container:${scrollIdx}]`;
      state.lines.push(
        `=== OFF-SCREEN ${nodeZone}${suffix} (scroll to reveal these elements) ===`,
      );
    }
    state.currentZone = nodeZone;
  }

  const prefix =
    renderInfo.diffStatus === 'added'
      ? '+|'
      : renderInfo.diffStatus === 'removed'
        ? '-|'
        : '';

  const depthStr = '\t'.repeat(depth);

  if (node.nodeType === NodeType.ELEMENT_NODE) {
    // Step 5A: determine the tag before deciding whether to emit aggregated text and whitelisted attributes.
    const tagName = node.nodeName.toLowerCase();
    const isVisualTop = isVisualTopNode(node);
    const isStructuralChild = STRUCTURAL_CHILD_TAGS.has(tagName);
    const nextDepth = depth + 1;
    let text = '';
    let attrsStr = '';

    // The normal structure shell does not aggregate text; the candidate, top visual elements and their structural sublabels have their own text/ attribute expression.
    if (renderInfo.isCandidate || isVisualTop || isStructuralChild) {
      // Upstream caches, such as removed, can be reused, otherwise they will revert to the text collected at the next candidate boundary.
      text =
        renderInfo.cachedText !== undefined
          ? renderInfo.cachedText
          : getAllTextTillNextCandidate(node);
      ({ attrsStr, text } = buildAttributesString(node, text));
    }

    // The interactive numbering is in front and the visual number is in the back; the same visual candidate can have both at the same time, and the two markers will not overlay each other.
    const interactionIndicator =
      renderInfo.highlightIndex !== undefined
        ? renderInfo.isFill
          ? `<${renderInfo.highlightIndex}>`
          : `[${renderInfo.highlightIndex}]`
        : '';
    const viewIndicator =
      isVisualTop && renderInfo.isTopElement
        ? `[view:${encodeViewId(node.backendNodeId)}]`
        : '';
    const indicator = `${interactionIndicator}${viewIndicator}`;

    // Properties exist to fill spaces behind tab names; the outside text is kept up to 50 UTF-16 yards, where the text is not cut.
    const baselineStr = attrsStr ? ` ${attrsStr}>` : '>';
    const truncatedText =
      nodeZone && text.length > MAX_OFFSCREEN_TEXT
        ? text.slice(0, MAX_OFFSCREEN_TEXT) + '...'
        : text;
    const textStr = truncatedText ? ` ${truncatedText} ` : '';
    const closeTagStr = `</${tagName}>`;

    // Final display line = Indent + Discrepancies Prefix + Number + Class HTML; historical interactive notes are added later and do not belong to renderedLine.
    const line = `${depthStr}${prefix}${indicator}<${tagName}${baselineStr}${textStr}${closeTagStr}`;
    // renderedLine purposely excludes indentation, differential prefixes and numbering, enabling it to display stable fingerprints of the same element as a cross-snapshot fingerprint.
    renderInfo.renderedLine = `<${tagName}${baselineStr}${textStr}${closeTagStr}`;
    const originalNode = lookup?.get(nodeKey(node));
    if (originalNode?.renderInfo) {
      // This pass renders a pruned copy; synchronize renderedLine back to the cached original through the frameId/backendNodeId composite key.
      originalNode.renderInfo.renderedLine = `<${tagName}${baselineStr}${textStr}${closeTagStr}`;
    }

    // Step 6A: Mark history interactive. Press backendNodeId for the record, and then request renderedLine to be saved as it is.
    // The old record is still considered compatible when it is not renderedLine; this preserves the old data while avoiding mislabelling new content after ID.
    let annotation = '';
    if (renderInfo.isCandidate && state.interactionMap) {
      const allInteractions = state.interactionMap.get(node.backendNodeId);
      if (allInteractions) {
        const currentRendered = renderInfo.renderedLine;
        const matched = allInteractions.filter(
          r => !r.renderedLine || r.renderedLine === currentRendered,
        );
        if (matched.length > 0) {
          annotation = ` ${buildInteractionAnnotation(matched)}`;
        }
      }
    }

    state.lines.push(`${line}${annotation}`);

    // Step 7 A: When a candidate has existing properties or text outside the screen, a line summary is used to represent the whole subtree; if there is a subnode, the omission is used as `... '.
    // The removed node must continue to be returned in order to fully present the deletion difference and therefore do not take this external cut.
    if (
      nodeZone &&
      renderInfo.isCandidate &&
      (attrsStr || text) &&
      renderInfo.diffStatus !== 'removed'
    ) {
      if (getAllChildren(node).length > 0) {
        state.lines.push(`${depthStr}\t ...`);
      }
      return;
    }

    // Normal elements are prioritized in childrenNodes depths; only the actual output element allows the child node to indent one level.
    for (const child of getAllChildren(node)) {
      renderNode(child, nextDepth, lookup, state);
    }
  } else if (node.nodeType === NodeType.TEXT_NODE) {
    // Step 5 B: If the text has been assembled by a candidate/visible ancestors, the text will be passed, otherwise trim will be exported as a separate line, with the same maximum remaining outside the screen 50.
    if (!hasCandidateOrVisualAncestor(node)) {
      let textContent = node.nodeValue?.trim() ?? '';
      if (nodeZone && textContent.length > MAX_OFFSCREEN_TEXT) {
        textContent = textContent.slice(0, MAX_OFFSCREEN_TEXT) + '...';
      }
      if (textContent) {
        state.lines.push(`${depthStr}${prefix}${textContent}`);
        // As in the case of element nodes, both the cropping copy and the original tree are recorded for the use of differences and historical interactive logic.
        renderInfo.renderedLine = textContent;
        const originalNode = lookup?.get(nodeKey(node));
        if (originalNode?.renderInfo) {
          originalNode.renderInfo.renderedLine = textContent;
        }
      }
    }
  } else if (node.nodeType === NodeType.DOCUMENT_FRAGMENT_NODE) {
    // Shadow DOM document clips do not themselves output labels, maintain the same child node depth and visually integrate directly into the host hierarchy.
    for (const child of getAllChildren(node)) {
      renderNode(child, depth, lookup, state);
    }
  } else {
    // The other node types also serve only as transparent containers, do not export themselves and continue to recur at the same depth subnode.
    for (const child of getAllChildren(node)) {
      renderNode(child, depth, lookup, state);
    }
  }
}
