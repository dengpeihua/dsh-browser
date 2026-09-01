import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

interface OutputLimitResult {
  content: string
  truncated: boolean
  outputPath?: string
}

interface OutputLimitOptions {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
}

export interface OutputLimiter {
  output(text: string, options?: OutputLimitOptions): Promise<OutputLimitResult>
}

export interface OutputLimiterConfig {
  maxLines: number
  maxBytes: number
  outputDir?: string
}

function preview(text: string, maxLines: number, maxBytes: number, direction: "head" | "tail"): string {
  const lines = text.split("\n")
  const ordered = direction === "head" ? lines : [...lines].reverse()
  const selected: string[] = []
  let bytes = 0
  for (const line of ordered) {
    if (selected.length >= maxLines) break
    const size = Buffer.byteLength(line, "utf8") + (selected.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    selected.push(line)
    bytes += size
  }
  if (direction === "tail") selected.reverse()
  return selected.join("\n")
}

/** Limit model-visible output and persist the complete value when it exceeds the configured cap. */
export function createOutputLimiter(config: OutputLimiterConfig): OutputLimiter {
  return {
    async output(text, options = {}) {
      const maxLines = Math.min(options.maxLines ?? config.maxLines, config.maxLines)
      const maxBytes = Math.min(options.maxBytes ?? config.maxBytes, config.maxBytes)
      if (text.split("\n").length <= maxLines && Buffer.byteLength(text, "utf8") <= maxBytes) {
        return { content: text, truncated: false }
      }

      const outputDir = resolve(config.outputDir ?? join(tmpdir(), "dsh-browser-output"))
      await mkdir(outputDir, { recursive: true })
      const outputPath = join(outputDir, `browser-script-${randomUUID()}.txt`)
      await writeFile(outputPath, text, "utf8")
      return {
        content: `${preview(text, maxLines, maxBytes, options.direction ?? "head")}\n\n... output truncated ...\nFull script result: ${outputPath}`,
        truncated: true,
        outputPath,
      }
    },
  }
}
