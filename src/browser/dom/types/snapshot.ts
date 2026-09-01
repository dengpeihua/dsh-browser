/**
 * Module overview
 * Responsibility: snapshot types for converting CDP page data into stable snapshots and model-facing text.
 * Usage: Called for the active tab by the browser manager and observe, interact, and scroll tools; coordinates tree extraction, snapshot caching, stability checks, rendering, and element references.
 * State and failure boundaries: Browser disconnection, frame reconstruction, page instability, and oversized DOMs must all be handled explicitly.
 * Maintenance: Keep CDP nodeId, backendNodeId, and frameId distinct from model-facing elementIndex values; verify adjacent tests and public types after changes.
 */

/**
 * Snapshot-related Type Definitions
 *
 * Types for DOM snapshot data extracted from CDP DOMSnapshot.
 */

import type { DOMRect } from './dom-node';

/**
 * Enhanced snapshot node with extracted layout/style data
 */
export interface EnhancedSnapshotNode {
  // Boolean defaults to false
  isClickable: boolean;

  // Optional properties (only set when have values)
  cursorStyle?: string;
  bounds?: DOMRect;
  clientRects?: DOMRect;
  scrollRects?: DOMRect;
  computedStyles?: Record<string, string>;
  paintOrder?: number;
  stackingContexts?: number;
  inputValue?: string;
}

/**
 * Required computed styles for interactivity and visibility detection
 */
export const REQUIRED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
  'background-color',
  'background-image',
] as const;

/**
 * Snapshot lookup map: backendNodeId -> EnhancedSnapshotNode
 */
export type SnapshotLookup = Map<number, EnhancedSnapshotNode>;

/**
 * Data captured from a single OOPIF (cross-origin iframe) session
 */
export interface OOPIFTreeData {
  sessionId: string;
  frameId: string;
  frameUrl: string;
  /** backendNodeId of the IFRAME element in the main DOM tree */
  ownerBackendNodeId: number;
  snapshot: import('./cdp').DOMSnapshot.CaptureSnapshotResponse;
  domTree: import('./cdp').DOM.GetDocumentResponse;
  axTree: import('./cdp').Accessibility.GetFullAXTreeResponse;
}

/**
 * All trees fetched from CDP for a target
 */
export interface TargetAllTrees {
  snapshot: import('./cdp').DOMSnapshot.CaptureSnapshotResponse;
  domTree: import('./cdp').DOM.GetDocumentResponse;
  axTree: import('./cdp').Accessibility.GetFullAXTreeResponse;
  devicePixelRatio: number;
  /** DOM data from cross-origin iframe sessions */
  oopifTrees?: OOPIFTreeData[];
}
