import type { BrowserOperation } from "../runtime.js"
import { browserClick, browserInput } from "./interactions.js"
import { browserGoto, browserRefresh, browserRestoreState } from "./navigation.js"
import { browserViewElements } from "./observe.js"
import { browserExecuteScript } from "./script.js"
import { browserRevealOffscreen, browserScrollNextScreen, browserScrollToPage } from "./scroll.js"
import { browserStart } from "./start.js"
import { browserCloseTab, browserNewTab, browserSwitchTab } from "./tabs.js"
import { browserWait } from "./wait.js"

/** Canonical DSH-native browser operation set; order is the public tool registration order. */
export const BROWSER_OPERATIONS: readonly BrowserOperation[] = [
  browserStart,
  browserGoto,
  browserRefresh,
  browserRestoreState,
  browserNewTab,
  browserSwitchTab,
  browserCloseTab,
  browserClick,
  browserInput,
  browserRevealOffscreen,
  browserScrollNextScreen,
  browserScrollToPage,
  browserExecuteScript,
  browserViewElements,
  browserWait,
]
