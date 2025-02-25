import {EditorView, ViewPlugin, Command, ViewUpdate, Decoration} from "../../view"
import {EditorState, Annotation, EditorSelection, SelectionRange} from "../../state"
import {panels, openPanel, closePanel} from "../../panel"
import {Keymap, NormalizedKeymap, keymap} from "../../keymap"
import {Text} from "../../text"
import {SearchCursor} from "./cursor"
export {SearchCursor}

class Query {
  constructor(readonly search: string,
              readonly replace: string,
              readonly caseInsensitive: boolean) {}

  eq(other: Query) {
    return this.search == other.search && this.replace == other.replace && this.caseInsensitive == other.caseInsensitive
  }

  cursor(doc: Text, from = 0, to = doc.length) {
    return new SearchCursor(doc, this.search, from, to, this.caseInsensitive ? x => x.toLowerCase() : undefined)
  }

  get valid() { return !!this.search }
}

const searchPlugin = ViewPlugin.create(view => new SearchPlugin(view)).decorations(p => p.decorations)

const searchAnnotation = Annotation.define<{query?: Query, panel?: HTMLElement | false}>()

class SearchPlugin {
  panel: null | HTMLElement = null
  query = new Query("", "", false)
  decorations = Decoration.none

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate) {
    let ann = update.annotation(searchAnnotation)
    if (ann) {
      if (ann.query) this.query = ann.query
      if (ann.panel && !this.panel) this.panel = ann.panel
      if (ann.panel == false) this.panel = null
    }
    if (!this.query.search || !this.panel)
      this.decorations = Decoration.none
    else if (ann || update.docChanged || update.transactions.some(tr => tr.selectionSet))
      this.decorations = this.highlight(this.query, update.state, update.viewport)
  }

  highlight(query: Query, state: EditorState, viewport: {from: number, to: number}) {
    let deco = [], cursor = query.cursor(state.doc, Math.max(0, viewport.from - query.search.length),
                                         Math.min(viewport.to + query.search.length, state.doc.length))
    while (!cursor.next().done) {
      let {from, to} = cursor.value
      let selected = state.selection.ranges.some(r => r.from == from && r.to == to)
      deco.push(Decoration.mark(from, to, {class: this.view.cssClass(selected ? "searchMatch.selected" : "searchMatch")}))
    }
    return Decoration.set(deco)
  }
}

/// The configuration options passed to [`search`](#search.search).
export interface SearchConfig {
  /// A keymap with search-related bindings that should be enabled in
  /// the editor. You can pass
  /// [`defaultSearchKeymap`](#search.defaultSearchKeymap) here.
  ///
  /// Configuring bindings like this differs from just passing the
  /// keymap as a separate extension in that the bindings in this
  /// keymap are also available when the search panel is focused.
  keymap?: Keymap

  /// Additional key bindings to enable only in the search panel.
  panelKeymap?: Keymap
}

const panelKeymap = EditorView.extend.behavior<NormalizedKeymap<Command>>()

/// Create an extension that enables search/replace functionality.
/// This needs to be enabled for any of the search-related commands to
/// work.
export const search = EditorView.extend.unique<SearchConfig>((configs: SearchConfig[]) => {
  let keys = Object.create(null), panelKeys = Object.create(null)
  for (let conf of configs) {
    if (conf.keymap) for (let key of Object.keys(conf.keymap)) {
      let value = conf.keymap[key]
      if (keys[key] && keys[key] != value)
        throw new Error("Conflicting keyss for search extension")
      keys[key] = value
      panelKeys[key] = value
    }
    if (conf.panelKeymap) for (let key of Object.keys(conf.panelKeymap)) {
      panelKeys[key] = conf.panelKeymap[key]
    }
  }
  return [
    keymap(keys),
    panelKeymap(new NormalizedKeymap(panelKeys)),
    searchPlugin.extension,
    panels(),
    EditorView.extend.fallback(EditorView.theme(theme))
  ]
}, {})

function beforeCommand(view: EditorView): boolean | SearchPlugin {
  let plugin = view.plugin(searchPlugin)
  if (!plugin) return false
  if (!plugin.panel) {
    openSearchPanel(view)
    return true
  }
  if (!plugin.query.valid) return false
  return plugin
}

/// Open the search panel if it isn't already open, and move the
/// selection to the first match after the current primary selection.
/// Will wrap around to the start of the document when it reaches the
/// end.
export const findNext: Command = view => {
  let plugin = beforeCommand(view)
  if (typeof plugin == "boolean") return plugin
  let cursor = plugin.query.cursor(view.state.doc, view.state.selection.primary.from + 1).next()
  if (cursor.done) {
    cursor = plugin.query.cursor(view.state.doc, 0, view.state.selection.primary.from).next()
    if (cursor.done) return false
  }
  view.dispatch(view.state.t().setSelection(EditorSelection.single(cursor.value.from, cursor.value.to)).scrollIntoView())
  return true
}

const FindPrevChunkSize = 10000

// Searching in reverse is, rather than implementing inverted search
// cursor, done by scanning chunk after chunk forward.
function findPrevInRange(query: Query, doc: Text, from: number, to: number) {
  for (let pos = to;;) {
    let start = Math.max(from, pos - FindPrevChunkSize - query.search.length)
    let cursor = query.cursor(doc, start, pos), range: {from: number, to: number} | null = null
    while (!cursor.next().done) range = cursor.value
    if (range) return range
    if (start == from) return null
    pos -= FindPrevChunkSize
  }
}

/// Move the selection to the previous instance of the search query,
/// before the current primary selection. Will wrap past the start
/// of the document to start searching at the end again.
export const findPrevious: Command = view => {
  let plugin = beforeCommand(view)
  if (typeof plugin == "boolean") return plugin
  let {state} = view, {query} = plugin
  let range = findPrevInRange(query, state.doc, 0, state.selection.primary.to - 1) ||
    findPrevInRange(query, state.doc, state.selection.primary.from + 1, state.doc.length)
  if (!range) return false
  view.dispatch(state.t().setSelection(EditorSelection.single(range.from, range.to)).scrollIntoView())
  return true
}

/// Select all instances of the search query.
export const selectMatches: Command = view => {
  let plugin = beforeCommand(view)
  if (typeof plugin == "boolean") return plugin
  let cursor = plugin.query.cursor(view.state.doc), ranges: SelectionRange[] = []
  while (!cursor.next().done) ranges.push(new SelectionRange(cursor.value.from, cursor.value.to))
  if (!ranges.length) return false
  view.dispatch(view.state.t().setSelection(EditorSelection.create(ranges)))
  return true
}

/// Replace the next instance of the search query.
export const replaceNext: Command = view => {
  let plugin = beforeCommand(view)
  if (typeof plugin == "boolean") return plugin
  let cursor = plugin.query.cursor(view.state.doc, view.state.selection.primary.to).next()
  if (cursor.done) {
    cursor = plugin.query.cursor(view.state.doc, 0, view.state.selection.primary.from).next()
    if (cursor.done) return false
  }
  view.dispatch(view.state.t()
                .replace(cursor.value.from, cursor.value.to, plugin.query.replace)
                .setSelection(EditorSelection.single(cursor.value.from, cursor.value.from + plugin.query.replace.length))
                .scrollIntoView())
  return true
}

/// Replace all instances of the search query with the given
/// replacement.
export const replaceAll: Command = view => {
  let plugin = beforeCommand(view)
  if (typeof plugin == "boolean") return plugin
  let cursor = plugin.query.cursor(view.state.doc), tr = view.state.t()
  while (!cursor.next().done) {
    let {from, to} = cursor.value
    tr.replace(tr.changes.mapPos(from, 1), tr.changes.mapPos(to, -1), plugin.query.replace)
  }
  if (!tr.docChanged) return false
  view.dispatch(tr)
  return true
}

/// Default search-related bindings.
///
///  * Mod-f: [`findNext`](#search.findNext)
///  * Mod-h: [`replaceNext`](#search.replaceNext)
///  * F3: [`findNext`](#search.findNext)
///  * Shift-F3: [`findPrevious`](#search.findPrevious)
export const defaultSearchKeymap = {
  "Mod-f": findNext,
  "Mod-h": replaceNext,
  "F3": findNext,
  "Shift-F3": findPrevious
}

/// Make sure the search panel is open and focused.
export const openSearchPanel: Command = view => {
  let plugin = view.plugin(searchPlugin)!
  if (!plugin) return false
  if (!plugin.panel) {
    let panel = buildPanel({
      view,
      keymap: view.behavior(panelKeymap)[0],
      query: plugin.query,
      updateQuery(query: Query) {
        if (!query.eq(plugin.query))
          view.dispatch(view.state.t().annotate(searchAnnotation({query})))
      }
    })
    view.dispatch(view.state.t().annotate(openPanel({dom: panel, pos: 80, style: "search"}),
                                          searchAnnotation({panel})))
  }
  if (plugin.panel)
    (plugin.panel.querySelector("[name=search]") as HTMLInputElement).select()
  return true
}

/// Close the search panel.
export const closeSearchPanel: Command = view => {
  let plugin = view.plugin(searchPlugin)
  if (!plugin || !plugin.panel) return false
  if (plugin.panel.contains(view.root.activeElement)) view.focus()
  view.dispatch(view.state.t().annotate(closePanel(plugin.panel), searchAnnotation({panel: false})))
  return true
}

function elt(name: string, props: null | {[prop: string]: any} = null, children: (Node | string)[] = []) {
  let e = document.createElement(name)
  if (props) for (let prop in props) {
    let value = props[prop]
    if (typeof value == "string") e.setAttribute(prop, value)
    else (e as any)[prop] = value
  }
  for (let child of children)
    e.appendChild(typeof child == "string" ? document.createTextNode(child) : child)
  return e
}

function buildPanel(conf: {
  keymap: NormalizedKeymap<Command>,
  view: EditorView,
  query: Query,
  updateQuery: (query: Query) => void
}) {
  function p(phrase: string) { return conf.view.phrase(phrase) }
  let searchField = elt("input", {
    value: conf.query.search,
    placeholder: p("Find"),
    "aria-label": p("Find"),
    name: "search",
    onchange: update,
    onkeyup: update
  }) as HTMLInputElement
  let replaceField = elt("input", {
    value: conf.query.replace,
    placeholder: p("Replace"),
    "aria-label": p("Replace"),
    name: "replace",
    onchange: update,
    onkeyup: update
  }) as HTMLInputElement
  let caseField = elt("input", {
    type: "checkbox",
    name: "case",
    checked: !conf.query.caseInsensitive,
    onchange: update
  }) as HTMLInputElement
  function update() {
    conf.updateQuery(new Query(searchField.value, replaceField.value, !caseField.checked))
  }
  function keydown(e: KeyboardEvent) {
    let mapped = conf.keymap.get(e)
    if (mapped && mapped(conf.view)) {
      e.preventDefault()
    } else if (e.keyCode == 27) {
      e.preventDefault()
      closeSearchPanel(conf.view)
    } else if (e.keyCode == 13 && e.target == searchField) {
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(conf.view)
    } else if (e.keyCode == 13 && e.target == replaceField) {
      e.preventDefault()
      replaceNext(conf.view)
    }
  }
  let panel = elt("div", {onkeydown: keydown}, [
    searchField,
    elt("button", {name: "next", onclick: () => findNext(conf.view)}, [p("next")]),
    elt("button", {name: "prev", onclick: () => findPrevious(conf.view)}, [p("previous")]),
    elt("button", {name: "select", onclick: () => selectMatches(conf.view)}, [p("all")]),
    elt("label", null, [caseField, "match case"]),
    elt("br"),
    replaceField,
    elt("button", {name: "replace", onclick: () => replaceNext(conf.view)}, [p("replace")]),
    elt("button", {name: "replaceAll", onclick: () => replaceAll(conf.view)}, [p("replace all")]),
    elt("button", {name: "close", onclick: () => closeSearchPanel(conf.view), "aria-label": p("close")}, ["×"])
  ])
  return panel
}

const theme = {
  "panel.search": {
    padding: "2px 6px 4px",
    position: "relative",
    "& [name=close]": {
      position: "absolute",
      top: "0",
      right: "4px",
      background: "inherit",
      border: "none",
      font: "inherit",
      padding: 0,
      margin: 0
    },
    "& input, & button": {
      verticalAlign: "middle",
      marginRight: ".5em"
    },
    "& label": {
      fontSize: "80%"
    }
  },

  searchMatch: {
    background: "#ffa"
  },

  "searchMatch.selected": {
    background: "#fca"
  }
}
