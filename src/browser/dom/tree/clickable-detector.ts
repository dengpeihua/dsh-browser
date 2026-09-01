/**
 * Interaction and fillability heuristics.
 *
 * isInteractive combines native tags, ARIA roles, event attributes, snapshot
 * clickability, and cursor styles after rejecting disabled or hidden nodes.
 * isFillable recognizes text controls and directly settable value controls.
 * Descendant checks keep wrapper elements from taking the interaction signal
 * from a more specific child control.
 */

import type { EnhancedDOMTreeNode } from '../types/dom-node';
import {
  NodeType,
  INTERACTIVE_TAGS,
  INTERACTIVE_ROLES,
} from '../types/dom-node';

/**
 * You need to set value directly by JavaScript instead of the type input that you entered by simulating keyboard text.
 * These elements are still filled in controls, but are interactive using <.value = str and dispatching events instead of insertText.
 */
export const VALUE_SETTABLE_INPUT_TYPES = new Set([
  'range',
  'color',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

/**
 * Shows the event properties of HTML elements that are interactive.
 */
const INTERACTIVE_ATTRIBUTES = new Set([
  'onclick',
  'onmousedown',
  'onmouseup',
  'onkeydown',
  'onkeyup',
]);

/**
 * Recursively check regular children, shadow roots, and iframe documents for a non-text
 * descendant with an explicit cursor. Text nodes are ignored because they are not a more
 * specific interactive target.
 */
function hasNonTextDescendantWithCursor(
  node: EnhancedDOMTreeNode,
  cursor: string,
): boolean {
  for (const child of node.childrenNodes ?? []) {
    if (
      child.nodeType !== NodeType.TEXT_NODE &&
      child.snapshotNode?.cursorStyle === cursor
    )
      return true;
    if (hasNonTextDescendantWithCursor(child, cursor)) return true;
  }
  for (const shadow of node.shadowRoots ?? []) {
    if (
      shadow.nodeType !== NodeType.TEXT_NODE &&
      shadow.snapshotNode?.cursorStyle === cursor
    )
      return true;
    if (hasNonTextDescendantWithCursor(shadow, cursor)) return true;
  }
  if (node.contentDocument) {
    if (
      node.contentDocument.nodeType !== NodeType.TEXT_NODE &&
      node.contentDocument.snapshotNode?.cursorStyle === cursor
    )
      return true;
    if (hasNonTextDescendantWithCursor(node.contentDocument, cursor))
      return true;
  }
  return false;
}

/**
 * Recursively inspect regular children, shadow roots, and iframe documents for a descendant
 * whose DOMSnapshot data marks it as clickable. This reads snapshotNode.isClickable directly,
 * so it does not depend on the order in which descendant renderInfo values are computed.
 */
function hasClickableDescendant(node: EnhancedDOMTreeNode): boolean {
  for (const child of node.childrenNodes ?? []) {
    if (child.snapshotNode?.isClickable) return true;
    if (hasClickableDescendant(child)) return true;
  }
  for (const shadow of node.shadowRoots ?? []) {
    if (shadow.snapshotNode?.isClickable) return true;
    if (hasClickableDescendant(shadow)) return true;
  }
  if (node.contentDocument) {
    if (node.contentDocument.snapshotNode?.isClickable) return true;
    if (hasClickableDescendant(node.contentDocument)) return true;
  }
  return false;
}

/**
 * Interactive element detector.
 */
export class ClickableElementDetector {
  /**
   * Determines whether the node is interactive or clickable.
   * Each branch returns by a short route of priority and records the reasons for the first hit or rejection through interactiveReason for debugging the interactive rule.
   */
  static isInteractive(node: EnhancedDOMTreeNode): boolean {
    const setReason = (reason: string) => {
      if (node.renderInfo) {
        node.renderInfo.interactiveReason = reason;
      }
    };

    // Step 1: Non-elementary nodes such as text, notes, Document cannot be used as interactive targets.
    if (node.nodeType !== NodeType.ELEMENT_NODE) {
      setReason('not element node');
      return false;
    }

    const tagName = node.nodeName.toLowerCase();

    // html/body is only a root container of the page, and even if the snapshot contains a click signal, it is not a specific interactive target.
    if (tagName === 'html' || tagName === 'body') {
      setReason(`skip ${tagName} tag`);
      return false;
    }

    // disabled, aria-disabled and aria-hidden are the highest priority conditions for rejection.
    if (node.attributes) {
      if (
        node.attributes.disabled !== undefined ||
        node.attributes['aria-disabled'] === 'true'
      ) {
        setReason('disabled');
        return false;
      }

      if (node.attributes['aria-hidden'] === 'true') {
        setReason('aria-hidden');
        return false;
      }
    }

    // Primary interactive labels are the most reliable positive signals, such as button, input, a and select.
    if (INTERACTIVE_TAGS.has(tagName)) {
      setReason(`interactive tag: ${tagName}`);
      return true;
    }

    // Non-natural controls can express interactive semantics through event properties or ARIA role.
    if (node.attributes) {
      const matchedAttr = Array.from(INTERACTIVE_ATTRIBUTES).find(
        attr => attr in node.attributes,
      );
      if (matchedAttr) {
        setReason(`interactive attribute: ${matchedAttr}`);
        return true;
      }

      // Check interactive ARIA roles such as button, link, checkbox, and textbox.
      const role = node.attributes.role;
      if (role && INTERACTIVE_ROLES.has(role)) {
        setReason(`interactive role: ${role}`);
        return true;
      }
    }

    // cursor:pointer is an interactive hint at CSS levels.
    if (node.snapshotNode?.cursorStyle === 'pointer') {
      setReason('cursor: pointer');
      return true;
    }

    // The current cursor nodes text are considered interactive targets only if more specific cursor:text elements do not exist for descendants;
    // Otherwise, it is likely that the current node will only be a container for a genuine input box.
    if (node.snapshotNode?.cursorStyle === 'text') {
      if (!hasNonTextDescendantWithCursor(node, 'text')) {
        setReason('cursor: text');
        return true;
      }
    }

    if (node.snapshotNode?.isClickable) {
      // isClickable will be attributed to the current node only if descendants do not have Snapshot clickable nodes;
      // Otherwise, it is likely that the current node will be only a container for a genuine interactive sub-element.
      if (!hasClickableDescendant(node)) {
        setReason('isClickable');
        return true;
      }
    }

    setReason('no interactive indicators');
    return false;
  }

  /**
   * Determines whether the element can be filled in, i.e. receive text input or directly set values by value.
   * This function determines only the type of control and is not responsible for visibility, disablement, shielding and final candidate numbering.
   */
  static isFillable(node: EnhancedDOMTreeNode): boolean {
    if (node.nodeType !== NodeType.ELEMENT_NODE) {
      return false;
    }

    const tagName = node.nodeName.toLowerCase();

    // textarea always belongs to fillable elements by control type.
    if (tagName === 'textarea') {
      return true;
    }

    // input Defaults can be filled, but buttons, selection classes, files and hidden input types are excluded.
    if (tagName === 'input') {
      const inputType = (node.attributes?.type ?? 'text').toLowerCase();
      const nonFillableTypes = new Set([
        'button',
        'submit',
        'reset',
        'image',
        'checkbox',
        'radio',
        'file',
        'hidden',
      ]);
      return !nonFillableTypes.has(inputType);
    }

    // ARIA slider completes by directly setting values.
    if (node.attributes?.role === 'slider') {
      return true;
    }

    // An explicit contenteditable=true element can receive text.
    if (node.attributes?.contenteditable === 'true') {
      return true;
    }

    // The custom control role =textbox is processed by text input area.
    if (node.attributes?.role === 'textbox') {
      return true;
    }

    // cursor:text may serve as a backup signal for the fillable area, except for the parent container of the actual input sub-element.
    if (node.snapshotNode?.cursorStyle === 'text') {
      if (!hasNonTextDescendantWithCursor(node, 'text')) {
        return true;
      }
    }

    return false;
  }
}
