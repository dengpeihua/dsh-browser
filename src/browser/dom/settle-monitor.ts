/**
 * CDP-driven page stability monitor.
 *
 * Relevant network and DOM events mark the page dirty and restart a quiet
 * window. The page becomes clean only after that window expires without a
 * critical inflight request. waitForSettle resolves when clean or when its
 * caller-supplied timeout expires.
 */
type TimerHandle = unknown;

// A global timer type compatible with Node/Bun is used to harmonize handle/ clearTimeout.
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

// ---------------------------------------------------------------------------
// Network/DOM stability detection constant
// ---------------------------------------------------------------------------

const DOM_MUTATION_EVENTS = new Set([
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.childNodeCountUpdated',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'DOM.characterDataModified',
]);

// Advertising/tracking domain names and paths that need to be ignored: will not be handled as a key request to block settle.
const IGNORED_URL_KEYWORDS = [
  // Google Advertising and Statistics
  'doubleclick.net',
  'googlesyndication.com',
  'googletagmanager.com',
  'google-analytics.com',
  'googleadservices.com',
  // Advertising technology/user identification synchronization
  'undertone.com',
  'mrtnsvr.com',
  'loopme.me',
  'pubmatic.com',
  'unrulymedia.com',
  // Facebook
  'facebook.net',
  'fbcdn.net',
  // Statistics
  'demdex.net',
  'omtrdc.net',
  'adobedtm.com',
  'ensighten.com',
  // Errors and performances reported
  'sentry.io',
  'newrelic.com',
  'nr-data.net',
  // Analytical platform
  'hotjar',
  'clarity.ms',
  'mixpanel',
  'segment.io',
  // Social tracking
  'platform.twitter.com',
  'platform.linkedin.com',
  'pinimg.com',
  'pinterest.com',
  'sc-static.net',
  // Monitoring platform
  'quantummetric.com',
  'dynatrace.com',
  'go-mpulse.net',
  'optimizely.com',
  'brcdn.com',
  // Advertising and reorientation
  'criteo.com',
  'id5-sync.com',
  'creativecdn.com',
  'attn.tv',
  'wandzcdn.com',
  'wandzapi.com',
  // Small third party parts (chat, Cookie bullet windows)
  'talkdeskapp.com',
  'talkdeskchatsdk',
  'cookielaw.org',
  // CDN Picture class path
  '.cloudfront.net/image/',
  '.akamaized.net/image/',
  // Universal keyword
  'analytics',
  'tracking',
  'pixel',
  'adservice',
  'ads',
  // Path to Common Burial Point
  '/tracker/',
  '/collector/',
  '/beacon/',
  '/telemetry/',
  '/log/',
  '/events/',
  '/eventBatch',
  '/track.',
  '/metrics/',
  '/sync',
  '/csync',
  'usersync',
  'pixel/sync',
];

const NON_CRITICAL_RESOURCE_TYPES = new Set([
  'Image',
  'Media',
  'Font',
  'Preflight',
  'Ping',
  'CSPViolationReport',
  'Prefetch',
]);

const STUCK_REQUEST_MS = 10000;
const NON_CRITICAL_MAX_MS = 3000;
/**
 * Only a small number of requests remain open and have been waiting longer, usually in the back desk;
 * Avoid prolonged obstruction of judgement settle.
 */
const LONE_REQUEST_MAX_MS = 5000;
const IMAGE_URL_RE = /(\.jpg|jpeg|png|gif|webp|svg|ico)(\?|$)/i;

function isIgnoredUrl(url: string): boolean {
  if (!url || url.startsWith('data:') || url.length > 500) return true;
  const lower = url.toLowerCase();
  return IGNORED_URL_KEYWORDS.some(kw => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// PageSettleMonitor
// ---------------------------------------------------------------------------

type InflightRequest = { url: string; type: string; startTime: number };

// Use duck typing to avoid heavy reliance on the electron type definition.
type CdpDebugger = {
  on(event: 'message', listener: (...args: any[]) => void): void;
  off(event: 'message', listener: (...args: any[]) => void): void;
};

export interface PageSettleMonitorOptions {
  quietWindow?: number;
  /** OOPIF sessionId is known; Network/DOM listening will be activated immediately upon startup. */
  oopifSessionIds?: string[];
  /** Enables Network and DOM events for initial and subsequent OOPIF sessions. */
  enableOOPIFSession?: (sessionId: string) => Promise<void>;
}

/**
 * Background page level page stability monitor.
 *
 * Key order of implementation:
 * 1. Construct: Tie message listening, register OOPIF and start the first silent meter in a state that is dirty.
 * Event stream:
 * - Target.attachedToTarget (iframe): Enable sub-session listening and reset silent time.
 * - DOM Change event: mark dirty + reset silent timer.
 * - Network.requestWillBeSent: Recording pending requests and reset silent time.
 * - loadingFinished/loadingFailed: Delete the record at the end of the request.
 * - responseReceived: Type of request updated; delete if not critical.
 * 3. onQuiet to point: Call hasCriticalInflight to determine whether critical requests are still being transmitted.
 * - There are still key requests: continue to reset the count (waiting longer silence)
 * - No critical request: Mark clean and notify all waiters.
 * 4. waitForSettle: If currently returned directly clean ; otherwise hang up Promise and wait for clean or timeout to trigger.
 */
export class PageSettleMonitor {
  private dirty = true;
  private inflightRequests = new Map<string, InflightRequest>();
  private quietTimer: TimerHandle | null = null;
  private cleanWaiters: Array<() => void> = [];
  private readonly onMessageBound: (...args: any[]) => void;
  private readonly quietWindow: number;
  private readonly enableOOPIFSession?: (sessionId: string) => Promise<void>;

  constructor(
    private readonly debugger_: CdpDebugger,
    options: PageSettleMonitorOptions = {},
  ) {
    this.quietWindow = options.quietWindow ?? 1000;
    this.enableOOPIFSession = options.enableOOPIFSession;

    this.onMessageBound = this.onMessage.bind(this);
    this.debugger_.on('message', this.onMessageBound);

    for (const sessionId of options.oopifSessionIds ?? []) {
      this.enableOOPIFSession?.(sessionId).catch(() => {});
    }

    this.resetTimer();
  }

  // Step: Enter - > Constructing Parameters (quietWindow/enableOOPIFSession/oopifSessionIds) - > Trigger Event - > listener registration, Known OOPIF Start, quiet timer Reset to dirty monitoring state.

  /**
   * Wait for the page to enter clean; or return after timeoutMs (overtime).
   * If clean has been returned immediately.
   */
  async waitForSettle(timeoutMs: number): Promise<void> {
    if (!this.dirty) {
      // It's already clean, go straight back, no blocking.
      return;
    }
    return new Promise<void>(resolve => {
      const timer = timers.setTimeout(() => {
        resolve();
      }, timeoutMs);
      this.cleanWaiters.push(() => {
        timers.clearTimeout(timer);
        resolve();
      });
    });
  }

  // Return immediately when clean; otherwise wait until the page settles or timeoutMs expires.

  stop(): void {
    this.debugger_.off('message', this.onMessageBound);
    if (this.quietTimer) timers.clearTimeout(this.quietTimer);
    this.cleanWaiters = [];
  }

  private onMessage(
    _event: unknown,
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === 'Target.attachedToTarget') {
      if ((params as any).targetInfo?.type === 'iframe') {
        const sessionId = (params as any).sessionId as string;
        this.enableOOPIFSession?.(sessionId).catch(() => {});
        this.resetTimer();
      }
      return;
    }

    // Target.attachedToTarget for an iframe enables OOPIF monitoring and resets the quiet timer.

    if (DOM_MUTATION_EVENTS.has(method)) {
      this.dirty = true;
      this.resetTimer();
      return;
    }

    // A DOM mutation marks the page dirty and restarts the quiet timer.

    if (method === 'Network.requestWillBeSent') {
      const url = (params as any).request?.url ?? '';
      const type = (params as any).type ?? '';
      const requestId = (params as any).requestId as string;
      if (!isIgnoredUrl(url) && !NON_CRITICAL_RESOURCE_TYPES.has(type)) {
        this.inflightRequests.set(requestId, {
          url,
          type,
          startTime: Date.now(),
        });
        this.dirty = true;
        // console.log(`[settle] +inflight [${type}] ${url.slice(0, 80)} (total=${this.inflightRequests.size})`);
        this.resetTimer();
      }
    } else if (
      method === 'Network.loadingFinished' ||
      method === 'Network.loadingFailed'
    ) {
      this.inflightRequests.delete((params as any).requestId as string);
    } else if (method === 'Network.responseReceived') {
      const requestId = (params as any).requestId as string;
      const type = (params as any).type ?? '';
      const req = this.inflightRequests.get(requestId);
      if (req) {
        req.type = type;
        if (NON_CRITICAL_RESOURCE_TYPES.has(type)) {
          this.inflightRequests.delete(requestId);
        }
      }
    }
  }

  // Network lifecycle events add, update, or remove inflight requests; non-critical requests are filtered so the page can settle.

  private hasCriticalInflight(): boolean {
    const now = Date.now();
    const remaining: [string, InflightRequest][] = [];
    for (const [reqId, req] of this.inflightRequests) {
      const age = now - req.startTime;
      if (age > STUCK_REQUEST_MS) {
        this.inflightRequests.delete(reqId);
        continue;
      }
      if (
        NON_CRITICAL_RESOURCE_TYPES.has(req.type) &&
        age > NON_CRITICAL_MAX_MS
      ) {
        this.inflightRequests.delete(reqId);
        continue;
      }
      if (IMAGE_URL_RE.test(req.url) && age > NON_CRITICAL_MAX_MS) {
        this.inflightRequests.delete(reqId);
        continue;
      }
      remaining.push([reqId, req]);
    }
    // While the remaining requests are limited and are long awaited, it is common for back-office inquiries to allow early release.
    if (remaining.length <= 3) {
      const allLone = remaining.every(
        ([, req]) => now - req.startTime > LONE_REQUEST_MAX_MS,
      );
      if (allLone) {
        for (const [reqId] of remaining) {
          this.inflightRequests.delete(reqId);
        }
        return false;
      }
    }
    return remaining.length > 0;
  }

  // Step: Enter - > the current inflight request group - > the trigger event - > remove the timeout/non-critical/photo timeout request; the remaining < = 3 and all thresholds are considered backstage noise and return to critical inflight.

  private resetTimer(): void {
    if (this.quietTimer) timers.clearTimeout(this.quietTimer);
    this.quietTimer = timers.setTimeout(() => this.onQuiet(), this.quietWindow);
  }

  // Step: Enter - > Any activity trigger - > Trigger Event - > Cancel old quiet timer and re-establish new quiet timer and delay the "quiet window".

  private onQuiet(): void {
    this.quietTimer = null;
    if (this.hasCriticalInflight()) {
      this.resetTimer();
      return;
    }
    // When the silent window ends and there is no critical request, the window is determined to be clean and all those waiting are notified.
    this.dirty = false;
    const waiters = this.cleanWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  // When the quiet timer expires, keep waiting for critical requests; otherwise mark the page clean and resolve all waiters.
}
