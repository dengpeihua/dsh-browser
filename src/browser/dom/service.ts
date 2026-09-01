/**
 * DOM extraction, interaction, rendering, and snapshot-cache service.
 *
 * Composite operations acquire one CDP client scope, refresh OOPIF routing,
 * wait for page stability, synchronize live form state, collect the main and
 * OOPIF trees, and compute render metadata. Cached snapshots retain selector,
 * scroll-container, visual-element, viewport, and interaction data for later
 * actions, diffs, and state restoration. Navigation and teardown invalidate
 * session-scoped protocol handles.
 */

import type { Page } from 'puppeteer-core';
import { CDPClient } from '../cdp/client';
import { CDPCommands } from '../cdp/commands';
import { OOPIFManager } from '../cdp/oopif-manager';
import { DOMTreeBuilder } from './tree/builder';
import { renderToHtml } from './serializer/renderer';
import {
  computeRenderInfo,
  elementFromPoint,
  type ComputeRenderInfoOptions,
} from './tree/render-info';
import {
  buildScrollContainerMap,
  type ScrollContainerMap,
} from './tree/scroll-container';
import {
  buildVisualElementMap,
  type VisualElementMap,
} from './tree/visual-element';
import { pruneTree } from './tree/pruner';
import { createDiffTree, type DiffShow } from './tree/diff';
import { assignAndHighlight, cleanupHighlights, type DOMSelectorMap } from './tree/highlight';
import type {
  DOMRect,
  EnhancedDOMTreeNode,
  InteractionRecord,
} from './types/dom-node';
import {
  copyDomTree,
  flattenDomTree,
  saveDebugJson,
  saveDebugHtml,
  buildNodeKeyLookup,
} from './utils/index';
import { PageSettleMonitor } from './settle-monitor';

interface ScrollContainerPages {
  index: number;
  pagesAbove: number;
  pagesBelow: number;
}

export type ViewportStats = ScrollContainerPages[];

interface DomSnapshot {
  domTree: EnhancedDOMTreeNode;
  selectorMap: DOMSelectorMap;
  scrollContainerMap: ScrollContainerMap;
  visualElementMap: VisualElementMap;
  timestamp: number;
  topElementCount: number;
  navigationIndex?: number;
  url?: string;
  viewportStats?: ViewportStats;
  expand?: number;
  hasOverlay?: boolean;
  interactions?: InteractionRecord[];
}

/**
 * Sustained page change monitor.
 *
 * Reset after withdrawal at DOM and continue to run until the next extraction.
 * The monitor will remain connected by CDP during its life.
 *
 * Life cycle per round Agent:
 * Reset immediately after monitor.reset() <- DOM extraction is completed
 * ...tool execution...
 * monitor.hasChanged() < - Whether re-extracting is required
 * monitor.stop() <- Agent Cessation of session
 */
/**
 * Services.
 *
 * Top-level API combining CDP communication, tree construction, page operations,
 * snapshot caching, and serialization.
 */
export class DomService {
  private client: CDPClient;
  readonly commands: CDPCommands;
  private oopifManager: OOPIFManager;
  private cache = new Map<string, DomSnapshot>();
  private maxCacheSize: number;
  private domIdCounter = 0;
  private domSubCounter = 0;
  private lastNavigationUrl: string | undefined;
  private clientRefCount = 0;
  private settleMonitor: PageSettleMonitor;
  private settleReady: Promise<void>;
  readonly page: Page;

  /**
   * Initialisation order: Save page/client for creating commands and OOPIF manager - > for creating stability monitor -> to enable listening fields by walk.
   * settleReady stores the initialization promise; later acquireClient() calls await it so collection cannot start before monitoring is ready.
   */
  constructor(
    page: Page,
    client: CDPClient,
    maxCacheSize = 10,
  ) {
    this.page = page;
    this.client = client;
    this.commands = new CDPCommands(this.client);
    this.oopifManager = new OOPIFManager();
    this.maxCacheSize = maxCacheSize;
    this.settleMonitor = new PageSettleMonitor(this.client.getDebugger(), {
      enableOOPIFSession: async (sessionId: string) => {
        await this.client
          .sendCommand('Network.enable', {}, 5000, sessionId)
          .catch(() => {});
        await this.client
          .sendCommand('DOM.enable', {}, 5000, sessionId)
          .catch(() => {});
      },
    });
    this.settleReady = this.initSettle();
  }

  /** Holds a client reference for continuous monitoring and allows the Network and DOM events of the main session. */
  private async initSettle(): Promise<void> {
    this.clientRefCount++;
    await this.client.attach();
    await this.client.sendCommand('Network.enable', {}).catch(() => {});
    await this.client.sendCommand('DOM.enable', {}).catch(() => {});
  }

  /** Stop stability monitoring and release its references; shared CDP resources are disposed only after their final owner releases them. */
  async destroySettle(): Promise<void> {
    await this.settleReady.catch(() => {});
    this.settleMonitor.stop();
    this.clientRefCount--;
    if (this.clientRefCount === 0) {
      await this.oopifManager.cleanup();
      await this.client.cleanup();
    }
  }

  /**
   * Removes the previous round of model-numbered overlays before collecting new snapshots and avoids miscalculating the tool's own DIV/text node into page increments.
   * Cleanup removes only tool-owned data-hl-idx attributes, overlays, and listeners;
   * it does not alter the page elements referenced by selectorMap.
   */
  async cleanupHighlightsBeforeSnapshot(): Promise<void> {
    await cleanupHighlights(this.client, this.oopifManager);
  }

  getCachedUrl(domId: string): string | undefined {
    return this.cache.get(domId)?.url;
  }

  getLatestSelectorMap(): DOMSelectorMap | undefined {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.selectorMap;
  }

  getLatestScrollContainerMap(): ScrollContainerMap {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.scrollContainerMap ?? new Map();
  }

  getLatestVisualElementMap(): VisualElementMap {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.visualElementMap ?? new Map();
  }

  getLatestExpand(): number | null {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    return latest?.expand ?? null;
  }

  getScrollContainerNode(index: number): EnhancedDOMTreeNode | undefined {
    return this.getLatestScrollContainerMap().get(index);
  }

  async scrollToOffscreenElementByIndex(
    target: string,
    container: number,
    direction: 'up' | 'down',
  ): Promise<EnhancedDOMTreeNode | undefined> {
    const node = this.findOffscreenNodeByRenderedLine(target, container, direction);
    if (!node) return undefined;
    await this.withClient(() => this.scrollToElement(node));
    return node;
  }

  async scrollToPositionByIndex(
    container: number,
    x: number,
    y: number,
  ): Promise<void> {
    return this.withClient(async () => {
      if (container === 0) {
        await this.evaluate(`window.scrollTo(${x}, ${y})`);
      } else {
        const node = this.getScrollContainerNode(container);
        if (!node) {
          throw new Error(
            `Scroll container [${container}] not found. Check the [container:N] comments in the current DOM.`,
          );
        }
        await this.scrollContainerTo(node, x, y);
      }
    });
  }

  async getScrollInfoByIndex(container: number): Promise<{
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    totalWidth: number;
    totalHeight: number;
  }> {
    return this.withClient(async () => {
      if (container === 0) {
        const metrics = await this.commands.getLayoutMetrics();
        const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
        return {
          scrollX: css.pageX,
          scrollY: css.pageY,
          viewportWidth: css.clientWidth,
          viewportHeight: css.clientHeight,
          totalWidth: metrics.cssContentSize!.width,
          totalHeight: metrics.cssContentSize!.height,
        };
      } else {
        const node = this.getScrollContainerNode(container);
        if (!node) {
          throw new Error(
            `Scroll container [${container}] not found. Check the [container:N] comments in the current DOM.`,
          );
        }
        return this.getContainerScrollInfo(node);
      }
    });
  }

  /**
   * Finds the outer nodes of the mouth by rendering text in the given scscrolling container and direction.
   * Down to below/right and up to above/left; return the first matching node as soon as found.
   */
  /**
   * In the given scscrolling container and direction, the external nodes of the mouth are found according to renderedLine text.
   * down below/right, up above/left for expandedViewportPosition.
   */
  findOffscreenNodeByRenderedLine(
    target: string,
    container: number,
    direction: 'up' | 'down',
  ): EnhancedDOMTreeNode | undefined {
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    if (!latest) return undefined;

    const trimmed = target.trim();
    if (!trimmed) return undefined;

    const downPositions = new Set(['below', 'right']);
    const upPositions = new Set(['above', 'left']);
    const validPositions = direction === 'down' ? downPositions : upPositions;

    const queue: EnhancedDOMTreeNode[] = [latest.domTree];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const ri = node.renderInfo;
      if (
        ri?.renderedLine &&
        (ri.renderedLine.includes(trimmed) ||
          trimmed.includes(ri.renderedLine)) &&
        ri.expandedViewportPosition !== undefined &&
        validPositions.has(ri.expandedViewportPosition) &&
        (ri.scrollContainerIndex ?? 0) === container
      ) {
        return node;
      }
      for (const child of node.childrenNodes ?? []) {
        queue.push(child);
      }
    }
    return undefined;
  }

  /**
   * domId: For continuous snapshots of the same URL, use domN.1, domN.2; URL change the main number to domN + 1.
   */
  generateDomId(): string {
    const currentUrl = this.page.url();
    if (
      this.lastNavigationUrl !== undefined &&
      currentUrl === this.lastNavigationUrl
    ) {
      this.domSubCounter++;
      return `dom${this.domIdCounter}.${this.domSubCounter}`;
    }
    if (this.lastNavigationUrl !== undefined) {
      this.domIdCounter++;
    }
    this.domSubCounter = 0;
    this.lastNavigationUrl = currentUrl;
    return `dom${this.domIdCounter}`;
  }

  /**
   * The expression JavaScript is executed by CDP Runtime.evaluate.
   * It must be called within the life cycle of withClient()
   */
  async evaluate(expression: string): Promise<void> {
    await this.client.sendCommand('Runtime.evaluate', {
      expression,
      awaitPromise: false,
    });
  }

  async evaluateWithReturn(expression: string): Promise<any> {
    const result = await this.client.sendCommand<{
      result: { value?: any; subtype?: string; description?: string };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'Script error');
    }
    return result.result.value;
  }

  /**
   * Moves the scrolling container to absolute position by page JavaScript.
   * It must be called within the life cycle of withClient()
   */
  async scrollContainerTo(
    node: EnhancedDOMTreeNode,
    x: number,
    y: number,
  ): Promise<void> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? (method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand(node.oopifSessionId!, method, params)
      : (method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand(method, params);

    const { object } = (await sendCommand('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    })) as { object: { objectId: string } };

    await sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(x, y) { this.scrollTop = y; this.scrollLeft = x; }`,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    });

    await sendCommand('Runtime.releaseObject', {
      objectId: object.objectId,
    }).catch(() => {});
  }

  /**
   * CDP query the real-time scrolling position, visual size and full size of the scrolling container.
   * It must be called within the life cycle of withClient()
   */
  async getContainerScrollInfo(node: EnhancedDOMTreeNode): Promise<{
    scrollX: number;
    scrollY: number;
    viewportWidth: number;
    viewportHeight: number;
    totalWidth: number;
    totalHeight: number;
  }> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? (method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand(node.oopifSessionId!, method, params)
      : (method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand(method, params);

    const { object } = (await sendCommand('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    })) as { object: { objectId: string } };

    const { result } = (await sendCommand('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() {
        return {
          scrollX: this.scrollLeft,
          scrollY: this.scrollTop,
          viewportWidth: this.clientWidth,
          viewportHeight: this.clientHeight,
          totalWidth: this.scrollWidth,
          totalHeight: this.scrollHeight,
        };
      }`,
      returnByValue: true,
    })) as {
      result: {
        value: {
          scrollX: number;
          scrollY: number;
          viewportWidth: number;
          viewportHeight: number;
          totalWidth: number;
          totalHeight: number;
        };
      };
    };

    await sendCommand('Runtime.releaseObject', {
      objectId: object.objectId,
    }).catch(() => {});

    return result.value;
  }

  /**
   * Click on the coordinates (x, y) by CDP Input.dispatchMouseEvent.
   * Coordinates use CSS pixels relative to the view; the order of execution is to move the mouse, press the left key and release the left key.
   * It must be called within the life cycle of withClient()
   */
  async click(x: number, y: number): Promise<void> {
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  /**
   * Scroll through the event mouseWheel CDP Input.dispatchMouseEvent.
   * Move the mouse first to (x, y) and then send a scrolling event with deltaX/deltaY.
   * It must be called within the life cycle of withClient()
   */
  async scroll(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<void> {
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    await this.client.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  /**
   * Press Enter through CDP Input.dispatchKeyEvent.
   * Simulates the complete button process by keyDown, char and keyUp; it must be called within withClient().
   */
  async pressEnter(): Promise<void> {
    await this.client.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.client.sendCommand('Input.dispatchKeyEvent', {
      type: 'char',
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      unmodifiedText: '\r',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await this.client.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }

  /**
   * Scroll the elements to the centre of the view while supporting OOPIF nodes.
   * It must be called within the life cycle of withClient()
   */
  async scrollToElement(node: EnhancedDOMTreeNode): Promise<void> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? (method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand(node.oopifSessionId!, method, params)
      : (method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand(method, params);

    // In order to execute this element, the page JavaScript can first be interpreted as objectId.
    let resolveResult: { object: { objectId?: string } };
    try {
      resolveResult = (await sendCommand('DOM.resolveNode', {
        backendNodeId: node.backendNodeId,
      })) as { object: { objectId?: string } };
    } catch (e) {
      // Node may have been updated with the page; the scroll ends silently when the resolution fails.
      return;
    }

    const objectId = resolveResult.object?.objectId;
    if (!objectId) {
      // Could not continue operating elements without objectId.
      return;
    }

    await sendCommand('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function() {
        var el = this.nodeType === 3 ? this.parentElement : this;
        if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      }`,
      returnByValue: true,
    });

    // Releases a remote object after the operation has been completed to avoid keeping the handle in the browser process for long periods.
    await sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
  }

  /**
   * Select one of the original option on the page context DOM API.
   * After selection, dispatch input and change events to synchronize framework state with the native DOM; call this only within withClient().
   */
  async selectOption(node: EnhancedDOMTreeNode): Promise<{
    value: string;
    text: string;
    multiple: boolean;
  }> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? <T>(method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
      : <T>(method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand<T>(method, params);

    const resolved = await sendCommand<{
      object?: { objectId?: string };
    }>('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    });

    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error(
        `Option element no longer exists in the page (backendNodeId: ${node.backendNodeId}).`,
      );
    }

    try {
      const result = await sendCommand<{
        result?: {
          value?: {
            ok: boolean;
            error?: string;
            value?: string;
            text?: string;
            multiple?: boolean;
          };
        };
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function() {
          const option = this;
          if (!(option instanceof HTMLOptionElement)) {
            return { ok: false, error: 'Target is not an option element' };
          }
          if (option.disabled) {
            return { ok: false, error: 'Option is disabled' };
          }

          const select = option.closest('select');
          if (!(select instanceof HTMLSelectElement)) {
            return { ok: false, error: 'No parent select element found' };
          }
          if (select.disabled) {
            return { ok: false, error: 'Select element is disabled' };
          }

          if (select.multiple) {
            option.selected = true;
          } else {
            const valueSetter = Object.getOwnPropertyDescriptor(
              HTMLSelectElement.prototype,
              'value',
            )?.set;
            if (valueSetter) {
              valueSetter.call(select, option.value);
            } else {
              select.value = option.value;
            }
            option.selected = true;
          }

          select.dispatchEvent(new Event('input', { bubbles: true }));
          select.dispatchEvent(new Event('change', { bubbles: true }));

          return {
            ok: true,
            value: option.value,
            text: option.textContent ? option.textContent.trim() : '',
            multiple: select.multiple,
          };
        }`,
        returnByValue: true,
      });

      const payload = result.result?.value;
      if (!payload?.ok) {
        throw new Error(payload?.error ?? 'Failed to select option');
      }

      return {
        value: payload.value ?? '',
        text: payload.text ?? '',
        multiple: payload.multiple ?? false,
      };
    } finally {
      await sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }

  /**
   * Set values for controls that are not suitable for keyboard text, such as range, color, date etc.
   * Original input uses property setter to trigger a response update such as React; ARIA slider is adjusted by a directional event.
   * It must be called within the life cycle of withClient()
   */
  async setInputValue(node: EnhancedDOMTreeNode, value: string): Promise<void> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    const sendCommand = node.oopifSessionId
      ? <T>(method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
      : <T>(method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand<T>(method, params);

    const resolved = await sendCommand<{
      object?: { objectId?: string };
    }>('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
    });

    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error(
        `Element no longer exists in the page (backendNodeId: ${node.backendNodeId}).`,
      );
    }

    const isAriaSlider = node.attributes?.role === 'slider';

    try {
      const result = await sendCommand<{
        result?: { value?: { ok: boolean; error?: string } };
      }>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: isAriaSlider
          ? `function(newValue) {
            // ARIA slider: Focus first, then simulate the direction key and move gradually to the target value.
            this.focus();
            const min = parseFloat(this.getAttribute('aria-valuemin') ?? '0');
            const max = parseFloat(this.getAttribute('aria-valuemax') ?? '100');
            const step = parseFloat(this.getAttribute('aria-valuestep') ?? '1');
            const current = parseFloat(this.getAttribute('aria-valuenow') ?? String(min));
            const target = Math.max(min, Math.min(max, parseFloat(newValue)));
            const steps = Math.round((target - current) / step);
            const key = steps > 0 ? 'ArrowRight' : 'ArrowLeft';
            for (let i = 0; i < Math.abs(steps); i++) {
              this.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
            }
            return { ok: true };
          }`
          : `function(newValue) {
            // Original input: Call original property setter to trigger a responsive update of the framework.
            const proto = Object.getPrototypeOf(this);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
              || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) {
              setter.call(this, newValue);
            } else {
              this.value = newValue;
            }
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }`,
        arguments: [{ value }],
        returnByValue: true,
      });

      const payload = result.result?.value;
      if (!payload?.ok) {
        throw new Error(payload?.error ?? 'Failed to set input value');
      }
    } finally {
      await sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  }

  /**
   * Gets absolute real-time position of node by CDP DOM.getBoxModel.
   * The calculation is the same as absolutePosition: the boundary of the element in itself frame plus the deviation of the host at each level iframe.
   * It must be called within the life cycle of withClient()
   */
  async getElementRect(node: EnhancedDOMTreeNode): Promise<DOMRect> {
    if (node.oopifSessionId) await this.ensureOOPIF();
    // First obtains the boundary of the element within which it belongs by frame.
    const sendCommand = node.oopifSessionId
      ? <T>(method: string, params?: Record<string, unknown>) =>
          this.oopifManager.sendCommand<T>(node.oopifSessionId!, method, params)
      : <T>(method: string, params?: Record<string, unknown>) =>
          this.client.sendCommand<T>(method, params);

    let result: { model: { border: number[]; content: number[] } };
    try {
      result = await sendCommand<{
        model: { border: number[]; content: number[] };
      }>('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    } catch (e) {
      throw new Error(
        `Element no longer exists in the page (backendNodeId: ${node.backendNodeId}). The page may have changed since the last DOM snapshot.`,
      );
    }

    if (!result?.model?.border) {
      throw new Error(
        `Element no longer exists in the page (backendNodeId: ${node.backendNodeId}). The page may have changed since the last DOM snapshot.`,
      );
    }
    // Use border box to match the reported border calibre of DOMSnapshot.
    // The quadrilateral point sequence is not guaranteed to be fixed, so the smallest outer rectangle is calculated on the basis of all four points.
    const q = result.model.border;
    const boundsInFrame: DOMRect = {
      x: Math.min(q[0], q[2], q[4], q[6]),
      y: Math.min(q[1], q[3], q[5], q[7]),
      width:
        Math.max(q[0], q[2], q[4], q[6]) - Math.min(q[0], q[2], q[4], q[6]),
      height:
        Math.max(q[1], q[3], q[5], q[7]) - Math.min(q[1], q[3], q[5], q[7]),
    };

    // Walk all over parentNode and add all levels iframe; the algorithm corresponds to frameOffset.
    let offsetX = 0;
    let offsetY = 0;
    let current = node.parentNode;
    while (current) {
      const tag = current.nodeName.toUpperCase();
      if (tag === 'IFRAME' || tag === 'FRAME') {
        // Get iframe host element in real time position in its parent frame.
        const iframeSend = current.oopifSessionId
          ? <T>(method: string, params?: Record<string, unknown>) =>
              this.oopifManager.sendCommand<T>(
                current!.oopifSessionId!,
                method,
                params,
              )
          : <T>(method: string, params?: Record<string, unknown>) =>
              this.client.sendCommand<T>(method, params);
        try {
          const iframeResult = await iframeSend<{
            model: { content: number[] };
          }>('DOM.getBoxModel', { backendNodeId: current.backendNodeId });
          if (iframeResult?.model?.content) {
            const iq = iframeResult.model.content;
            offsetX += iq[0];
            offsetY += iq[1];
          }
        } catch {
          // Back to absolute cache position in the snapshot when real-time query failed.
          if (current.absolutePosition) {
            offsetX += current.absolutePosition.x;
            offsetY += current.absolutePosition.y;
          }
        }
      }
      current = current.parentNode;
    }

    return {
      x: boundsInFrame.x + offsetX,
      y: boundsInFrame.y + offsetY,
      width: boundsInFrame.width,
      height: boundsInFrame.height,
    };
  }

  /**
   * truncate the page area by CDP Page.captureScreenshot without scrolling first.
   * clip Use the absolute CSS pixel coordinates of the page instead of the relative coordinates of the mouth of view; they must be called within withClient().
   */
  async captureClip(clip: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<string> {
    const result = await this.client.sendCommand<{ data: string }>(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 80,
        clip: { ...clip, scale: 1 },
      },
    );
    return result.data;
  }

  /**
   * Use absolutePosition of the node to recheck whether it is still at the top of the click position.
   * The coordinates are the same as the checkTopElements used to generate the snapshot; they must be called within withClient().
   */
  async hitTestAtPoint(node: EnhancedDOMTreeNode): Promise<boolean> {
    const pos = node.absolutePosition;
    if (!pos) return true;

    const centerX = Math.round(pos.x + pos.width / 2);
    const centerY = Math.round(pos.y + pos.height / 2);

    const sessionId = node.oopifSessionId
      ? this.oopifManager.resolveSessionId(node.oopifSessionId)
      : undefined;

    const sendCmd = <T>(method: string, params?: Record<string, unknown>) =>
      this.client.sendCommand<T>(method, params, undefined, sessionId);

    const hitBackendNodeId = await elementFromPoint(sendCmd, centerX, centerY);
    if (hitBackendNodeId === undefined) return false;

    const snapshotHit = node.renderInfo.hitBackendNodeId;
    return (
      hitBackendNodeId === (snapshotHit ?? node.backendNodeId) ||
      hitBackendNodeId === node.backendNodeId
    );
  }

  /**
   * All complex operations that require CDP are entered through here: confirm that the main session is available, then find OOPIF and then execute it in the same client context.
   * The caller should not cache the internal session; navigation or cross-domain iframe will refresh the router when rebuilt.
   */
  async withClient<T>(fn: () => Promise<T>): Promise<T> {
    this.clientRefCount++;
    try {
      await this.client.attach();
      return await fn();
    } finally {
      this.clientRefCount--;
      if (this.clientRefCount === 0) {
        await this.oopifManager.cleanup();
        await this.client.cleanup();
      }
    }
  }

  /**
   * If OOPIF session has been cleared, rediscover and create old, new sessionId maps as required.
   * All operations CDP commands that need to be sent to the OOPIF node should be called first and must be located in withClient().
   */
  private async ensureOOPIF(): Promise<void> {
    if (!this.oopifManager.isConnected()) {
      await this.oopifManager.discoverOOPIFs(this.client, 'remap');
    }
  }

  /**
   * Write complete DOM snapshots and associated data such as selector roller containers, visual elements and viewports according to domId.
   */
  setCachedDomTree(
    domId: string,
    domTree: EnhancedDOMTreeNode,
    selectorMap: DOMSelectorMap,
    scrollContainerMap: ScrollContainerMap,
    visualElementMap: VisualElementMap,
    url?: string,
    viewportStats?: ViewportStats,
    expand?: number,
    hasOverlay?: boolean,
    topElementCount?: number,
  ): void {
    this.setSnapshot(domId, {
      domTree,
      selectorMap,
      scrollContainerMap,
      visualElementMap,
      topElementCount: topElementCount ?? 0,
      url,
      viewportStats,
      expand,
      hasOverlay,
    });
  }

  /**
   * Record a click or input interaction on the latest cache snapshot.
   * Recording backendNodeId to enable subsequent consumers to track operationally operated elements.
   */
  recordInteraction(
    backendNodeId: number,
    action: InteractionRecord['action'],
    renderedLine?: string,
    params?: Record<string, unknown>,
  ): void {
    // Press timestamp to find recent visits or create snapshots and attach this interactive session to them.
    let latest: DomSnapshot | undefined;
    for (const snapshot of this.cache.values()) {
      if (!latest || snapshot.timestamp > latest.timestamp) {
        latest = snapshot;
      }
    }
    if (!latest) return;

    if (!latest.interactions) {
      latest.interactions = [];
    }
    latest.interactions.push({
      backendNodeId,
      action,
      renderedLine,
      params,
      timestamp: Date.now(),
    });
  }

  /**
   * Summarizes the interactive records of all cache snapshots and groups them by backendNodeId.
   */
  private collectInteractions(): Map<number, InteractionRecord[]> {
    const map = new Map<number, InteractionRecord[]>();
    for (const snapshot of this.cache.values()) {
      if (!snapshot.interactions) continue;
      for (const record of snapshot.interactions) {
        let list = map.get(record.backendNodeId);
        if (!list) {
          list = [];
          map.set(record.backendNodeId, list);
        }
        list.push(record);
      }
    }
    return map;
  }

  /**
   * To build an exploratory progress data for all scrolling containers, which page breaks have been viewed.
   * Scans only caches with the same root backendNodeId.
   * `#` marks previously viewed pages, `>` marks the current viewport, and `_` marks unexplored pages.
   */
  getExplorationBars(
    domId: string,
  ): Map<
    number,
    { explored: number[]; current: number[]; unexplored: number[] }
  > | null {
    const target = this.getSnapshot(domId);
    if (!target?.viewportStats) return null;

    const rootId = target.domTree.backendNodeId;

    // If this is the only snapshot of the node, it means that it is the first visit and does not generate progress in exploration.
    let siblingCount = 0;
    for (const [id, snapshot] of this.cache) {
      if (id !== domId && snapshot.domTree.backendNodeId === rootId) {
        siblingCount++;
        break;
      }
    }
    if (siblingCount === 0) return null;

    // Creates an index of containers - > total number of pages, and skips a container with only one page.
    const totalPagesMap = new Map<number, number>();
    for (const sc of target.viewportStats) {
      const total = Math.ceil(sc.pagesAbove + 1 + sc.pagesBelow);
      if (total > 1) totalPagesMap.set(sc.index, total);
    }

    if (totalPagesMap.size === 0) return null;

    // A summary of all pages covered by the same root snapshot is given to each container.
    const result = new Map<
      number,
      { explored: number[]; current: number[]; unexplored: number[] }
    >();

    for (const [cIdx, totalPages] of totalPagesMap) {
      // Collect the same root snapshot in the current containment area and keep the current snapshot area separately.
      const intervals: [number, number][] = [];
      let curInterval: [number, number] | null = null;

      for (const [id, snapshot] of this.cache) {
        if (snapshot.domTree.backendNodeId !== rootId) continue;
        if (!snapshot.viewportStats) continue;

        const sc = snapshot.viewportStats.find(s => s.index === cIdx);
        if (!sc) continue;

        const exp = cIdx === 0 ? (snapshot.expand ?? 0) : 0;
        const expandAbove = Math.min(exp, sc.pagesAbove);
        const expandBelow = Math.min(exp, sc.pagesBelow);
        const start = sc.pagesAbove - expandAbove;
        const end = sc.pagesAbove + 1 + expandBelow;
        intervals.push([start, end]);
        if (id === domId) curInterval = [start, end];
      }

      // Sort and consolidate overlapping areas, with a non-duplication historical coverage.
      intervals.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const [s, e] of intervals) {
        if (merged.length > 0 && s <= merged[merged.length - 1][1]) {
          merged[merged.length - 1][1] = Math.max(
            merged[merged.length - 1][1],
            e,
          );
        } else {
          merged.push([s, e]);
        }
      }

      // Check whether [p, p + 1) is fully covered, then classify it as current, explored, or unexplored.
      const explored: number[] = [];
      const current: number[] = [];
      const unexplored: number[] = [];
      for (let p = 0; p < totalPages; p++) {
        const isCurrent =
          curInterval && curInterval[0] <= p && curInterval[1] >= p + 1;
        const isExplored = merged.some(([s, e]) => s <= p && e >= p + 1);
        if (isCurrent) {
          current.push(p);
        } else if (isExplored) {
          explored.push(p);
        } else {
          unexplored.push(p);
        }
      }

      result.set(cIdx, { explored, current, unexplored });
    }

    return result;
  }

  /**
   * Builds DOM trees and calculates rendering information; pre-call is assumed to be CDPClient connected.
   * @param options.expand - Widen view range in pages; 1 indicates an outward extension of the view height or width to mark elements outside the visual area.
   */
  async extractCurrentDomTree(
    options?: ComputeRenderInfoOptions,
  ): Promise<EnhancedDOMTreeNode> {
    const root = await this.buildTree();
    await computeRenderInfo(root, this.client, options, this.oopifManager);
    return root;
  }

  /**
   * Render DOM tree to HTML text, and calculate selectorMap, scrolling container and visual element mapping.
   * Pre-call assumes CDPClient is connected.
   */
  async renderDomTree(
    domTree: EnhancedDOMTreeNode,
    options?: { highlight?: boolean; incrementalDiff?: boolean },
  ): Promise<{
    html: string;
    selectorMap: DOMSelectorMap;
    scrollContainerMap: ScrollContainerMap;
    visualElementMap: VisualElementMap;
    hasOverlay: boolean;
    topElementCount: number;
  }> {
    const { copy: rootForRender } = copyDomTree(domTree);
    const lookup = buildNodeKeyLookup(domTree);

    // Cuts the redundant structure and returns pruneReason to the original domTree by lookup.
    pruneTree(rootForRender, lookup);

    // Distributes the highlightIndex used in the model and returns it to the original domTree by lookup.
    const selectorMap = await assignAndHighlight(
      rootForRender,
      this.client,
      this.oopifManager,
      lookup,
      { highlight: options?.highlight },
    );

    // After the cropping is completed, create a scrolling container map for the elements in the extended view.
    const scrollContainerMap = buildScrollContainerMap(rootForRender, lookup);

    // Creates a visual element map by backendNodeId.
    const visualElementMap = buildVisualElementMap(rootForRender);

    // Merge interaction history from cached snapshots so previously operated elements can be marked during serialization.
    const interactionMap = this.collectInteractions();

    // Render HTML text and return renderedLine to original domTree by lookup.
    const html = renderToHtml(rootForRender, 0, lookup, interactionMap, {
      incrementalDiff: options?.incrementalDiff,
    });

    // Recursively detect whether a modal or dialog overlay covers the page.
    const hasOverlay = (function walk(node: EnhancedDOMTreeNode): boolean {
      if (node.renderInfo?.isOverlay) return true;
      for (const child of node.childrenNodes ?? []) {
        if (walk(child)) return true;
      }
      return false;
    })(domTree);

    // Saves debug files containing information pruneReason, highlightIndex and isDuplicateListener.
    saveDebugJson('domTree.json', flattenDomTree(domTree));
    saveDebugHtml('domTree.txt', domTree);

    let topElementCount = 0;
    const countTop = (node: EnhancedDOMTreeNode): void => {
      if (node.renderInfo?.isTopElement) topElementCount++;
      for (const c of node.childrenNodes ?? []) countTop(c);
      for (const s of node.shadowRoots ?? []) countTop(s);
      if (node.contentDocument) countTop(node.contentDocument);
    };
    countTop(rootForRender);

    return {
      html,
      selectorMap,
      scrollContainerMap,
      visualElementMap,
      hasOverlay,
      topElementCount,
    };
  }

  /**
   * The layout indicator is obtained by CDP and the remaining upper and lower ranges of the main page and the scrolling containers are calculated by “pages per page”.
   * It must be called within the life cycle of withClient()
   */
  async computeViewportStats(
    scrollContainerMap: ScrollContainerMap,
  ): Promise<ViewportStats> {
    const metrics = await this.commands.getLayoutMetrics();
    const css = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    const viewportHeight = css.clientHeight;
    const scrollY = css.pageY;
    const pageHeight = metrics.cssContentSize!.height;

    const scrollContainers: ScrollContainerPages[] = [];

    // The container 0 represents the scroll area of the main page.
    const pixelsAbove = scrollY;
    const pixelsBelow = Math.max(0, pageHeight - viewportHeight - scrollY);
    scrollContainers.push({
      index: 0,
      pagesAbove:
        viewportHeight > 0
          ? Math.round((pixelsAbove / viewportHeight) * 10) / 10
          : 0,
      pagesBelow:
        viewportHeight > 0
          ? Math.round((pixelsBelow / viewportHeight) * 10) / 10
          : 0,
    });

    // The container 1 and subsequent numbers represent internal scrolling containers identified from DOM trees.
    for (const [index, node] of scrollContainerMap) {
      const sr = node.snapshotNode?.scrollRects;
      const cr = node.snapshotNode?.clientRects;
      if (!sr || !cr || cr.height <= 0) continue;
      const scrollTop = sr.y;
      const scrollableHeight = sr.height;
      const visibleHeight = cr.height;
      const above = scrollTop;
      const below = Math.max(0, scrollableHeight - visibleHeight - scrollTop);
      scrollContainers.push({
        index,
        pagesAbove: Math.round((above / visibleHeight) * 10) / 10,
        pagesBelow: Math.round((below / visibleHeight) * 10) / 10,
      });
    }

    return scrollContainers;
  }

  /**
   * Compare two caches DOM with a snapshot and create a difference tree.
   * returns null when the snapshot is missing, or origin is different and can be considered different pages.
   */
  getDiffTree(
    oldDomId: string,
    newDomId: string,
    show: DiffShow = 'both',
  ): EnhancedDOMTreeNode | null {
    const oldSnapshot = this.cache.get(oldDomId);
    const newSnapshot = this.cache.get(newDomId);
    if (!oldSnapshot?.domTree || !newSnapshot?.domTree) return null;
    try {
      if (oldSnapshot.url && newSnapshot.url) {
        const oldOrigin = new URL(oldSnapshot.url).origin;
        const newOrigin = new URL(newSnapshot.url).origin;
        if (oldOrigin !== newOrigin) return null;
      }
    } catch {}
    return createDiffTree(oldSnapshot.domTree, newSnapshot.domTree, show);
  }

  /**
   * Counts the number of new and deleted elements between the two cache snapshots and their relative proportion to the total number of old and new visible elements.
   */
  getDiffStats(
    oldDomId: string,
    newDomId: string,
  ): {
    added: number;
    removed: number;
    addedRatio: number;
    removedRatio: number;
  } | null {
    const oldSnapshot = this.cache.get(oldDomId);
    const newSnapshot = this.cache.get(newDomId);
    const diffTree = this.getDiffTree(oldDomId, newDomId);
    if (!diffTree || !oldSnapshot || !newSnapshot) return null;

    // Statistics are preceded by presentation rules that allow differences to reflect the elements actually visible in the model.
    const { copy: prunedTree } = copyDomTree(diffTree);
    pruneTree(prunedTree);

    let added = 0;
    let removed = 0;
    const visit = (node: EnhancedDOMTreeNode) => {
      if (node.renderInfo.diffStatus === 'added') added++;
      else if (node.renderInfo.diffStatus === 'removed') removed++;
      for (const c of node.childrenNodes ?? []) visit(c);
      for (const s of node.shadowRoots ?? []) visit(s);
      if (node.contentDocument) visit(node.contentDocument);
    };
    visit(prunedTree);

    const oldTotal = oldSnapshot.topElementCount;
    const newTotal = newSnapshot.topElementCount;

    return {
      added,
      removed,
      addedRatio: newTotal > 0 ? added / newTotal : 0,
      removedRatio: oldTotal > 0 ? removed / oldTotal : 0,
    };
  }

  /**
   * Shared tree construction process: Waiting for page stabilization, synchronizing real-time form status, collecting CDP data and building DOM trees.
   */
  /**
   * Snapshot collection entry point: wait for DOM and network stability, synchronize live
   * form values, then collect CDP data from the main frame and OOPIFs before building the tree.
   * Preserve this order so cross-origin iframe data is complete and current when serialized.
   */
  private async buildTree(): Promise<EnhancedDOMTreeNode> {
    await this.settleReady;
    // OOPIF session to enable the stability monitor to include its network activity in the waiting conditions.
    await this.oopifManager.discoverOOPIFs(this.client);
    await this.settleMonitor.waitForSettle(10000);

    // select, radio, checkbox and normal input current state.
    // CDP DOMSnapshot Read HTML attribute instead of DOM property in real time and must be synchronized first.
    await this.commands.injectSelectValues();
    await this.commands.injectInputValues();

    const trees = await this.commands.getAllTrees({
      oopifManager: this.oopifManager,
    });

    const builder = new DOMTreeBuilder(trees);
    const { root } = await builder.build();

    return root;
  }

  private getSnapshot(domId: string): DomSnapshot | undefined {
    const snapshot = this.cache.get(domId);
    if (snapshot) {
      snapshot.timestamp = Date.now();
    }
    return snapshot;
  }

  private setSnapshot(
    domId: string,
    snapshot: Omit<DomSnapshot, 'timestamp' | 'navigationIndex'>,
  ): void {
    this.evictIfNeeded();
    this.cache.set(domId, {
      ...snapshot,
      timestamp: Date.now(),
      navigationIndex: this.domIdCounter,
    });
  }

  /** The LRU phase-out is the longest without access to snapshots, limiting DOM memory in long missions; the old stateId may not recover locally after phase-out. */
  private evictIfNeeded(): void {
    if (this.cache.size >= this.maxCacheSize) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, snapshot] of this.cache) {
        if (snapshot.timestamp < oldestTime) {
          oldestTime = snapshot.timestamp;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.cache.delete(oldestId);
      }
    }
  }
}
