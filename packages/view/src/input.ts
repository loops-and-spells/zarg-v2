/** A key as any platform reports it. */
export interface InputKey { readonly name: string; readonly ctrl?: boolean; readonly meta?: boolean; readonly shift?: boolean }
/** One line of a hint: the keys and what they do. */
export interface KeyHint { readonly keys: string; readonly does: string }
export type Handled<U, A> = { readonly ui: U; readonly action?: A; readonly draft?: string }

/** One owner of keys. Layers are derived from state (`when`), never pushed: close the thing and its layer is gone. */
export interface InputLayer<U, W, A> {
  readonly id: string
  /** Takes every key (a dialog): the layers below it neither get keys nor show hints. */
  readonly exclusive?: boolean
  readonly when: (ui: U, world: W) => boolean
  readonly hints: (ui: U, world: W) => ReadonlyArray<KeyHint>
  /** Handle the key, or pass it down. */
  readonly handle: (ui: U, world: W, key: InputKey) => Handled<U, A> | "pass"
}

/** The layers on the stack now, top first (`layers` is given top first). */
export const stackOf = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W) => layers.filter((l) => l.when(ui, world))

/** The key goes to the top layer; each handles it or passes it down; a key no layer owns does nothing. */
export const dispatch = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, key: InputKey): Handled<U, A> & { readonly by?: string } => {
  for (const l of stackOf(layers, ui, world)) {
    const r = l.handle(ui, world, key)
    if (r !== "pass") return { ...r, by: l.id }
  }
  return { ui }
}

/** What the status line shows: the hints of the top `limit` layers below the global one, none below an exclusive one. */
export const hintsOf = <U, W, A>(layers: ReadonlyArray<InputLayer<U, W, A>>, ui: U, world: W, limit = 2): ReadonlyArray<KeyHint> => {
  const stack = stackOf(layers, ui, world).filter((l) => l.id !== "global")
  const top = stack.findIndex((l) => l.exclusive === true)
  return (top < 0 ? stack : stack.slice(0, top + 1)).slice(0, limit).flatMap((l) => l.hints(ui, world))
}

/** A key a text input takes as text: one character, space or Backspace, without Ctrl or Alt. */
export const printable = (key: InputKey) => key.ctrl !== true && key.meta !== true && (key.name.length === 1 || key.name === "space" || key.name === "backspace")
