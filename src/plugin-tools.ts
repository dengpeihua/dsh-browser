import type { Context as CordisContext } from "@deepseek-ai/cordis"
import type { ImageAttachmentRef, ImageMediaType } from "@deepseek-ai/dsh-attachment"
import { defineTool, type ToolRunContext } from "@deepseek-ai/dsh-tools"
import type {} from "@deepseek-ai/dsh-user-approval"
import { BROWSER_OPERATIONS } from "./browser/operations/index.js"
import type { BrowserAttachment } from "./browser/runtime.js"
import { BrowserManager, type BrowserLaunchConfig } from "./browser/manager.js"
import type { ResolvedConfig } from "./config.js"
import { createOutputLimiter } from "./output-limiter.js"
import { PARAMETER_SCHEMAS, TOOL_IDS, TOOL_OUTPUT_SCHEMA, type BrowserToolId } from "./tool-schemas.js"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface BrowserArtifact {
  id: string
  name: string
  media_type: string
}

interface BrowserToolValue {
  status: "success"
  summary: string
  output: string
  next_actions: string[]
  artifacts: BrowserArtifact[]
  metadata: JsonValue
  images: JsonValue[]
}

const MUTATING_TOOLS = new Set<BrowserToolId>([
  "browser_start",
  "browser_goto",
  "browser_refresh",
  "browser_restore_state",
  "browser_new_tab",
  "browser_close_tab",
  "browser_click",
  "browser_input",
  "browser_reveal_offscreen",
  "browser_scroll_next_screen",
  "browser_scroll_to_page",
  "browser_execute_script",
])

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function nextActions(toolId: BrowserToolId): string[] {
  if (toolId === "browser_view_elements") return ["Use the images together with the current DOM snapshot before interacting."]
  if (toolId === "browser_wait") return ["Continue the delayed action and verify the resulting page state."]
  return ["Inspect the returned DOM snapshot or delta before choosing the next browser action."]
}

function shouldAsk(config: ResolvedConfig, toolId: BrowserToolId): boolean {
  if (config.approvalMode === "off") return false
  if (config.approvalMode === "always") return true
  return MUTATING_TOOLS.has(toolId)
}

function scopeId(exec: ToolRunContext): string {
  if (exec.agent?.id === undefined) {
    throw new Error(
      "Browser tools require a DSH Agent so Chromium state can be isolated by Session. "
      + "Safe retry: invoke the tool through a normal DSH Agent turn. Stop condition: do not use an unscoped executor.",
    )
  }
  return String(exec.agent.id)
}

function failureMessage(toolId: BrowserToolId, error: unknown): Error {
  const cause = error instanceof Error ? error.message : String(error)
  return new Error(
    `${toolId} failed: ${cause}\nSafe retry: verify browser_start succeeded, refresh the DOM snapshot, and retry once with current element/tab IDs.\nStop condition: stop retrying if Chromium is unavailable, approval is denied, or the same current-state error repeats.`,
    { cause: error },
  )
}

function parseAttachment(attachment: BrowserAttachment): { data: Uint8Array; mediaType: ImageMediaType; name: string } {
  const match = attachment.dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s)
  if (!match?.[1] || !match[2]) throw new Error(`unsupported browser attachment URL for ${attachment.filename}`)
  return { data: Buffer.from(match[2], "base64"), mediaType: match[1] as ImageMediaType, name: attachment.filename }
}

async function persistAttachments(ctx: CordisContext, attachments: BrowserAttachment[] | undefined) {
  if (!attachments?.length) return { refs: [] as ImageAttachmentRef[], artifacts: [] as BrowserArtifact[] }
  const store = ctx.get("attachments")
  if (!store) throw new Error("Browser screenshots require the DSH attachment service, but no provider is mounted")
  const inputs = attachments.map(parseAttachment)
  const refs = [...await store.saveImages(inputs)]
  return {
    refs,
    artifacts: refs.map((ref, index) => ({
      id: String(ref.attachmentId),
      name: ref.name ?? inputs[index]?.name ?? `browser-image-${index + 1}`,
      media_type: ref.mediaType,
    })),
  }
}

function renderValue(value: BrowserToolValue) {
  const guidance = value.next_actions.length > 0
    ? `\n\nNext actions:\n${value.next_actions.map(action => `- ${action}`).join("\n")}`
    : ""
  return [
    { type: "text" as const, text: `${value.output}${guidance}` },
    ...value.images.map(image => ({ type: "image" as const, attachment: image as unknown as ImageAttachmentRef })),
  ]
}

function validateRuntimeArgs(toolId: BrowserToolId, args: unknown, config: ResolvedConfig): void {
  if (toolId !== "browser_wait") return
  const seconds = Number((args as { seconds: unknown }).seconds)
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > config.maxWaitSeconds) {
    throw new Error(
      `browser_wait seconds must be between 0 and ${config.maxWaitSeconds}. `
      + "Safe retry: use a finite delay inside that range. Stop condition: do not retry with the same invalid value.",
    )
  }
}

async function requestApproval(ctx: CordisContext, config: ResolvedConfig, toolId: BrowserToolId, exec: ToolRunContext) {
  if (!shouldAsk(config, toolId)) return
  const approval = ctx.get("approval")
  if (!approval) {
    throw new Error(`approvalMode=${config.approvalMode} requires @deepseek-ai/dsh-user-approval; mount it or set approvalMode: off`)
  }
  if (!exec.agent) throw new Error("Cannot request browser approval without a DSH Agent")
  const outcome = await approval.request({
    agent: exec.agent,
    toolName: toolId,
    callId: exec.callId,
    reason: `Allow ${toolId} to operate this DSH Agent Session's isolated Chromium instance?`,
    signal: exec.signal,
  })
  if (outcome !== "allowed-once") throw new Error(`Browser approval was not granted (${outcome})`)
}

/** Register all browser operations directly in the DSH typed tool registry. */
export function registerBrowserTools(ctx: CordisContext, config: ResolvedConfig): Array<() => void> {
  if (BROWSER_OPERATIONS.length !== TOOL_IDS.length) throw new Error("Browser operation/schema count mismatch")
  const outputLimiter = createOutputLimiter({
    maxLines: config.scriptMaxLines,
    maxBytes: config.scriptMaxBytes,
    ...(config.outputDir ? { outputDir: config.outputDir } : {}),
  })
  const launchConfig: BrowserLaunchConfig = {
    ...(config.chromePath ? { executablePath: config.chromePath } : {}),
    headless: config.headless,
    noSandbox: config.noSandbox,
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
  }

  return BROWSER_OPERATIONS.map(operation => ctx.tools.register(defineTool({
    name: operation.id,
    description: operation.description,
    parameters: PARAMETER_SCHEMAS[operation.id],
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: (_args, value) => renderValue(value as unknown as BrowserToolValue),
      presentationMeta: (_args, value) => ({ title: value.summary, status: value.status, artifacts: value.artifacts }),
    },
    timeoutMs: config.toolTimeoutMs,
    async execute(args, exec): Promise<BrowserToolValue> {
      validateRuntimeArgs(operation.id, args, config)
      const sessionId = scopeId(exec)
      try {
        await requestApproval(ctx, config, operation.id, exec)
        if (exec.signal.aborted) throw exec.signal.reason ?? new Error("Browser tool execution was aborted")
        const result = await operation.execute(args as Record<string, unknown>, {
          manager: BrowserManager.getInstance(sessionId, launchConfig),
          signal: exec.signal,
          outputLimiter,
        })
        const { refs, artifacts } = await persistAttachments(ctx, result.attachments)
        return {
          status: "success",
          summary: result.title,
          output: result.output,
          next_actions: nextActions(operation.id),
          artifacts,
          metadata: jsonValue(result.metadata),
          images: refs.map(jsonValue),
        }
      } catch (error) {
        if (exec.signal.aborted) throw exec.signal.reason ?? error
        throw failureMessage(operation.id, error)
      }
    },
  })))
}
