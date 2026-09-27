import { useState } from "react"
import { actionFor, afterAction, focusNext, initialViewUi, moveRow, nextTab, toggleSelect, type ViewUi } from "./behaviour"
import type { ViewState } from "./reducer"

/** A view's behaviour for any React platform: the state and the calls keys, clicks or touches make. */
export const useView = (view: ViewState | undefined) => {
  const [ui, setUi] = useState<ViewUi>(initialViewUi)
  const on = (f: (v: ViewState, u: ViewUi) => ViewUi) => () => view !== undefined && setUi((u) => f(view, u))
  return {
    ui,
    focusNext: (dir: 1 | -1) => on((v, u) => focusNext(v, u, dir))(),
    nextTab: (dir: 1 | -1) => on((v, u) => nextTab(v, u, dir))(),
    moveRow: (delta: number) => on((v, u) => moveRow(v, u, delta))(),
    toggleSelect: on(toggleSelect),
    /** The action this key triggers (the caller sends it), clearing the table's selection. */
    action: (key: string) => {
      const a = view === undefined ? undefined : actionFor(view, ui, key)
      if (a !== undefined) setUi((u) => afterAction(u, a.section))
      return a
    },
  }
}
