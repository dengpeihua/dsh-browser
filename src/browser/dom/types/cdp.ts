/**
 * Module overview
 * Responsibility: CDP types for converting CDP page data into stable snapshots and model-facing text.
 * Usage: Called for the active tab by the browser manager and observe, interact, and scroll tools; coordinates tree extraction, snapshot caching, stability checks, rendering, and element references.
 * State and failure boundaries: Browser disconnection, frame reconstruction, page instability, and oversized DOMs must all be handled explicitly.
 * Maintenance: Keep CDP nodeId, backendNodeId, and frameId distinct from model-facing elementIndex values; verify adjacent tests and public types after changes.
 *
 * Execute order (run link):
 * The floor (e.g. browser_observe / browser_get_dom / browser_scroll / browser_reveal_offscreen / browser_interact) requests BrowserManager, after which the current Page session will be read from tab to CDP.
 * 2) The tool determines which to call according to needs CDP domain:
 * - To obtain the full document tree, call DOM.getDocument and read the returned DOM.Node hierarchy.
 * - Layout/geometry information required: call DOMSnapshot.captureSnapshot, get DocumentSnapshot, NodeTreeSnapshot and LayoutTreeSnapshot.
 * - Accessible syntax: call Accessibility.getFullAXTree and get role/name/value/properties from AXNode.
 * - Need page sizes and visuals: Call Page.getLayoutMetrics and get contentSize and visual/layout visuals.
 * - Script performance results are required: Call Runtime.evaluate and get RemoteObject+ possible abnormal stacks.
 * - Page cut/window context management: maintain session boundaries by target/attach associated metadata.
 * The browser tool decodes the original structure of CDP by "index table + parallel arrays " :
 * - DOMSnapshot.CaptureSnapshotResponse.documents is a document-level array with a single DocumentSnapshot holding a large number of index arrays (nodeType, nodeName, nodeValue, styles, etc.).
 * - strings Table provides StringIndex-> actual string map (high compression text pool).
 * - Each of the subshots (nodeIndex, parentIndex, layoutIndex, bounds etc.) progresses in an index and must be aligned with the subscripts of the same array.
 * The upstream caller consolidates the decoded structure into an internal DOM model (e.g., visibility, clickability, text box, input box state) and makes a differential/stability judgement compared to the previous snapshot.
 * 5) The final output is modelled by Markdown/TextRenderer to readable description and binds the map relationship between elementIndex (model reference) and the real DOM node reference (backendNodeId/nodeId).
 *
 * Calculate logical elements:
 * - Index Drive is the core: large arrays are not single object arrays, but flat arrays.
 * For example, nodeType [i] corresponds to the logical node i in NodeTreeSnapshot, attributes [i] may be an attribute string indexing list.
 * - The type conversion must be preceded by the identification of fields: DOM, Accessibility, Layout and Runtime data from different categories domain, which, although stated in the same document, cannot be confused with each other.
 * - Under the page instability scene, priority should be given to multi-step snapshots + retry strategy: read layout viewport/scroll information first, confirm the visibility range, then explain the click, input, scrolling command and reduce off-screen/overlap error.
 * - backendNodeId is not the semantic of nodeId calculations: the former is closer to the life-cycle positioning of CDP runtime and the latter is more DOM Query returns; elementIndex is the serialized index on the side of the model.
 * - Options (depth/pierce/timeout/include*) in all domain interface parameters directly affect downstream complexity and stability; too deep or too much switches magnify DOM construction and diff costs.
 *
 * Other Organiser
 * - This document defines only TypeScript types and does not directly execute network requests; real failure retry, reconnection, DOM differential, filtering and rendering are all done at the call end.
 * - Any cross-file modification needs to be synchronized to update the decomposition constraints in the running time code to avoid decode errors due to changes in field name or numbering.
 *
 * DOM Type distinction (mean):
 * - DOMSnapshot: CDP Quickshot of the domain Compressed binary array structure for high performance differential modelling.
 * - DOM: A more intuitive tree structure response that allows for retrieving and fast searching for paternity.
 * - Accessibility: Auxiliary technology tree (role/name/relationship) used for operational extrapolation and model hint noise reduction.
 * - Page: The visual and layout indicators are determined by region and coordinates.
 * - Target: Tab/session target metadata determine which targetId/sessionId to send to.
 * - Runtime: Script execution capability to provide return values, anomalies and stacks to support dynamic reading on page.
 */

export namespace DOMSnapshot {
  export interface CaptureSnapshotParams {
    computedStyles: string[]
    includePaintOrder?: boolean
    includeDOMRects?: boolean
    includeBlendedBackgroundColors?: boolean
    includeTextColorOpacities?: boolean
  }

  export interface RareBooleanData {
    index: number[]
  }

  export interface NodeTreeSnapshot {
    parentIndex?: number[]
    nodeType?: number[]
    shadowRootType?: StringIndex[]
    nodeName?: StringIndex[]
    nodeValue?: StringIndex[]
    backendNodeId?: number[]
    attributes?: ArrayOfStrings[]
    textValue?: StringIndex[]
    inputValue?: StringIndex[]
    inputChecked?: RareBooleanData
    optionSelected?: RareBooleanData
    contentDocumentIndex?: number[]
    pseudoElementIndexes?: ArrayOfArrayOfIntegers[]
    layoutNodeIndex?: number[]
    isClickable?: RareBooleanData
    currentSourceURL?: StringIndex[]
    originURL?: StringIndex[]
  }

  export interface LayoutTreeSnapshot {
    nodeIndex: number[]
    bounds: number[][]
    text?: StringIndex[]
    paintOrders?: number[]
    offsetRects?: number[][]
    scrollRects?: number[][]
    clientRects?: number[][]
    blendedBackgroundColors?: StringIndex[]
    textColorOpacities?: number[]
    styles?: ArrayOfStrings[]
    stackingContexts?: RareBooleanData
  }

  export interface TextBoxSnapshot {
    layoutIndex: number[]
    bounds: number[][]
    start: number[]
    length: number[]
  }

  export interface DocumentSnapshot {
    documentURL: number
    title: number
    baseURL: number
    contentLanguage: number
    encodingName: number
    publicId: number
    systemId: number
    frameId: number
    nodes: NodeTreeSnapshot
    layout: LayoutTreeSnapshot
    textBoxes: TextBoxSnapshot
    scrollOffsetX?: number
    scrollOffsetY?: number
    contentWidth?: number
    contentHeight?: number
  }

  export interface CaptureSnapshotResponse {
    documents: DocumentSnapshot[]
    strings: string[]
  }

  export type StringIndex = number
  export type ArrayOfStrings = StringIndex[]
  export type ArrayOfArrayOfIntegers = number[][]
}

export namespace DOM {
  export interface GetDocumentParams {
    depth?: number
    pierce?: boolean
  }

  export interface Node {
    nodeId: number
    parentId?: number
    backendNodeId: number
    nodeType: number
    nodeName: string
    localName: string
    nodeValue: string
    childNodeCount?: number
    children?: Node[]
    attributes?: string[]
    documentURL?: string
    baseURL?: string
    publicId?: string
    systemId?: string
    internalSubset?: string
    xmlVersion?: string
    name?: string
    value?: string
    contentDocument?: Node
    shadowRoots?: Node[]
    shadowRootType?: "user-agent" | "open" | "closed"
    frameId?: string
    isSVG?: boolean
    isScrollable?: boolean
  }

  export interface GetDocumentResponse {
    root: Node
  }
}

export namespace Accessibility {
  export interface GetFullAXTreeParams {
    depth?: number
    frameId?: string
  }

  export interface AXNode {
    nodeId: string
    backendDOMNodeId?: number
    ignored: boolean
    ignoredReasons?: AXProperty[]
    role?: AXValue
    chromeRole?: AXValue
    name?: AXValue
    description?: AXValue
    value?: AXValue
    properties?: AXProperty[]
    parentId?: string
    childIds?: string[]
    frameId?: string
  }

  export interface AXProperty {
    name: string
    value: AXValue
  }

  export interface AXValue {
    type: string
    value?: any
    relatedNodes?: AXRelatedNode[]
    sources?: AXValueSource[]
  }

  export interface AXRelatedNode {
    backendDOMNodeId: number
    idref?: string
    text?: string
  }

  export interface AXValueSource {
    type: string
    value?: AXValue
    attribute?: string
    attributeValue?: AXValue
    superseded?: boolean
    nativeSource?: string
    nativeSourceValue?: AXValue
    invalid?: boolean
    invalidReason?: string
  }

  export interface GetFullAXTreeResponse {
    nodes: AXNode[]
  }
}

export namespace Page {
  export interface LayoutViewport {
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
  }

  export interface VisualViewport {
    offsetX: number
    offsetY: number
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
    scale: number
    zoom?: number
  }

  export interface CSSVisualViewport {
    offsetX: number
    offsetY: number
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
    scale: number
    zoom?: number
  }

  export interface CSSLayoutViewport {
    pageX: number
    pageY: number
    clientWidth: number
    clientHeight: number
  }

  export interface GetLayoutMetricsResponse {
    layoutViewport: LayoutViewport
    visualViewport: VisualViewport
    contentSize: {
      x: number
      y: number
      width: number
      height: number
    }
    cssContentSize?: {
      x: number
      y: number
      width: number
      height: number
    }
    cssVisualViewport?: CSSVisualViewport
    cssLayoutViewport?: CSSLayoutViewport
  }

  export interface FrameTree {
    frame: Frame
    childFrames?: FrameTree[]
  }

  export interface Frame {
    id: string
    parentId?: string
    loaderId: string
    name?: string
    url: string
    urlFragment?: string
    domainAndRegistry?: string
    securityOrigin: string
    mimeType: string
    unreachableUrl?: string
  }

  export interface GetFrameTreeResponse {
    frameTree: FrameTree
  }
}

export namespace Target {
  export type TargetID = string
  export type SessionID = string

  export interface TargetInfo {
    targetId: TargetID
    type: string
    title: string
    url: string
    attached: boolean
    openerId?: TargetID
    canAccessOpener: boolean
    openerFrameId?: string
    browserContextId?: string
    subtype?: string
  }

  export interface AttachedToTargetEvent {
    sessionId: SessionID
    targetInfo: TargetInfo
    waitingForDebugger: boolean
  }

  export interface SetAutoAttachParams {
    autoAttach: boolean
    waitForDebuggerOnStart: boolean
    flatten: boolean
  }

  export interface GetFrameOwnerResponse {
    backendNodeId: number
    nodeId?: number
  }
}

export namespace Runtime {
  export interface EvaluateParams {
    expression: string
    objectGroup?: string
    includeCommandLineAPI?: boolean
    silent?: boolean
    contextId?: number
    returnByValue?: boolean
    generatePreview?: boolean
    userGesture?: boolean
    awaitPromise?: boolean
    throwOnSideEffect?: boolean
    timeout?: number
    disableBreaks?: boolean
    replMode?: boolean
    allowUnsafeEvalBlockedByCSP?: boolean
    uniqueContextId?: string
  }

  export interface EvaluateResponse {
    result: RemoteObject
    exceptionDetails?: ExceptionDetails
  }

  export interface RemoteObject {
    type: string
    subtype?: string
    className?: string
    value?: any
    unserializableValue?: string
    description?: string
    objectId?: string
    preview?: ObjectPreview
    customPreview?: CustomPreview
  }

  export interface ObjectPreview {
    type: string
    subtype?: string
    description?: string
    overflow: boolean
    properties: PropertyPreview[]
    entries?: EntryPreview[]
  }

  export interface PropertyPreview {
    name: string
    type: string
    value?: string
    valuePreview?: ObjectPreview
    subtype?: string
  }

  export interface EntryPreview {
    key?: ObjectPreview
    value: ObjectPreview
  }

  export interface CustomPreview {
    header: string
    bodyGetterId?: string
  }

  export interface ExceptionDetails {
    exceptionId: number
    text: string
    lineNumber: number
    columnNumber: number
    scriptId?: string
    url?: string
    stackTrace?: StackTrace
    exception?: RemoteObject
    executionContextId?: number
  }

  export interface StackTrace {
    description?: string
    callFrames: CallFrame[]
    parent?: StackTrace
    parentId?: StackTraceId
  }

  export interface CallFrame {
    functionName: string
    scriptId: string
    url: string
    lineNumber: number
    columnNumber: number
  }

  export interface StackTraceId {
    id: string
    debuggerId?: string
  }
}
