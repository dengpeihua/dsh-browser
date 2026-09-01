/**
 * Module overview
 * Responsibility: Manage Chromium lifecycle, tab state, and browser-tool coordination.
 * Usage: Initialization by the core tool registry when browser capabilities are enabled; page operating tool to connect Puppeteer/CDP, DOMService to Agent.
 * State and failure boundaries: Browser processes, debug ports, user-data directories, and active tabs are external resources that every failure and shutdown path must release.
 * Maintenance: When changing lifecycle code, verify repeated starts, manual browser closure, tab switching, concurrent sessions, adjacent tests, and public types.
 */

import { existsSync } from "node:fs"
import type { Browser, Page, CDPSession } from "puppeteer-core"
import { DomService } from "./dom/service.js"
import { CDPClient } from "./cdp/client.js"

/**
 * Session-scoped Chromium lifecycle manager.
 *
 * Each Session owns one manager, browser, tab map, and serialized action queue.
 * Lazy startup launches Chromium and registers newly opened pages through one
 * deduplicated TabState path. syncActiveTab reconciles cached state with pages
 * the user may have switched or closed manually. Cleanup releases each tab's
 * DOM and CDP resources before closing the owned browser.
 */

export interface TabState {
  id: string
  page: Page
  cdpSession: CDPSession
  cdpClient: CDPClient
  domService: DomService
  lastDomId?: string
}

/** Launch settings resolved once by the DSH plugin and fixed for one Session manager. */
export interface BrowserLaunchConfig {
  executablePath?: string
  headless: boolean
  noSandbox: boolean
  viewport: { width: number; height: number }
}

const DEFAULT_LAUNCH_CONFIG: BrowserLaunchConfig = {
  headless: false,
  noSandbox: false,
  viewport: { width: 1280, height: 900 },
}

export class BrowserManager {
  private static instances = new Map<string, BrowserManager>()
  private browser: Browser | null = null
  private tabs = new Map<string, TabState>()
  private pageRegistrations = new WeakMap<Page, Promise<TabState>>()
  private activeTabId: string | null = null
  private tabCounter = 0
  private pending = 0
  private chain: Promise<void> = Promise.resolve()
  private cleanupPromise: Promise<void> | undefined
  private guideShown = false

  private constructor(
    private readonly scopeID: string,
    private readonly launchConfig: BrowserLaunchConfig,
  ) {}

  /**
   * Each Session scope has an independent manager, Chrome and a tab status; one example is still used in the same Session.
   * The non-parameter entry is for non-conference calls only, and browser tools must be ctx.sessionID prominently.
   */
  /**
   * Session lookup entry point. Each session owns its own active tab and cookie state,
   * so callers cannot access browser state belonging to another session.
   */
  static getInstance(scopeID = "default", launchConfig: BrowserLaunchConfig = DEFAULT_LAUNCH_CONFIG): BrowserManager {
    const existing = BrowserManager.instances.get(scopeID)
    if (existing) return existing
    const manager = new BrowserManager(scopeID, launchConfig)
    BrowserManager.instances.set(scopeID, manager)
    return manager
  }

  /** Release one DSH Session's browser without touching any other Session. */
  static async cleanupScope(scopeID: string): Promise<void> {
    const manager = BrowserManager.instances.get(scopeID)
    if (manager) await manager.cleanup()
  }

  /** Release every browser owned by this plugin instance during Cordis unload. */
  static async cleanupAll(): Promise<void> {
    const settled = await Promise.allSettled([...BrowserManager.instances.values()].map(manager => manager.cleanup()))
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (errors.length > 0) throw new AggregateError(errors, "Failed to clean up all browser Sessions")
  }

  /** Return true once per DSH Session so the browser usage guide is not repeated on every start. */
  consumeGuide(): boolean {
    if (this.guideShown) return false
    this.guideShown = true
    return true
  }

  /**
   * Delays to start visible Chromium and integrates new tabs that are opened on the page into a single life cycle.
   * Each tab has a stand-alone CDP session, a protocol client and DOM Service to avoid swaggering with citation numbers.
   */
  /**
   * Lazily launch Chromium and install the shared target-created listener.
   * All later tab operations reuse this browser instance and listener registration.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      const puppeteer = await import("puppeteer-core")
      const executablePath = this.findChromePath()
      const args = ["--disable-blink-features=AutomationControlled"]
      // Keep Chromium's sandbox enabled by default; disable it only when controlled deployment configuration explicitly requires compatibility mode.
      if (this.launchConfig.noSandbox) {
        args.unshift("--no-sandbox", "--disable-setuid-sandbox")
      }
      this.browser = await puppeteer.default.launch({
        executablePath,
        headless: this.launchConfig.headless,
        args,
        defaultViewport: this.launchConfig.viewport,
      })

      // Pages opened by the browser use the same registration path as newTab().
      // The WeakMap prevents two CDP resource sets from being created for one page.
      this.browser.on("targetcreated", async (target) => {
        if (target.type() !== "page") return
        const page = await target.page()
        if (!page) return
        // The event listener is not called to receive the anomaly; the registration competition when the browser is shut down is closed here, and newTab main path will still expose the registration error directly.
        await this.registerPage(page).catch(() => {})
      })
    }
    return this.browser
  }

  /**
   * Page is for registration, etc.: the event listening and newTab create only one CDPSession/CDPClient/DomService even if it arrives simultaneously.
   */
  private registerPage(page: Page): Promise<TabState> {
    for (const tab of this.tabs.values()) {
      if (tab.page === page) return Promise.resolve(tab)
    }
    const pending = this.pageRegistrations.get(page)
    if (pending) return pending

    const registration = (async () => {
      // await Boundary is re-checked to overlay the very short competitive window where the other route is just registered.
      for (const tab of this.tabs.values()) {
        if (tab.page === page) return tab
      }
      const id = `tab${this.tabCounter++}`
      const cdpSession = await page.createCDPSession()
      const cdpClient = new CDPClient(cdpSession)
      const domService = new DomService(page, cdpClient)
      const tab: TabState = { id, page, cdpSession, cdpClient, domService }
      this.tabs.set(id, tab)
      return tab
    })()
    this.pageRegistrations.set(page, registration)
    return registration
  }

  private findChromePath(): string {
    if (this.launchConfig.executablePath) return this.launchConfig.executablePath
    if (process.platform === "win32") {
      const paths = [
        process.env.CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      ]
      for (const p of paths) {
        if (p && existsSync(p)) return p
      }
    } else if (process.platform === "darwin") {
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    } else {
      const paths = [
        process.env.CHROME_PATH,
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ]
      for (const p of paths) {
        if (p && existsSync(p)) return p
      }
    }
    return "google-chrome"
  }

  /**
   * Create and register a tab in this order: Page -> CDP session -> CDPClient -> DomService.
   * When a URL is provided, navigate to it and wait for DOMContentLoaded.
   */
  async newTab(url?: string): Promise<TabState> {
    const browser = await this.ensureBrowser()
    const page = await browser.newPage()
    const tab = await this.registerPage(page)
    this.activeTabId = tab.id

    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded" })
    }

    return tab
  }

  async switchTab(tabId: string): Promise<TabState> {
    const tab = this.tabs.get(tabId)
    if (!tab) throw new Error(`Tab ${tabId} not found`)
    this.activeTabId = tabId
    await tab.page.bringToFront()
    return tab
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    await tab.domService.destroySettle()
    await tab.cdpClient.cleanup()
    await tab.page.close()
    this.tabs.delete(tabId)

    if (this.activeTabId === tabId) {
      const remaining = [...this.tabs.keys()]
      if (remaining.length > 0) {
        await this.switchTab(remaining[remaining.length - 1])
      } else {
        this.activeTabId = null
      }
    }
  }

  /**
   * Aligns with the real browser front desk state. Users may manually close or switch pages, so the cache activeTabId cannot be trusted until the tool is called.
   * Keep DOM settle listener CDP client Map recorded in the cleanup order to prevent remaining subscriptions to the closed page.
   */
  /**
   * Synchronize tab state before DOM access: remove closed tabs, repair activeTabId,
   * and, when necessary, adopt the currently visible page as the active tab.
   */
  async syncActiveTab(): Promise<void> {
    // Clean up closed pages
    for (const [tabId, tab] of this.tabs) {
      if (tab.page.isClosed()) {
        await tab.domService.destroySettle().catch(() => {})
        await tab.cdpClient.cleanup().catch(() => {})
        this.tabs.delete(tabId)
        if (this.activeTabId === tabId) this.activeTabId = null
      }
    }
    // Pick a fallback if active was closed
    if (!this.activeTabId && this.tabs.size > 0) {
      this.activeTabId = [...this.tabs.keys()].pop()!
    }
    if (this.tabs.size <= 1) return
    // Find the visible (topmost) tab
    for (const [tabId, tab] of this.tabs) {
      try {
        const visible = await tab.page.evaluate(() => document.visibilityState === "visible")
        if (visible) {
          this.activeTabId = tabId
          return
        }
      } catch {}
    }
  }

  getActiveTab(): TabState {
    this.ensureStarted()
    if (!this.activeTabId) throw new Error("No active tab. Call browser_start first to enter browser mode.")
    const tab = this.tabs.get(this.activeTabId)
    if (!tab) throw new Error("Active tab not found")
    return tab
  }

  getTab(tabId: string): TabState | undefined {
    return this.tabs.get(tabId)
  }

  listTabs(): { id: string; title: string; url: string; isActive: boolean }[] {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      title: tab.page.url(),
      url: tab.page.url(),
      isActive: tab.id === this.activeTabId,
    }))
  }

  hasActiveTab(): boolean {
    return this.activeTabId !== null && this.tabs.has(this.activeTabId)
  }

  isStarted(): boolean {
    return this.browser !== null && this.browser.connected
  }

  /**
   * Browser-action guard. Tool calls must pass ensureStarted before executing:
   * - If the browser has not started, fail with an instruction to start it first.
   * - Disconnected: First reset cleanup, then re-enter browser mode.
   */
  ensureStarted(): void {
    if (!this.browser) throw new Error("Browser not started. Call browser_start first to enter browser mode.")
    if (!this.browser.connected) {
      this.reset()
      throw new Error("Browser was closed. Call browser_start again to re-enter browser mode.")
    }
  }

  private reset(): void {
    this.tabs.clear()
    this.pageRegistrations = new WeakMap()
    this.activeTabId = null
    this.browser = null
  }

  /**
   * Serialized browser side effects. The side distribution tool can still line up, but only the tailing tool can generate DOM by isLast() ,
   * The preceding tool returns the position of "delayed extraction", thus avoiding multiple actions based on the same old snapshot repeated extraction and contamination of the context.
   */
  /**
   * Serialize browser actions on a promise chain so concurrent operations cannot corrupt
   * tab or DOM state. The next action starts only after the current one finishes.
   */
  async enqueue<T>(fn: (isLast: () => boolean) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      const error = new Error("Browser tool execution was aborted")
      error.name = "AbortError"
      throw error
    }
    this.pending++
    const prev = this.chain
    let resolve!: () => void
    this.chain = new Promise<void>((r) => { resolve = r })
    let entered = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.pending--
      resolve()
    }
    let onAbort: (() => void) | undefined
    try {
      if (signal) {
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => {
            const error = new Error("Browser tool execution was aborted")
            error.name = "AbortError"
            reject(error)
          }
          signal.addEventListener("abort", onAbort, { once: true })
        })
        await Promise.race([prev, aborted])
      } else {
        await prev
      }
      entered = true
      if (onAbort) signal?.removeEventListener("abort", onAbort)
      if (signal?.aborted) {
        const error = new Error("Browser tool execution was aborted")
        error.name = "AbortError"
        throw error
      }
      return await fn(() => this.pending === 1)
    } catch (error) {
      if (!entered) {
        if (onAbort) signal?.removeEventListener("abort", onAbort)
        // The caller received AbortError immediately, but the queue gate was to be released after completion of the pre-order to prevent follow-up tasks from crossing the side effects that were still under way.
        void prev.then(release, release)
      }
      throw error
    } finally {
      if (entered) release()
    }
  }

  /**
   * Close path: dispose each tab's DomService and CDPClient, close the browser,
   * then remove this session instance.
   */
  cleanup(): Promise<void> {
    if (!this.cleanupPromise) this.cleanupPromise = this.cleanupInternal()
    return this.cleanupPromise
  }

  private async cleanupInternal(): Promise<void> {
    const tabs = [...this.tabs.values()]
    const browser = this.browser
    const errors: unknown[] = []
    const withTimeout = async (label: string, operation: Promise<unknown>, milliseconds: number): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    try {
      // The failure or suspension of a single resource does not prevent the remaining tabs and Chrome from closing.
      for (const tab of tabs) {
        const results = await Promise.allSettled([
          withTimeout(`DomService cleanup for ${tab.id}`, tab.domService.destroySettle(), 3000),
          withTimeout(`CDP cleanup for ${tab.id}`, tab.cdpClient.cleanup(), 3000),
        ])
        for (const result of results) {
          if (result.status === "rejected") errors.push(result.reason)
        }
      }
      if (browser) {
        await withTimeout("Browser close", browser.close(), 5000).catch((error) => {
          errors.push(error)
          // If graceful close times out, terminate the Chromium process launched by this
          // manager so cleanup cannot hang indefinitely.
          try {
            browser.process()?.kill()
          } catch (killError) {
            errors.push(killError)
          }
        })
      }
    } finally {
      this.tabs.clear()
      this.pageRegistrations = new WeakMap()
      this.activeTabId = null
      this.browser = null
      this.guideShown = false
      if (BrowserManager.instances.get(this.scopeID) === this) {
        BrowserManager.instances.delete(this.scopeID)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to clean up browser resources")
  }
}
