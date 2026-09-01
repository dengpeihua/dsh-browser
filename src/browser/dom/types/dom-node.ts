/**
 * Module overview
 * Responsibility: DOM node types for converting CDP page data into stable snapshots and model-facing text.
 * Usage: Called for the active tab by the browser manager and observe, interact, and scroll tools; coordinates tree extraction, snapshot caching, stability checks, rendering, and element references.
 * State and failure boundaries: Browser disconnection, frame reconstruction, page instability, and oversized DOMs must all be handled explicitly.
 * Maintenance: Keep CDP nodeId, backendNodeId, and frameId distinct from model-facing elementIndex values; verify adjacent tests and public types after changes.
 *
 * File execution order and calculation logic (Run-time)
 * 1) The file itself does not have a running time code, only enumerates/types/ constants, and is compiled and translated into a type declaration and is permanently stored.
 * 2 Other modules load this document and then generate run-time objects.
 * 3 DOM snapshot, AX interactive calculations occur at builder and service layers; they assemble the results only in the field form here.
 * Key data streams: CDP raw tree - DOM/AX/synthesis of snapshots - > Generate EnhancedDOMTreeNode - > Render/routing layers to read renderInfo, xpath, boundaryAncestors, contentDocument
 * If 5 is iframe/OOPIF : contentDocument / oopifSessionId / boundaryAncestors written at the build stage; the follow-up tool relies on them to click, scroll and quote back.
 */

/**
 * Enhance DOM tree node type
 *
 * DOM, Auxiliary Accessibility (AX) and Core Type definitions after integration of snapshot data.
 */

import type { EnhancedAXNode } from './ax';
import type { EnhancedSnapshotNode } from './snapshot';

/**
 * Node type defined by DOM
 */
export enum NodeType {
  ELEMENT_NODE = 1,
  ATTRIBUTE_NODE = 2,
  TEXT_NODE = 3,
  CDATA_SECTION_NODE = 4,
  ENTITY_REFERENCE_NODE = 5,
  ENTITY_NODE = 6,
  PROCESSING_INSTRUCTION_NODE = 7,
  COMMENT_NODE = 8,
  DOCUMENT_NODE = 9,
  DOCUMENT_TYPE_NODE = 10,
  DOCUMENT_FRAGMENT_NODE = 11,
  NOTATION_NODE = 12,
}

/**
 * ShadowRoot Type
 */
export type ShadowRootType = 'user-agent' | 'open' | 'closed';

/**
 * Rectangular structure (location and dimensions) for recording geometry of elements
 */
export interface DOMRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * DOM, AX and Snapshot enhanced tree festivals Points
 */
export interface EnhancedDOMTreeNode {
  // Identity information (required)
  nodeId: number;
  backendNodeId: number;
  nodeType: NodeType;
  nodeName: string;
  nodeValue: string;
  attributes: Record<string, string>;
  uuid: string;

  // Absolute position (folded frame offset)
  absolutePosition?: DOMRect;

  // Context Frame
  targetId?: string;
  frameId?: string;

  // Trees carried in sub-document (iframe)
  contentDocument?: EnhancedDOMTreeNode;

  // Shadow DOM
  shadowRootType?: ShadowRootType;
  shadowRoots?: EnhancedDOMTreeNode[];

  // Auxiliary accessibility data (reserved for subsequent use, current detection chain not directly consumed)
  axNode?: EnhancedAXNode;

  // Snapshot Data
  snapshotNode?: EnhancedSnapshotNode;

  // Filtered attributes (global set plus allowlist).
  whitelistedAttributes?: Record<string, string>;

  // Rendering information (calculated by DomService)
  renderInfo: RenderInfo;

  // Boundary ancestors from the root to this node, including iframe and shadow boundaries.
  boundaryAncestors?: BoundaryAncestor[];

  // Complete XPath (includes [SHADOW]/[IFRAME] Boundary prefix)
  xpath?: string;
  /** Temporary build-period fields only: written at build stage, ultimately consumed by assignXPaths() */
  _xpathPrefix?: string;

  // OOPIF Session (cross-domain iframe subprocess tree written here)
  oopifSessionId?: string;

  // Tree Structure Navigator
  parentNode?: EnhancedDOMTreeNode;
  childrenNodes?: EnhancedDOMTreeNode[];
}

/**
 * An ancestor that introduces an iframe or shadow-root boundary.
 */
interface BoundaryAncestor {
  backendNodeId: number;
  type: 'iframe' | 'shadow';
}

/**
 * Rendering information for DOM node
 * Include all properties required to render HTML and to be selected for judgment
 */
interface RenderInfo {
  isVisible: boolean;
  isInteractive: boolean;
  /** Mark isInteractive as the true/false cause of determination */
  interactiveReason?: string;
  isTopElement: boolean;
  isShadowHost: boolean;
  isIframeHost: boolean;
  isCandidate?: boolean;
  isFill?: boolean;
  /** Original control hidden by UI frame (e. g. replace with checkbox/radio style) */
  isVisuallyHiddenNativeControl?: boolean;
  isDuplicateListener?: boolean;
  isListenerHost?: boolean;
  /** Holds candidate backendNodeId for a click tap */
  listenerHostId?: number;
  /** Click to listen to the signature, e. g. native:scriptId:line:col or framework:handler ` */
  clickListenerSignatures?: string[];
  highlightIndex?: number;
  /** The position of the element relative to the mouth in the spread range */
  expandedViewportPosition?: 'above' | 'below' | 'left' | 'right';
  /** Whether or not to be a scrollable container (as judged by the scrollRects/clientRects + overflow rule) */
  isScrollable?: boolean;
  /** Whether or not to be a lateral scrollable container (from subnode extension) */
  isHorizontalScroll?: boolean;
  /** Recent Scrollable ancestor backendNodeId */
  scrollableContainerId?: number;
  /** Are the elements select */
  isSelect?: boolean;
  /** Whether or not to stand for option */
  isSelectOption?: boolean;
  /** Whether this node is recognized as an overlay. */
  isOverlay?: boolean;
  /** Whether this candidate is blocked by an overlay such as a modal or dialog. */
  isBlockedByOverlay?: boolean;
  // Debug information for top candidate recognition
  hitBackendNodeId?: number;
  ancestorBackendIds?: number[];
  /** Debug information: Reason why nodes have been cut ( debug copy tree only set) */
  pruneReason?: string;
  /** Scroll container number of the current extension node */
  scrollContainerIndex?: number;
  /** DOMSpecify the difference in comparison */
  diffStatus?: 'added' | 'removed';
  /** Reasons for variance */
  diffReason?: string;
  /** Anticipated text of the removed node (without sub-trees when rendered) */
  cachedText?: string;
  /** Elements written at HTML line */
  renderedLine?: string;
}

/**
 * Marks in the cache recording the interaction of elements (click/input/select).
 */
export interface InteractionRecord {
  backendNodeId: number;
  action: 'click' | 'input' | 'select';
  renderedLine?: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Set of HTML tags considered interactive
 */
export const INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'a',
  'details',
  'summary',
  'option',
  'optgroup',
]);

/**
 * An interactive ARIA role set
 */
export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'option',
  'radio',
  'checkbox',
  'tab',
  'textbox',
  'combobox',
  'slider',
  'spinbutton',
  'searchbox',
  'listbox',
]);
