/**
 * CDP client and event bridge.
 *
 * CDPClient wraps a Puppeteer CDPSession with timeout-aware commands, retries,
 * unified event forwarding, and idempotent cleanup. CDPEventBridge forwards
 * selected protocol events through a message event for PageSettleMonitor.
 * Commands fail immediately after closure; cleanup removes listeners before
 * detaching the session.
 */

import { EventEmitter } from 'events';
import type { CDPSession } from 'puppeteer-core';

// settle-monitor To determine the stability of the page and to follow CDP events that require listening when crossing iframe.
const CDP_EVENTS_TO_FORWARD = [
  'Network.requestWillBeSent',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Network.responseReceived',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.childNodeCountUpdated',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
  'Target.attachedToTarget',
];

/**
 * Event adapter: triggers Puppeteer CDPSession an event by method,
 * Converts to a unified Electron event.
 * PageSettleMonitor relies on `on('message', (event, method, params) => ...)`.
 */
class CDPEventBridge extends EventEmitter {
  private session: CDPSession;
  private handlers = new Map<string, (params: any) => void>();

  constructor(session: CDPSession) {
    super();
    this.session = session;
  }

  /**
   * Start event forwarding by creating and registering one handler per event.
   * Keep each handler reference so cleanup can unregister the exact same function object.
   */
  startForwarding(): void {
    for (const method of CDP_EVENTS_TO_FORWARD) {
      const handler = (params: any) => {
        this.emit('message', null, method, params ?? {});
      };
      this.handlers.set(method, handler);
      this.session.on(method as any, handler);
    }
  }

  /**
   * Stop forwarding by unregistering every stored handler, then clear the handler map
   * to prevent duplicate events and memory leaks.
   */
  stopForwarding(): void {
    for (const [method, handler] of this.handlers) {
      this.session.off(method as any, handler);
    }
    this.handlers.clear();
  }
}

export class CDPClient {
  private session: CDPSession;
  private eventBridge: CDPEventBridge;
  private closed = false;

  /**
   * Create Order: Save CDPSession - > Create Event Bridge - > Start immediately the transmission of events.
   */
  constructor(session: CDPSession) {
    this.session = session;
    this.eventBridge = new CDPEventBridge(session);
    this.eventBridge.startForwarding();
  }

  // The connection was completed by Puppeteer when the CDPSession was created; the two empty methods are used only for callers that are compatible with the attach/detach interface.
  async attach(): Promise<void> {}
  async detach(): Promise<void> {}

  /**
   * Order of execution of a single order:
   * 1 . closed is true , and orders to session are avoided.
   * Creates a timeoutPromise that fails after the specified milliseconds.
   * 3. Promise.race also waits for the underlying session.send() and timeout; the first party to finish decides the result.
   * 4. Returns the agreed return value as a broad T when success; and when failure, supplements the context of the CDP command.
   */
  async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 10000,
    _sessionId?: string,
  ): Promise<T> {
    if (this.closed) {
      throw new Error('[CDP] Session is closed');
    }

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`[CDP] Command timeout after ${timeout}ms: ${method}`));
        }, timeout);
      });

      const result = await Promise.race([
        this.session.send(method as any, params as any),
        timeoutPromise,
      ]);

      return result as T;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('timeout')) {
        throw new Error(`[CDP] Command timed out after ${timeout}ms: ${method}`);
      }
      throw new Error(`[CDP] Command failed (${method}): ${errorMessage}`);
    }
  }

  /**
   * Order of execution with retry:
   * 1. Fills the default values for maximum number of retries, intervals for retries and single timeout.
   * 2. For each rotation sendCommand; return immediately and successfully.
   * 3. Last error is recorded when failure; do not try again if session has been closed.
   * 4. There are still times to wait retryDelay to throw the last error after all attempts have been completed.
   * maxRetries counts additional retries, so the command runs at most maxRetries + 1 times.
   */
  async sendCommandWithRetry<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: {
      maxRetries?: number;
      retryDelay?: number;
      timeout?: number;
      sessionId?: string;
    } = {},
  ): Promise<T> {
    const { maxRetries = 2, retryDelay = 1000, timeout = 10000 } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.sendCommand<T>(method, params, timeout);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (lastError.message.includes('closed')) throw lastError;
        if (attempt === maxRetries) break;
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    throw lastError || new Error('[CDP] Command failed after all retries');
  }

  /**
   * Returns the event bridge that will send out the unified message event.
   * The object is compatible with the CdpDebugger interface required for settle-monitor.
   */
  getDebugger(): CDPEventBridge {
    return this.eventBridge;
  }

  /**
   * Clear order: Stop the event forward - > Mark closed - Try to disconnect the underlying session.
   * detach failure will be swallowed to ensure that the end process does not fail once again when repeated cleanup or browser exits.
   */
  async cleanup(): Promise<void> {
    this.eventBridge.stopForwarding();
    this.closed = true;
    await this.session.detach().catch(() => {});
  }
}
