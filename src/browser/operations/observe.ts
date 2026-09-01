import { throwIfBrowserAborted, type BrowserOperation } from "../runtime.js"

export const browserViewElements: BrowserOperation = {
  id: "browser_view_elements",
  description: "Capture visual evidence for [view:ID] elements from the current DOM snapshot and attach the resulting images to DSH.",
  async execute(args, context) {
    const viewIds = Array.isArray(args.viewIds) ? args.viewIds.map(String) : []
    const tab = context.manager.getActiveTab()
    const { domService } = tab
    if (viewIds.length === 0) return { title: "View elements", output: "No viewIds provided.", metadata: {} }
    const visualElementMap = domService.getLatestVisualElementMap()
    if (!visualElementMap || visualElementMap.size === 0) {
      return { title: "View elements", output: "No visual elements available. Wait for the page and refresh the DOM snapshot.", metadata: {} }
    }
    return context.manager.enqueue(async () => domService.withClient(async () => {
      const textParts: string[] = []
      const attachments: Array<{ mime: "image/jpeg"; filename: string; dataUrl: string }> = []
      for (const id of viewIds) {
        throwIfBrowserAborted(context.signal)
        const node = visualElementMap.get(id)
        if (!node) {
          textParts.push(`Visual element view:${id} not found in current DOM.`)
          continue
        }
        const rect = await domService.getElementRect(node)
        const padding = 10
        const base64 = await domService.captureClip({
          x: Math.max(0, rect.x - padding),
          y: Math.max(0, rect.y - padding),
          width: rect.width + padding * 2,
          height: rect.height + padding * 2,
        })
        textParts.push(`view:${id} <${node.nodeName.toLowerCase()}>: [see attachment]`)
        attachments.push({ mime: "image/jpeg", filename: `view-${id}.jpg`, dataUrl: `data:image/jpeg;base64,${base64}` })
      }
      return { title: `View ${viewIds.length} element(s)`, output: textParts.join("\n"), metadata: {}, attachments }
    }), context.signal)
  },
}
