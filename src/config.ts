import z from "@deepseek-ai/schemastery"

type ApprovalMode = "off" | "mutating" | "always"

/** User-configurable browser launch, approval, timeout, and output limits. */
export interface Config {
  chromePath?: string
  headless?: boolean
  noSandbox?: boolean
  approvalMode?: ApprovalMode
  viewportWidth?: number
  viewportHeight?: number
  toolTimeoutMs?: number
  maxWaitSeconds?: number
  scriptMaxLines?: number
  scriptMaxBytes?: number
  outputDir?: string
}

/** Cordis configuration schema exported for DSH config validation and defaults. */
export const Config: z<Config> = z.object({
  chromePath: z.string(),
  headless: z.boolean().default(false),
  noSandbox: z.boolean().default(false),
  approvalMode: z.union(["off", "mutating", "always"] as const).default("mutating"),
  viewportWidth: z.number().default(1280),
  viewportHeight: z.number().default(900),
  toolTimeoutMs: z.number().default(120_000),
  maxWaitSeconds: z.number().default(300),
  scriptMaxLines: z.number().default(100),
  scriptMaxBytes: z.number().default(8 * 1024),
  outputDir: z.string(),
})

export interface ResolvedConfig {
  chromePath?: string
  headless: boolean
  noSandbox: boolean
  approvalMode: ApprovalMode
  viewportWidth: number
  viewportHeight: number
  toolTimeoutMs: number
  maxWaitSeconds: number
  scriptMaxLines: number
  scriptMaxBytes: number
  outputDir?: string
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-browser: ${name} must be a positive integer`)
  }
  return value
}

/** Resolve defaults again for direct tests/callers that bypass the Cordis loader. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const chromePath = config.chromePath?.trim()
  const outputDir = config.outputDir?.trim()
  return {
    ...(chromePath ? { chromePath } : {}),
    headless: config.headless ?? false,
    noSandbox: config.noSandbox ?? false,
    approvalMode: config.approvalMode ?? "mutating",
    viewportWidth: positiveInteger("viewportWidth", config.viewportWidth ?? 1280),
    viewportHeight: positiveInteger("viewportHeight", config.viewportHeight ?? 900),
    toolTimeoutMs: positiveInteger("toolTimeoutMs", config.toolTimeoutMs ?? 120_000),
    maxWaitSeconds: positiveInteger("maxWaitSeconds", config.maxWaitSeconds ?? 300),
    scriptMaxLines: positiveInteger("scriptMaxLines", config.scriptMaxLines ?? 100),
    scriptMaxBytes: positiveInteger("scriptMaxBytes", config.scriptMaxBytes ?? 8 * 1024),
    ...(outputDir ? { outputDir } : {}),
  }
}
