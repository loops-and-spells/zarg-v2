import type { Node } from "../src"

export const state = (id: string, text: string): Node => ({ id, type: "t/state", props: { text }, edges: [] })

export const card = (id: string, when: string, arrives: string, then: ReadonlyArray<string>): Node => ({
  id,
  type: "t/card",
  props: { when },
  edges: [{ type: "t/arrives", to: arrives }, ...then.map((to) => ({ type: "t/then", to }))],
})
