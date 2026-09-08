import { createHash } from "node:crypto"
import type { EnhancedDOMTreeNode } from "./types/dom-node.js"

/** Compare complete captured content, not the viewport-pruned renderer or transient highlight IDs. */
export function explorationFingerprint(root: EnhancedDOMTreeNode): string {
  const hash = createHash("sha256")
  const visit = (node: EnhancedDOMTreeNode) => {
    if (node.attributes?.id === "__elements_highlight_container__") return
    const attributes = Object.entries(node.attributes ?? {})
      .filter(([key]) => key !== "data-hl-idx")
      .sort(([a], [b]) => a.localeCompare(b))
    hash.update(JSON.stringify([node.frameId, node.backendNodeId, node.nodeName, node.nodeValue, attributes]))
    for (const child of node.childrenNodes ?? []) visit(child)
    for (const shadow of node.shadowRoots ?? []) visit(shadow)
    if (node.contentDocument) visit(node.contentDocument)
  }
  visit(root)
  return hash.digest("hex")
}
