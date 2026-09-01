import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { wrapScript } from "../page-tools.js"
import { throwIfBrowserAborted, type BrowserOperation } from "../runtime.js"

export const browserExecuteScript: BrowserOperation = {
  id: "browser_execute_script",
  description: `Execute JavaScript in the active page. Prefer __q(N), __find(pattern), __get(ref), and __clickable(element); returned elements are serialized automatically.`,
  async execute(args, context) {
    const script = String(args.script)
    const tab = context.manager.getActiveTab()
    const { resultText, dom } = await context.manager.enqueue(async (isLast) => {
      throwIfBrowserAborted(context.signal)
      const returnValue = await tab.domService.withClient(() => tab.domService.evaluateWithReturn(wrapScript(script)))
      const resultText = returnValue !== undefined ? `Result: ${JSON.stringify(returnValue)}` : "Script executed successfully"
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      return { resultText, dom }
    }, context.signal)
    const limited = await context.outputLimiter.output(resultText)
    return {
      title: "Execute script",
      output: `${limited.content}${dom.output}`,
      metadata: limited.truncated ? { scriptResultPath: limited.outputPath } : {},
    }
  },
}
