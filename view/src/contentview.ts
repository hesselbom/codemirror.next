import {Rect, maxOffset, domIndex} from "./dom"
import {EditorView} from "./editorview"

declare global {
  interface Node { cmView: ContentView | undefined; cmIgnore: boolean | undefined }
}

export const enum Dirty { Not = 0, Child = 1, Node = 2 }

export class DOMPos {
  constructor(readonly node: Node, readonly offset: number, readonly precise = true) {}

  static before(dom: Node, precise?: boolean) { return new DOMPos(dom.parentNode!, domIndex(dom), precise) }
  static after(dom: Node, precise?: boolean) { return new DOMPos(dom.parentNode!, domIndex(dom) + 1, precise) }
}

const none: any[] = []

export abstract class ContentView {
  parent: ContentView | null = null
  dom: Node | null = null
  dirty: number = Dirty.Node
  abstract length: number
  abstract children: ContentView[]
  breakAfter!: number

  get editorView(): EditorView {
    if (!this.parent) throw new Error("Accessing view in orphan content view")
    return this.parent.editorView
  }

  get overrideDOMText(): readonly string[] | null { return null }

  get posAtStart(): number {
    return this.parent ? this.parent.posBefore(this) : 0
  }

  get posAtEnd(): number {
    return this.posAtStart + this.length
  }

  posBefore(view: ContentView): number {
    let pos = this.posAtStart
    for (let child of this.children) {
      if (child == view) return pos
      pos += child.length + child.breakAfter
    }
    throw new RangeError("Invalid child in posBefore")
  }

  posAfter(view: ContentView): number {
    return this.posBefore(view) + view.length
  }

  coordsAt(pos: number): Rect | null { return null }

  sync() {
    if (this.dirty & Dirty.Node) {
      let parent = this.dom as HTMLElement, pos: Node | null = parent.firstChild
      for (let child of this.children) {
        if (child.dirty) {
          if (pos && !child.dom && !pos.cmView) {
            let prev = pos.previousSibling
            if (child.reuseDOM(pos)) pos = prev ? prev.nextSibling : parent.firstChild
          }
          child.sync()
          child.dirty = Dirty.Not
        }
        pos = syncNodeInto(parent, pos, child.dom!)
      }
      while (pos) pos = rm(pos)
    } else if (this.dirty & Dirty.Child) {
      for (let child of this.children) if (child.dirty) {
        child.sync()
        child.dirty = Dirty.Not
      }
    }
  }

  reuseDOM(dom: Node) { return false }

  abstract domAtPos(pos: number): DOMPos

  localPosFromDOM(node: Node, offset: number): number {
    let after: Node | null
    if (node == this.dom) {
      after = this.dom.childNodes[offset]
    } else {
      let bias = maxOffset(node) == 0 ? 0 : offset == 0 ? -1 : 1
      for (;;) {
        let parent = node.parentNode!
        if (parent == this.dom) break
        if (bias == 0 && parent.firstChild != parent.lastChild) {
          if (node == parent.firstChild) bias = -1
          else bias = 1
        }
        node = parent
      }
      if (bias < 0) after = node
      else after = node.nextSibling
    }
    if (after == this.dom.firstChild) return 0
    while (after && !after.cmView) after = after.nextSibling
    if (!after) return this.length

    for (let i = 0, pos = 0;; i++) {
      let child = this.children[i]
      if (child.dom == after) return pos
      pos += child.length + child.breakAfter
    }
  }

  domBoundsAround(from: number, to: number, offset = 0): {startDOM: Node | null, endDOM: Node | null, from: number, to: number} | null {
    let fromI = -1, fromStart = -1, toI = -1, toEnd = -1
    for (let i = 0, pos = offset; i < this.children.length; i++) {
      let child = this.children[i], end = pos + child.length
      if (pos < from && end > to) return child.domBoundsAround(from, to, pos)
      if (end >= from && fromI == -1) { fromI = i; fromStart = pos }
      if (end >= to && toI == -1) { toI = i; toEnd = end; break }
      pos = end + child.breakAfter
    }
    return {from: fromStart, to: toEnd,
            startDOM: (fromI ? this.children[fromI - 1].dom!.nextSibling : null) || this.dom!.firstChild,
            endDOM: toI < this.children.length - 1 ? this.children[toI + 1].dom : null}
  }

  // FIXME track precise dirty ranges, to avoid full DOM sync on every touched node?
  markDirty(andParent: boolean = false) {
    if (this.dirty & Dirty.Node) return
    this.dirty |= Dirty.Node
    this.markParentsDirty(andParent)
  }

  markParentsDirty(childList: boolean) {
    for (let parent = this.parent; parent; parent = parent.parent) {
      if (childList) parent.dirty |= Dirty.Node
      if (parent.dirty & Dirty.Child) return
      parent.dirty |= Dirty.Child
      childList = false
    }
  }

  setParent(parent: ContentView) {
    if (this.parent != parent) {
      this.parent = parent
      if (this.dirty) this.markParentsDirty(true)
    }
  }

  setDOM(dom: Node) {
    this.dom = dom
    dom.cmView = this
  }

  get rootView(): ContentView {
    for (let v: ContentView = this;;) {
      let parent = v.parent
      if (!parent) return v
      v = parent
    }
  }

  replaceChildren(from: number, to: number, children: ContentView[] = none) {
    this.markDirty()
    for (let i = from; i < to; i++) this.children[i].parent = null
    this.children.splice(from, to - from, ...children)
    for (let i = 0; i < children.length; i++) children[i].setParent(this)
  }

  ignoreMutation(rec: MutationRecord): boolean { return false }
  ignoreEvent(event: Event): boolean { return false }

  childCursor(pos: number = this.length) {
    return new ChildCursor(this.children, pos, this.children.length)
  }

  childPos(pos: number, bias: number = 1): {i: number, off: number} {
    return this.childCursor().findPos(pos, bias)
  }

  toString() {
    let name = this.constructor.name.replace("View", "")
    return name + (this.children.length ? "(" + this.children.join() + ")" :
                   this.length ? "[" + (name == "Text" ? (this as any).text : this.length) + "]" : "") +
      (this.breakAfter ? "#" : "")
  }
}

ContentView.prototype.breakAfter = 0

// Remove a DOM node and return its next sibling.
function rm(dom: Node): Node {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next!
}

function syncNodeInto(parent: HTMLElement, pos: Node | null, dom: Node): Node | null {
  if (dom.parentNode == parent) {
    while (pos != dom) pos = rm(pos!)
    pos = dom.nextSibling
  } else {
    parent.insertBefore(dom, pos)
  }
  return pos
}

export class ChildCursor {
  off: number = 0

  constructor(public children: readonly ContentView[], public pos: number, public i: number) {}

  findPos(pos: number, bias: number = 1): this {
    for (;;) {
      if (pos > this.pos || pos == this.pos &&
          (bias > 0 || this.i == 0 || this.children[this.i - 1].breakAfter)) {
        this.off = pos - this.pos
        return this
      }
      let next = this.children[--this.i]
      this.pos -= next.length + next.breakAfter
    }
  }
}
