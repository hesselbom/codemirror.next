import {Text} from "../../text"
import {Extension, Configuration} from "../../extension"
import {Annotation, allowMultipleSelections, extendState} from "./extension"
import {EditorState} from "./state"
import {EditorSelection, SelectionRange} from "./selection"
import {Change, ChangeSet} from "./change"

const enum Flag { SelectionSet = 1, ScrollIntoView = 2, Reconfigure = 4 }

/// Changes to the editor state are grouped into transactions.
/// Usually, a user action creates a single transaction, which may
/// contain zero or more document changes. Create a transaction by
/// calling [`EditorState.t`](#state.EditorState.t).
///
/// Transactions are mutable, and usually built up piece by piece with
/// updating methods and method chaining (most methods return the
/// transaction itself). Once they are
/// [applied](#state.Transaction.apply), they can't be updated
/// anymore.
export class Transaction {
  /// The document changes made by this transaction.
  changes: ChangeSet = ChangeSet.empty
  /// The document versions after each of the changes.
  docs: Text[] = []
  /// The selection at the end of the transaction.
  selection: EditorSelection
  private _annotations: Annotation<any>[]
  private flags: number = 0
  /// @internal
  configuration: Configuration<EditorState>
  private state: EditorState | null = null

  /// @internal
  constructor(
    /// The state from which the transaction starts.
    readonly startState: EditorState,
    time: number = Date.now()
  ) {
    this.selection = startState.selection
    this._annotations = [Transaction.time(time)]
    this.configuration = startState.configuration
  }

  /// The document at the end of the transaction.
  get doc(): Text {
    let last = this.docs.length - 1
    return last < 0 ? this.startState.doc : this.docs[last]
  }

  /// Add annotations to this transaction. Annotations can provide
  /// additional information about the transaction.
  annotate(...annotations: Annotation<any>[]): Transaction {
    this.ensureOpen()
    for (let ann of annotations) this._annotations.push(ann)
    return this
  }

  /// Get the value of the given annotation type, if any.
  annotation<T>(type: (value: T) => Annotation<T>): T | undefined {
    for (let i = this._annotations.length - 1; i >= 0; i--)
      if (this._annotations[i].type == type) return this._annotations[i].value as T
    return undefined
  }

  /// Get all values associated with the given annotation in this
  /// transaction.
  annotations<T>(type: (value: T) => Annotation<T>): readonly T[] {
    let found = none as T[]
    for (let ann of this._annotations) {
      if (ann.type == type) {
        if (found == none) found = []
        found.push(ann.value as T)
      }
    }
    return found
  }

  /// Add a change to this transaction. If `mirror` is given, it
  /// should be the index (in `this.changes.changes`) at which the
  /// mirror image of this change sits.
  change(change: Change, mirror?: number): Transaction {
    this.ensureOpen()
    if (change.from == change.to && change.length == 0) return this
    if (change.from < 0 || change.to < change.from || change.to > this.doc.length)
      throw new RangeError(`Invalid change ${change.from} to ${change.to}`)
    this.changes = this.changes.append(change, mirror)
    this.docs.push(change.apply(this.doc))
    this.selection = this.selection.map(change)
    return this
  }

  /// Indicates whether the transaction changed the document.
  get docChanged(): boolean {
    return this.changes.length > 0
  }

  /// Add a change replacing the given document range with the given
  /// content.
  replace(from: number, to: number, text: string | readonly string[]): Transaction {
    return this.change(new Change(from, to, typeof text == "string" ? this.startState.splitLines(text) : text))
  }

  /// Replace all selection ranges with the given content.
  replaceSelection(text: string | readonly string[]): Transaction {
    let content = typeof text == "string" ? this.startState.splitLines(text) : text
    return this.forEachRange(range => {
      let change = new Change(range.from, range.to, content)
      this.change(change)
      return new SelectionRange(range.from + change.length)
    })
  }

  /// Run the given function for each selection range. The method will
  /// map the ranges to reflect deletions/insertions that happen
  /// before them. At the end, set the new selection to the ranges
  /// returned by the function (again, automatically mapped to for
  /// changes that happened after them).
  forEachRange(f: (range: SelectionRange, tr: Transaction) => SelectionRange): Transaction {
    let sel = this.selection, start = this.changes.length, newRanges: SelectionRange[] = []
    for (let range of sel.ranges) {
      let before = this.changes.length
      let result = f(range.map(this.changes.partialMapping(start)), this)
      if (this.changes.length > before) {
        let mapping = this.changes.partialMapping(before)
        for (let i = 0; i < newRanges.length; i++) newRanges[i] = newRanges[i].map(mapping)
      }
      newRanges.push(result)
    }
    return this.setSelection(EditorSelection.create(newRanges, sel.primaryIndex))
  }

  /// Update the selection.
  setSelection(selection: EditorSelection): Transaction {
    this.ensureOpen()
    this.selection = this.startState.behavior(allowMultipleSelections) ? selection : selection.asSingle()
    this.flags |= Flag.SelectionSet
    return this
  }

  /// Tells you whether this transaction explicitly sets a new
  /// selection (as opposed to just mapping the selection through
  /// changes).
  get selectionSet(): boolean {
    return (this.flags & Flag.SelectionSet) > 0
  }

  /// Set a flag on this transaction that indicates that the editor
  /// should scroll the selection into view after applying it.
  scrollIntoView(): Transaction {
    this.ensureOpen()
    this.flags |= Flag.ScrollIntoView
    return this
  }

  /// Query whether the selection should be scrolled into view after
  /// applying this transaction.
  get scrolledIntoView(): boolean {
    return (this.flags & Flag.ScrollIntoView) > 0
  }

  /// Replace one or more [named
  /// extensions](#extension.ExtensionGroup.defineName) with new
  /// instances, creating a new configuration for the new state.
  replaceExtensions(replace: readonly Extension[]) {
    this.ensureOpen()
    this.configuration = this.configuration.replaceExtensions(replace)
    this.flags |= Flag.Reconfigure
    return this
  }

  /// Move to an entirely new state configuration.
  reconfigure(extensions: readonly Extension[]) {
    this.ensureOpen()
    this.configuration = extendState.resolve(extensions)
    this.flags |= Flag.Reconfigure
    return this
  }

  /// Indicates whether the transaction reconfigures the state.
  get reconfigured(): boolean {
    return (this.flags & Flag.Reconfigure) > 0
  }

  private ensureOpen() {
    if (this.state) throw new Error("Transactions may not be modified after being applied")
  }

  /// Apply this transaction, computing a new editor state. May be
  /// called multiple times (the result is cached). The transaction
  /// cannot be further modified after this has been called.
  apply(): EditorState {
    return this.state || (this.state = this.startState.applyTransaction(this))
  }

  /// Create a set of changes that undo the changes made by this
  /// transaction.
  invertedChanges(): ChangeSet<Change> {
    if (!this.changes.length) return ChangeSet.empty
    let changes: Change[] = [], set = this.changes
    for (let i = set.length - 1; i >= 0; i--)
      changes.push(set.changes[i].invert(i == 0 ? this.startState.doc : this.docs[i - 1]))
    return new ChangeSet(changes, set.mirror.length ? set.mirror.map(i => set.length - i - 1) : set.mirror)
  }

  /// Annotation used to store transaction timestamps.
  static time = Annotation.define<number>()

  /// Annotation used to indicate that this transaction shouldn't
  /// clear the goal column, which is used during vertical cursor
  /// motion (so that moving over short lines doesn't reset the
  /// horizontal position to the end of the shortest line). Should
  /// generally only be set by commands that perform vertical motion.
  static preserveGoalColumn = Annotation.define<boolean>()

  /// Annotation used to associate a transaction with a user interface
  /// event. The view will set this to...
  ///
  ///  - `"paste"` when pasting content
  ///  - `"cut"` when cutting
  ///  - `"drop"` when content is inserted via drag-and-drop
  ///  - `"keyboard"` when moving the selection via the keyboard
  ///  - `"pointer"` when moving the selection through the pointing device
  static userEvent = Annotation.define<string>()

  /// Annotation indicating whether a transaction should be added to
  /// the undo history or not.
  static addToHistory = Annotation.define<boolean>()
}

const none: readonly any[] = []
