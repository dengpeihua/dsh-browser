/**
 * Enhanced DOM tree construction.
 *
 * The builder joins DOM, accessibility, and snapshot indexes, computes absolute
 * coordinates across frame offsets, attaches Shadow DOM and iframe subtrees, and
 * tags OOPIF nodes with their child session. XPath assignment runs only after
 * the complete sibling structure exists. Failed OOPIF enrichment does not
 * discard a valid main-page tree.
 */

import type { DOM } from '../types/cdp';
import { generateUUID } from '../utils/index';
import { generateXPath } from './xpath';
import { getWhitelistedAttributes } from './attributes';
import type {
  EnhancedDOMTreeNode,
  DOMRect,
  ShadowRootType,
} from '../types/dom-node';
import { NodeType } from '../types/dom-node';
import type { AXTreeLookup } from '../types/ax';
import { buildAXTreeLookup } from '../types/ax';
import type {
  SnapshotLookup,
  TargetAllTrees,
  OOPIFTreeData,
} from '../types/snapshot';
import { buildSnapshotLookup } from '../snapshot/lookup';

/**
 * DOM Tree Build Results
 */
export interface TreeBuildResult {
  root: EnhancedDOMTreeNode;
}

/**
 * DOM Tree Builder
 *
 * The enhanced nodal tree is constructed through DOM tree, accessible tree and snapshot data CDP.
 */
export class DOMTreeBuilder {
  private snapshotLookup: SnapshotLookup;
  private axTreeLookup: AXTreeLookup;
  private enhancedNodeLookup = new Map<number, EnhancedDOMTreeNode>();
  private devicePixelRatio: number;
  /** OOPIF data indexed by the host IFRAME element's ownerBackendNodeId. */
  private oopifByOwner = new Map<number, OOPIFTreeData>();

  constructor(private trees: TargetAllTrees) {
    this.devicePixelRatio = trees.devicePixelRatio;

    // Build Index: First create snapshot index, then construct AX index as the basis for subsequent cross-domain field completion and query
    this.snapshotLookup = buildSnapshotLookup(
      trees.snapshot,
      this.devicePixelRatio,
    );
    this.axTreeLookup = buildAXTreeLookup(trees.axTree.nodes);

    // Press owner backendNodeId to create a OOPIF search table to quickly complete the OOPIF subtree when the main tree is returned to iframe
    if (trees.oopifTrees) {
      for (const oopif of trees.oopifTrees) {
        this.oopifByOwner.set(oopif.ownerBackendNodeId, oopif);
      }
    }
  }

  /**
   * Build Enhancement DOM Tree
   *
   * @paraminitialFrameOffset - Coordinates calculate the initial offset. The OOPIF sub-tree will follow the cumulative deviation of the father iframe and maintain global alignment.
   * @paramxpathPrefix - Optional prefix xpath currently used only for iframe/shadow path adhesion.
   */
  async build(
    initialFrameOffset?: DOMRect,
    xpathPrefix?: string,
  ): Promise<TreeBuildResult> {
    // The whole reinforced tree is first completed and then distributed uniformly XPath; the siblings is not complete during the construction period, and the early indexing is unstable.
    const root = await this.constructEnhancedNode(
      this.trees.domTree.root,
      initialFrameOffset ?? { x: 0, y: 0, width: 0, height: 0 },
      0,
      xpathPrefix ?? '',
    );

    assignXPaths(root);

    return { root };
  }

  /**
   * Recursively construct enhanced DOM tree nodes
   *
   * This corresponds to _construct_enhanced_node in version Python.
   */
  private async constructEnhancedNode(
    node: DOM.Node,
    totalFrameOffset: DOMRect,
    iframeDepth: number,
    xpathPrefix: string,
  ): Promise<EnhancedDOMTreeNode> {
    // frameOffset accumulates parent iframe offsets and subtracts each frame's scroll position
    // to map cross-frame coordinates into the top-level viewport.
    // enhancedNodeLookup is populated before descending so child nodes can safely link back to their parent.
    // Clone the offset to prevent shared mutations from affecting sibling branches.
    const frameOffset = { ...totalFrameOffset };

    // Hit memoization is used directly to avoid repeating the construction of the same nodeId
    if (this.enhancedNodeLookup.has(node.nodeId)) {
      return this.enhancedNodeLookup.get(node.nodeId)!;
    }

    // Take AX node first to enhance subsequent interactive and semantic information coverage
    const axNode = this.axTreeLookup.get(node.backendNodeId) ?? null;

    // Parse the flat CDP attribute array into a map for allowlist filtering and serialization.
    const attributes: Record<string, string> = {};
    if (node.attributes) {
      for (let i = 0; i < node.attributes.length; i += 2) {
        attributes[node.attributes[i]] = node.attributes[i + 1];
      }
    }

    // Parsing shadow root Types
    let shadowRootType: ShadowRootType | null = null;
    if (node.shadowRootType) {
      shadowRootType = node.shadowRootType;
    }

    // Read snapshot structure, get data such as bounds and scrollRects for geometric and interactive calculations
    const snapshotData = this.snapshotLookup.get(node.backendNodeId) ?? null;

    // Calculate absolute position (global coordinates): snapshot.bounds+frameOffset
    let absolutePosition: DOMRect | null = null;
    if (snapshotData?.bounds) {
      absolutePosition = {
        x: snapshotData.bounds.x + frameOffset.x,
        y: snapshotData.bounds.y + frameOffset.y,
        width: snapshotData.bounds.width,
        height: snapshotData.bounds.height,
      };
    }

    // Create enhanced nodes; assigning value fields only and reducing empty field noise
    const whitelistedAttributes = getWhitelistedAttributes(
      node.nodeName,
      attributes,
    );

    const enhancedNode: EnhancedDOMTreeNode = {
      nodeId: node.nodeId,
      backendNodeId: node.backendNodeId,
      nodeType: node.nodeType as NodeType,
      nodeName: node.nodeName,
      nodeValue: node.nodeValue ?? '',
      attributes,
      whitelistedAttributes:
        Object.keys(whitelistedAttributes).length > 0
          ? whitelistedAttributes
          : undefined,
      uuid: generateUUID(),
      renderInfo: {
        isVisible: false,
        isInteractive: false,
        isIframeHost: false,
        isTopElement: false,
        isShadowHost: false,
        isCandidate: false,
        isDuplicateListener: false,
      },
    };

    // Optional attribute by mid-point value to avoid default misdirection
    if (absolutePosition) {
      enhancedNode.absolutePosition = absolutePosition;
    }
    if (node.frameId) {
      enhancedNode.frameId = node.frameId;
    }
    if (shadowRootType) {
      enhancedNode.shadowRootType = shadowRootType;
    }
    if (axNode) {
      enhancedNode.axNode = axNode;
    }
    if (snapshotData) {
      enhancedNode.snapshotNode = snapshotData;
    }

    // Write lookup: Support weight removal and subsequent parentNode backfill
    this.enhancedNodeLookup.set(node.nodeId, enhancedNode);

    // If the parent node already exists, fill back parentNode to guide tree closing
    if (
      node.parentId !== undefined &&
      this.enhancedNodeLookup.has(node.parentId)
    ) {
      enhancedNode.parentNode = this.enhancedNodeLookup.get(node.parentId)!;
    }

    // Save temporary prefix xpath prefix(s) for consolidation after construction to avoid an incorrect count of siblings when not fully constructed
    enhancedNode._xpathPrefix = xpathPrefix;

    // HTML frame node: offset its own scrolling with scrollRects to ensure that the coordinates are returned to the view entry without scrolling coordinates Yes
    if (
      node.nodeType === NodeType.ELEMENT_NODE &&
      node.nodeName === 'HTML' &&
      node.frameId
    ) {
      if (snapshotData?.scrollRects) {
        frameOffset.x -= snapshotData.scrollRects.x;
        frameOffset.y -= snapshotData.scrollRects.y;
      }
    }

    // IFRAME/FRAME Node: First, insert iframe body offset to frameOffset for absolute coordinates of subtrees
    const tagName = node.nodeName.toUpperCase();
    if ((tagName === 'IFRAME' || tagName === 'FRAME') && snapshotData?.bounds) {
      frameOffset.x += snapshotData.bounds.x;
      frameOffset.y += snapshotData.bounds.y;
    }

    // Deal with contentDocument
    if (node.contentDocument) {
      // Co-source iframe: CDP provides contentDocument directly to repeat the current build chain
      const iframePrefix = `${enhancedNode.xpath} [IFRAME] `;
      enhancedNode.contentDocument = await this.constructEnhancedNode(
        node.contentDocument,
        frameOffset,
        iframeDepth + 1,
        iframePrefix,
      );
      enhancedNode.contentDocument.parentNode = enhancedNode;
    } else if (
      (tagName === 'IFRAME' || tagName === 'FRAME') &&
      this.oopifByOwner.has(node.backendNodeId)
    ) {
      // OOPIF: Cross-process iframe needs to capture snapshots and build sub-trees through independent CDP sessions
      // Reuse cumulative frameOffset to ensure that OOPIF subtree position is consistent with main tree
      const oopifData = this.oopifByOwner.get(node.backendNodeId)!;
      try {
        const iframePrefix = `${enhancedNode.xpath} [IFRAME] `;
        const subBuilder = new DOMTreeBuilder({
          snapshot: oopifData.snapshot,
          domTree: oopifData.domTree,
          axTree: oopifData.axTree,
          devicePixelRatio: this.devicePixelRatio,
        });
        const { root: oopifRoot } = await subBuilder.build(
          frameOffset,
          iframePrefix,
        );
        tagOOPIFNodes(oopifRoot, oopifData.sessionId);
        enhancedNode.contentDocument = oopifRoot;
        enhancedNode.contentDocument.parentNode = enhancedNode;
      } catch (error) {
        // OOPIF Silently allowed to fall back when the subtree failed without blocking the return of the main tree
      }
    }

    // Process shadow roots
    if (node.shadowRoots && node.shadowRoots.length > 0) {
      enhancedNode.shadowRoots = [];
      const shadowPrefix = `${enhancedNode.xpath} [SHADOW] `;
      for (const shadowRoot of node.shadowRoots) {
        const shadowRootNode = await this.constructEnhancedNode(
          shadowRoot,
          frameOffset,
          iframeDepth,
          shadowPrefix,
        );
        shadowRootNode.parentNode = enhancedNode;
        enhancedNode.shadowRoots.push(shadowRootNode);
      }
    }

    // Processing Normal children
    if (node.children && node.children.length > 0) {
      enhancedNode.childrenNodes = [];

      // Build a collection of shadow root ID filters the duplicate mounted in children
      const shadowRootNodeIds = new Set<number>();
      if (node.shadowRoots) {
        for (const sr of node.shadowRoots) {
          shadowRootNodeIds.add(sr.nodeId);
        }
      }

      for (const child of node.children) {
        // Skip shadow root Node (disposed in shadowRoots)
        if (shadowRootNodeIds.has(child.nodeId)) {
          continue;
        }

        const childNode = await this.constructEnhancedNode(
          child,
          frameOffset,
          iframeDepth,
          xpathPrefix,
        );
        enhancedNode.childrenNodes.push(childNode);
      }
    }

    return enhancedNode;
  }

  /**
   * Get devicePixelRatio
   */
  getDevicePixelRatio(): number {
    return this.devicePixelRatio;
  }
}

/**
 * Unified distribution of xpath upon completion of tree construction;
 * When parent.childrenNodes is complete, the index can be stabilized.
 */
function assignXPaths(node: EnhancedDOMTreeNode): void {
  const prefix = node._xpathPrefix ?? '';
  const localXpath = generateXPath(node);
  node.xpath = prefix ? `${prefix}${localXpath}` : localXpath;
  delete node._xpathPrefix;

  for (const child of node.childrenNodes ?? []) {
    assignXPaths(child);
  }
  for (const sr of node.shadowRoots ?? []) {
    assignXPaths(sr);
  }
  if (node.contentDocument) {
    assignXPaths(node.contentDocument);
  }
}

/**
 * To OOPIF subtree node sessionId;
 * The downstream is based on which CDP command routes are routed to the context of the correct session.
 */
function tagOOPIFNodes(node: EnhancedDOMTreeNode, sessionId: string): void {
  node.oopifSessionId = sessionId;
  for (const child of node.childrenNodes ?? []) {
    tagOOPIFNodes(child, sessionId);
  }
  for (const sr of node.shadowRoots ?? []) {
    tagOOPIFNodes(sr, sessionId);
  }
  if (node.contentDocument) {
    tagOOPIFNodes(node.contentDocument, sessionId);
  }
}
