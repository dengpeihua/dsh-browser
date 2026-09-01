/**
 * Page-context query, reference, and serialization helpers.
 *
 * PAGE_TOOLS_SCRIPT installs __q, __get, __find, __clickable, and __serialize
 * once per page. Element results receive stable per-page references and are
 * converted to JSON-transferable metadata. wrapScript injects the helpers,
 * executes the requested function with document.documentElement as this, and
 * serializes its result for the browser tool.
 */
const HL_ATTR = 'data-hl-idx';

const PAGE_TOOLS_SCRIPT = `
(function() {
  // [1] Snippet portal: first execution will continue and once injected will return directly to avoid repeated global contamination
  if (window.__q) return; // already injected

  // [2] Initialized reference table. Next __get/__serialize use it to do the Element Reference Map
  window.__refs = [];

  // [3] enrich Process:
  // 3.1 Generate/reuse ref (rN)
  // Extract the index from data-hl-idx.
  // 3.3 Collect element properties and crop super long text
  // Mark to avoid repetition
  window.__enrich = function(el) {
    if (!el || el.__enriched) return el;
    var id = window.__refs.length;
    window.__refs.push(el);
    el.ref = 'r' + id;
    var hlEl = el.closest('[${HL_ATTR}]');
    el.index = hlEl ? parseInt(hlEl.getAttribute('${HL_ATTR}')) : null;
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name !== '${HL_ATTR}') attrs[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value;
    }
    el.attrs = attrs;
    el.__enriched = true;
    return el;
  };

  // [4] Query by highlighted serial number: Map data-hl-idx back to the real DOM node and enrich
  window.__q = function(n) {
    return __enrich(document.querySelector('[${HL_ATTR}="' + n + '"]'));
  };

  // [5] Invert by id: rN - > From __refs array back to the real DOM node, then enrich
  window.__get = function(id) {
    var numId = typeof id === 'string' && id.charAt(0) === 'r' ? parseInt(id.slice(1)) : id;
    var el = window.__refs[numId] || null;
    return el ? __enrich(el) : null;
  };

  // [6] Query process:
  // (body or __q (n))
  // 6.2 Text Node/Element Node Everywhere. Calendar
  // 6.3 Text, Properties, Usual Fields (value/href/src/action/dataset)
  // 6.4 after hit enrich and add the result to the maximum rule 20
  window.__find = function(pattern, tag, n) {
    // __find(pattern, tag?, n?) — pattern: regex string, tag: tag name filter, n: scope element
    if (typeof tag === 'number') { n = tag; tag = undefined; }
    var root = n !== undefined ? __q(n) : document.body;
    if (!root) return [];
    var re = pattern ? new RegExp(pattern, 'i') : null;
    var tagFilter = tag ? tag.toLowerCase() : null;
    var limit = 20;
    var results = [];
    var seen = new Set();
    var test = function(text) { return re && re.test(text); };
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode()) && results.length < limit) {
      if (node.nodeType === 3 && re) {
        var parent = node.parentElement;
        if (!parent || seen.has(parent)) continue;
        if (tagFilter && parent.tagName.toLowerCase() !== tagFilter) continue;
        if (test(node.textContent || '')) {
          seen.add(parent); results.push(__enrich(parent));
        }
      } else if (node.nodeType === 1) {
        if (seen.has(node)) continue;
        var el = node;
        if (tagFilter && el.tagName.toLowerCase() !== tagFilter) continue;
        if (!re) { seen.add(el); results.push(__enrich(el)); continue; }
        var found = false;
        var attrs = el.attributes;
        for (var i = 0; !found && i < attrs.length; i++) {
          if (test(attrs[i].value)) found = true;
        }
        if (!found) {
          var props = [el.value, el.href, el.src, el.action, el.dataset && Object.values(el.dataset).join(' ')].filter(Boolean);
          for (var i = 0; !found && i < props.length; i++) {
            if (test(String(props[i]))) found = true;
          }
        }
        if (found) { seen.add(el); results.push(__enrich(el)); }
      }
    }
    return results;
  };

  // [7] Pointable elements extend:
  // 7.1 Finds a clickable candidate up to the parent node
  // 7.2 Current subnode
  // 7.3 Then go to the parent container and find the clickable elements.
  // 7.4 Return the deduplicated, enriched list.
  window.__clickable = function(el) {
    var clickable = 'a,button,summary,input[type="submit"],input[type="button"],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[tabindex],[onclick],[${HL_ATTR}]';
    var results = [];
    var seen = new Set();
    // Walk up ancestors (max 10 levels)
    var node = el;
    for (var i = 0; i < 10 && node && node !== document.body; i++) {
      if (node !== el && node.matches(clickable) && !seen.has(node)) {
        seen.add(node);
        results.push(__enrich(node));
      }
      node = node.parentElement;
    }
    // Search children
    var children = el.querySelectorAll(clickable);
    for (var i = 0; i < children.length; i++) {
      if (!seen.has(children[i])) {
        seen.add(children[i]);
        results.push(__enrich(children[i]));
      }
    }
    // Search parent containers for clickable elements in sibling subtrees
    var parent = el.parentElement;
    for (var i = 0; i < 10 && parent && parent !== document.body; i++) {
      var siblings = parent.querySelectorAll(clickable);
      for (var j = 0; j < siblings.length; j++) {
        if (!seen.has(siblings[j])) {
          seen.add(siblings[j]);
          results.push(__enrich(siblings[j]));
        }
      }
      parent = parent.parentElement;
    }
    return results;
  };

  // [8] Serialization process:
  // 8.1 HTMLElement => { ref,index,tagName,textContent,attrs,... }
  // 8.2 array/object callback __serialize
  // 8.3 Basetype returns as it is
  window.__serialize = function(val) {
    if (val == null) return val;
    if (val instanceof HTMLElement) {
      var id = window.__refs.length;
      window.__refs.push(val);
      var hlEl = val.closest('[${HL_ATTR}]');
      var idx = hlEl ? parseInt(hlEl.getAttribute('${HL_ATTR}')) : null;
      var attrs = {};
      for (var i = 0; i < val.attributes.length; i++) {
        var a = val.attributes[i];
        if (a.name !== '${HL_ATTR}') attrs[a.name] = a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value;
      }
      var info = {
        ref: 'r' + id,
        index: idx,
        tagName: val.tagName,
        textContent: (val.textContent || '').trim().substring(0, 200),
        attrs: attrs,
        childElementCount: val.childElementCount,
      };
      if ('value' in val && val.value !== '') info.value = val.value;
      if ('checked' in val) info.checked = val.checked;
      if ('selected' in val) info.selected = val.selected;
      if (val.disabled) info.disabled = true;
      if (val.href) info.href = val.href;
      return info;
    }
    if (Array.isArray(val)) return val.map(window.__serialize);
    if (val && typeof val === 'object' && val.constructor === Object) {
      var out = {};
      for (var k in val) {
        if (val.hasOwnProperty(k)) out[k] = window.__serialize(val[k]);
      }
      return out;
    }
    return val;
  };
})();
`;

/**
 * Wrap agent script so that:
 * 1. Page tools are injected if not already present
 * 2. Return value is auto-serialized (elements → { __ref, tag, index })
 */
/**
 * Order of implementation (wrapScript body):
 * 1) Collapse `((function(){...})' () IIFE outer layer.
 * 2) First inject PAGE_TOOLS_SCRIPT to ensure that the page utility function is available.
 * 3) Execute `(function() { ${script} }).call(document.documentElement)` to obtain the result.
 * 4) Finally return __serialize (__result) ', output can transmit data across process.
 */
export function wrapScript(script: string): string {
  return `(function() {
  ${PAGE_TOOLS_SCRIPT}
  var __result = (function() { ${script} }).call(document.documentElement);
  return __serialize(__result);
})()`;
}
