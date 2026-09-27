import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { defineView, layoutOf, ordered, type ViewState } from "../src"
import { useView } from "../src/react"

// A throwaway web renderer: proof that a view renders on a platform other than the terminal, from the contract alone.
const WebView = (props: { view: ViewState }) => {
  const v = useView(props.view)
  return (
    <main>
      {ordered(props.view.layout).map((s, i) => (
        <section key={s.id} data-role={s.role} data-focused={v.ui.focus === i}>
          <h2>{s.title ?? s.id}</h2>
          {s.kind === "log" ? (props.view.data[s.id] as { lines: ReadonlyArray<{ text: string }> } | undefined)?.lines.map((l, j) => <p key={j}>{l.text}</p>) : null}
        </section>
      ))}
    </main>
  )
}

test("a view renders to HTML with react-dom from the contract alone", () => {
  const view: ViewState = { agent: "a", layout: layoutOf(defineView("demo", { steps: { kind: "log", role: "log", title: "Steps" }, top: { kind: "stats", role: "summary" } })), data: { steps: { lines: [{ text: "UX-1 ok" }] } } }
  const html = renderToStaticMarkup(<WebView view={view} />)
  expect(html).toBe('<main><section data-role="summary" data-focused="true"><h2>top</h2></section><section data-role="log" data-focused="false"><h2>Steps</h2><p>UX-1 ok</p></section></main>')
})
