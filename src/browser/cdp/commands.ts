/**
 * High-level CDP data collection.
 *
 * getAllTrees collects DOMSnapshot, DOM, accessibility, and layout data in
 * parallel, limits iframe snapshot growth, computes devicePixelRatio, and then
 * appends optional OOPIF trees. Main-tree failures reject the operation; AX and
 * OOPIF enrichment may fall back without discarding valid main-page data.
 * Form-property injection runs before snapshots so live control state is visible.
 */

import type { CDPClient } from './client';
import type { OOPIFManager } from './oopif-manager';
import type {
  DOMSnapshot,
  DOM,
  Accessibility,
  Page,
  Runtime,
} from '../dom/types/cdp';
import type { TargetAllTrees } from '../dom/types/snapshot';
import { REQUIRED_COMPUTED_STYLES } from '../dom/types/snapshot';

/**
 * DOM command sealer extracted from CDP.
 */
export class CDPCommands {
  constructor(private client: CDPClient) {}

  /**
   * Parallel access to all tree and layout data required for the current page: DOM Snapshot, DOM Tree, AX Accessible Tree and visual indicators.
   * The order of implementation is:
   * Parameters for resolution (maxIframes, timeout, oopifManager);
   * 2) Promise.all and issuing 4 core requests;
   * 3) Crop snapshot.documents to prevent iframe data expansion;
   * 4) Calculate devicePixelRatio based on Page.getLayoutMetrics;
   * assembly TargetAllTrees;
   * 6) Add an extension tree based on OOPIFManager (in case of failure, fallback silently);
   * 7) returns the final result.
   */
  async getAllTrees(options?: {
    maxIframes?: number;
    timeout?: number;
    oopifManager?: OOPIFManager;
  }): Promise<TargetAllTrees> {
    const { maxIframes = 100, timeout = 10000, oopifManager } = options ?? {};

    // Four data are not dependent on each other, using Promise.all to send the CDP command in parallel; failure of any key command will make the master collection a failure.
    const [snapshot, domTree, axTree, metrics] = await Promise.all([
      this.captureSnapshot({ timeout }),
      this.getDocument({ timeout }),
      this.getAccessibilityTreeForAllFrames({ timeout }),
      this.getLayoutMetrics({ timeout }),
    ]);

    // Limit the number of documents in the snapshot to avoid a loss of control over the size of the data when the page contains a large number iframe.
    if (snapshot.documents.length > maxIframes) {
      // maxIframes documents before silent interception, do not throw excess iframe as an error.
      snapshot.documents = snapshot.documents.slice(0, maxIframes);
    }

    // Calculates the pixel ratio of the device based on the width of the physical view and the width of the CSS view.
    const devicePixelRatio = this.calculateDevicePixelRatio(metrics);

    const result: TargetAllTrees = {
      snapshot,
      domTree,
      axTree,
      devicePixelRatio,
    };

    // If the manager is available and OOPIF (cross-process iframe), the separate tree is added after the main page data.
    if (oopifManager?.hasOOPIFs()) {
      try {
        result.oopifTrees = await oopifManager.captureAllOOPIFTrees();
      } catch (error) {
        // OOPIF is additional information: silently allowed to fall back when collection failed, returning to the acquired main page tree.
      }
    }

    return result;
  }

  /**
   * Catch DOM snapshot.
   * Specifies the calculation style and geometry information you want, and then collects it by retrying the CDP command; the default single timeout 15 seconds, and an additional retry 2 times.
   */
  async captureSnapshot(options?: {
    timeout?: number;
  }): Promise<DOMSnapshot.CaptureSnapshotResponse> {
    const params = {
      computedStyles: [...REQUIRED_COMPUTED_STYLES],
      includePaintOrder: true,
      includeDOMRects: true,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    };

    return this.client.sendCommandWithRetry<DOMSnapshot.CaptureSnapshotResponse>(
      'DOMSnapshot.captureSnapshot',
      params,
      {
        timeout: options?.timeout ?? 15000,
        maxRetries: 2,
      },
    );
  }

  /**
   * Get the full DOM document tree.
   * depth Defaults -1 for unlimited depth; pierce Defaults true for attempting to penetrate borders such as iframe and shadow root.
   */
  async getDocument(options?: {
    depth?: number;
    pierce?: boolean;
    timeout?: number;
  }): Promise<DOM.GetDocumentResponse> {
    const params = {
      depth: options?.depth ?? -1,
      pierce: options?.pierce ?? true,
    };

    return this.client.sendCommand<DOM.GetDocumentResponse>(
      'DOM.getDocument',
      params,
      options?.timeout ?? 10000,
    );
  }

  /**
   * Access all AX (Accessibility, accessible) trees.
   * In the order of implementation, read frame Tree - > Recursive collection frameId - > Parallel collection of AX Trees - > Merge all nodes.
   * Replace the individual frame with an empty node when the individual frame fails; also return to an empty tree when the whole process fails so that the DOM main process can continue.
   */
  async getAccessibilityTreeForAllFrames(options?: {
    timeout?: number;
  }): Promise<Accessibility.GetFullAXTreeResponse> {
    try {
      // The frame level must be obtained before any subsequent request for a frame tree can be made.
      const frameTree = await this.getFrameTree({ timeout: options?.timeout });

      // From the root frame to the root childFrames to collect each valid frameId.
      const frameIds: string[] = [];
      const collectFrameIds = (node: Page.FrameTree) => {
        if (node.frame?.id) {
          frameIds.push(node.frame.id);
        }
        if (node.childFrames) {
          node.childFrames.forEach(collectFrameIds);
        }
      };
      collectFrameIds(frameTree.frameTree);

      // AX queries for each frame are not dependent on each other and are therefore sent in parallel; fallbacks to an empty node list when a single query fails.
      const axTreePromises = frameIds.map(frameId =>
        this.client
          .sendCommand<Accessibility.GetFullAXTreeResponse>(
            'Accessibility.getFullAXTree',
            { frameId },
            options?.timeout ?? 10000,
          )
          .catch(() => ({ nodes: [] })),
      );

      const axTrees = await Promise.all(axTreePromises);

      // Combine the nodes flattened returns of each frame into a AX node array.
      const mergedNodes = axTrees.flatMap(tree => tree.nodes);

      return { nodes: mergedNodes };
    } catch (error) {
      // AX information is not necessary to generate base DOM and returns empty node arrays silently when the overall operation fails.
      return { nodes: [] };
    }
  }

  /**
   * Get the frame tree on the page and provide frameId for subsequent frame data.
   */
  async getFrameTree(options?: {
    timeout?: number;
  }): Promise<Page.GetFrameTreeResponse> {
    return this.client.sendCommand<Page.GetFrameTreeResponse>(
      'Page.getFrameTree',
      {},
      options?.timeout ?? 10000,
    );
  }

  /**
   * Acquiring page layout and visual indicators, mainly for device pixels and for top coordinate processing.
   */
  async getLayoutMetrics(options?: {
    timeout?: number;
  }): Promise<Page.GetLayoutMetricsResponse> {
    return this.client.sendCommand<Page.GetLayoutMetricsResponse>(
      'Page.getLayoutMetrics',
      {},
      options?.timeout ?? 10000,
    );
  }

  /**
   * Computes device pixels based on layout indicators.
   * When both the physical and CSS visions are present and CSS width is greater than 0 return the ratio of the widths, otherwise the security fallback is 1.
   */
  private calculateDevicePixelRatio(
    metrics: Page.GetLayoutMetricsResponse,
  ): number {
    const visualViewport = metrics.visualViewport;
    const cssVisualViewport = metrics.cssVisualViewport;

    if (visualViewport && cssVisualViewport) {
      const deviceWidth = visualViewport.clientWidth;
      const cssWidth = cssVisualViewport.clientWidth;

      if (cssWidth > 0) {
        return deviceWidth / cssWidth;
      }
    }

    return 1.0;
  }

  /**
   * Direct acquisition device pixels: Read layout indicators before computing; return the default value 1 when the query fails, avoiding the interruption of the coordinate conversion process.
   */
  async getDevicePixelRatio(): Promise<number> {
    try {
      const metrics = await this.getLayoutMetrics();
      return this.calculateDevicePixelRatio(metrics);
    } catch {
      return 1.0;
    }
  }

  /**
   * Execute the JavaScript expression in the current page context.
   * Default requests CDP to return the result by value; if the response contains exceptionDetails converts the page script abnormally to a visible error by the caller.
   */
  async evaluate<T = unknown>(
    expression: string,
    options?: {
      returnByValue?: boolean;
      timeout?: number;
    },
  ): Promise<T> {
    const params = {
      expression,
      returnByValue: options?.returnByValue ?? true,
    };

    const response = await this.client.sendCommand<Runtime.EvaluateResponse>(
      'Runtime.evaluate',
      params,
      options?.timeout ?? 10000,
    );

    if (response.exceptionDetails) {
      throw new Error(
        `[CDP] JavaScript evaluation failed: ${response.exceptionDetails.text}`,
      );
    }

    return response.result.value as T;
  }

  /**
   * Copy each select element's current selected text into its value attribute so DOM snapshots record the live selection.
   * This method is called before captureSnapshot; each round of snapshots re-covers these properties.
   */
  async injectSelectValues(): Promise<void> {
    try {
      await this.evaluate(`
        document.querySelectorAll('select').forEach(sel => {
          const idx = sel.selectedIndex;
          if (idx >= 0 && sel.options[idx]) {
            sel.setAttribute('value', sel.options[idx].text);
          }
        })
      `);
    } catch {
      // This is not a critical step: the failure of the injection will only result in the absence of the current value select in the snapshot and will not interrupt the extraction DOM.
    }
  }

  /**
   * Syncs the real-time status of input back to the HTML attribute before generating the snapshot.
   * CDP DOMSnapshot captures properties, rather than real time DOM property and therefore requires visible synchronization checked or value.
   */
  async injectInputValues(): Promise<void> {
    try {
      await this.evaluate(`
        document.querySelectorAll('input').forEach(el => {
          const type = el.type;
          if (type === 'checkbox' || type === 'radio') {
            if (el.checked) el.setAttribute('checked', 'checked');
            else el.removeAttribute('checked');
          } else if (type !== 'file' && type !== 'hidden' && type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image') {
            if (el.value !== el.defaultValue) el.setAttribute('value', el.value);
          }
        })
      `);
    } catch {
      // This is not a critical step: to keep original attributes when synchronization fails and to continue the follow-up snapshot process.
    }
  }

}
