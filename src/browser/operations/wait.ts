import { waitForBrowserDelay, type BrowserOperation } from "../runtime.js"

export const browserWait: BrowserOperation = {
  id: "browser_wait",
  description: "Wait for a bounded number of seconds while honoring the current DSH tool cancellation signal.",
  async execute(args, context) {
    context.manager.ensureStarted()
    const seconds = Number(args.seconds)
    await waitForBrowserDelay(seconds * 1000, context.signal)
    return { title: `Wait ${seconds}s`, output: `Waited ${seconds} seconds`, metadata: {} }
  },
}
