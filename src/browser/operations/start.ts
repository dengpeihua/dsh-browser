import { getPageDom, skippedDomOutput } from "../dom-utils.js"
import { navigatePage, type BrowserOperation } from "../runtime.js"

const BROWSER_GUIDE = `# Browser Mode

The DSH browser plugin controls a real Chromium instance isolated to the current Agent Session.

- DOM markers \`[N]\` are clickable and \`<N>\` are inputs.
- Visual markers \`[view:ID]\` can be inspected with \`browser_view_elements\`.
- Use the container index from \`[container:N]\` with the scroll tools.
- DOM updates replace earlier snapshots, so record important facts before the next browser action.
- Prefer \`browser_click\` and \`browser_input\`; use \`browser_execute_script\` for targeted inspection.
- Call \`browser_restore_state\` with a stateId to revisit its cached URL; transient page state is not restored.`

export const browserStart: BrowserOperation = {
  id: "browser_start",
  description: "Start the Session-isolated Chromium browser, navigate to a URL, and return the usage guide plus a DOM snapshot.",
  async execute(args, context) {
    const url = String(args.url)
    return context.manager.enqueue(async (isLast) => {
      const tab = context.manager.hasActiveTab() ? context.manager.getActiveTab() : await context.manager.newTab()
      const finalUrl = await navigatePage(tab, url, context.signal)
      const dom = isLast() ? await getPageDom(context.manager) : skippedDomOutput()
      const guide = context.manager.consumeGuide() ? `${BROWSER_GUIDE}\n\n---\n\n` : ""
      return {
        title: `Browser started → ${finalUrl}`,
        output: `${guide}Navigated to ${finalUrl}${dom.output}`,
        metadata: { url: finalUrl, domId: dom.domId },
      }
    }, context.signal)
  },
}
