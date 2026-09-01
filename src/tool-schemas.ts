import type { ParameterSchemaSpec, ValueSchemaSpec } from "@deepseek-ai/dsh-tools"

export const TOOL_IDS = [
  "browser_start",
  "browser_goto",
  "browser_refresh",
  "browser_restore_state",
  "browser_new_tab",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_click",
  "browser_input",
  "browser_reveal_offscreen",
  "browser_scroll_next_screen",
  "browser_scroll_to_page",
  "browser_execute_script",
  "browser_view_elements",
  "browser_wait",
] as const

export type BrowserToolId = (typeof TOOL_IDS)[number]

export const PARAMETER_SCHEMAS: Record<BrowserToolId, ParameterSchemaSpec> = {
  browser_start: {
    url: { type: "string", required: true, description: "URL to open in Chromium." },
  },
  browser_goto: {
    url: { type: "string", required: true, description: "URL to navigate the active tab to." },
  },
  browser_refresh: {},
  browser_restore_state: {
    stateId: { type: "string", required: true, description: "Snapshot state ID such as tab0-dom3." },
  },
  browser_new_tab: {
    url: { type: "string", description: "Optional URL to open in the new tab." },
  },
  browser_switch_tab: {
    tabId: { type: "string", required: true, description: "Tab ID to activate." },
  },
  browser_close_tab: {
    tabIds: { type: "array", items: { type: "string" }, description: "Tab IDs to close; omit for the active tab." },
  },
  browser_click: {
    elementIndex: { type: "integer", required: true, description: "Numeric [N] or <N> element marker from the current DOM snapshot." },
  },
  browser_input: {
    elementIndex: { type: "integer", required: true, description: "Numeric <N> input marker from the current DOM snapshot." },
    text: { type: "string", required: true, description: "Text or value to enter." },
    clear: { type: "boolean", description: "Clear the existing value first; defaults to true." },
    pressEnter: { type: "boolean", description: "Press Enter after input; defaults to false." },
  },
  browser_reveal_offscreen: {
    direction: { type: "string", required: true, enum: ["up", "down"], description: "Direction of the OFF-SCREEN block." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
    target: { type: "string", description: "Optional element/text copied from the OFF-SCREEN block." },
  },
  browser_scroll_next_screen: {
    direction: { type: "string", required: true, enum: ["up", "down"], description: "Direction to explore." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
  },
  browser_scroll_to_page: {
    page: { type: "number", required: true, description: "Target P page position from the scroll map." },
    container: { type: "integer", required: true, description: "Scroll-container index from [container:N]." },
  },
  browser_execute_script: {
    script: { type: "string", required: true, description: "JavaScript function body executed in the active page." },
  },
  browser_view_elements: {
    viewIds: { type: "array", required: true, items: { type: "string" }, description: "View IDs from [view:ID] markers." },
  },
  browser_wait: {
    seconds: { type: "number", required: true, description: "Seconds to wait before continuing." },
  },
}

export const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", required: true, const: "success" },
    summary: { type: "string", required: true },
    output: { type: "string", required: true },
    next_actions: { type: "array", required: true, items: { type: "string" } },
    artifacts: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          name: { type: "string", required: true },
          media_type: { type: "string", required: true },
        },
      },
    },
    metadata: { type: "json", required: true },
    images: { type: "array", required: true, items: { type: "json" } },
  },
} as const satisfies ValueSchemaSpec
