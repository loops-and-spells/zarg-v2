import { highlight } from "@zarg/highlight"
import { BASE, type BaseKey, makeTheme, PALETTES } from "@zarg/tokens"
import { type Catalog, type Counts, type ScenarioPage, type Status, STATUSES } from "./model"

/** A site path as a URL: each segment percent-encoded (a space, #, ?, %). */
export const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/")

/** Text as HTML text: never markup. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

const STATUS_KEY: Readonly<Record<Status, BaseKey>> = { proven: "ok", failing: "error", stale: "attention", unproven: "dim", planned: "faint" }
const TOKEN_KEY: Readonly<Record<string, BaseKey>> = { keyword: "accent", comment: "dim", string: "ok", number: "attention", persona: "accent", journey: "ok", id: "dim", flow: "accent" }

const vars = (platform: "web.light" | "web.dark") => {
  const theme = makeTheme(PALETTES[platform], platform)
  return (Object.keys(BASE) as Array<BaseKey>).map((k) => `--${k}:${theme.value(k).fg};`).join("")
}
/** The design tokens as CSS: light by default, dark by the system's choice or the viewer's. */
export const css = (): string =>
  [
    `:root{${vars("web.light")}color-scheme:light}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars("web.dark")}color-scheme:dark}}`,
    `:root[data-theme="dark"]{${vars("web.dark")}color-scheme:dark}`,
    `body{margin:0;background:var(--ground);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}`,
    `header{display:flex;flex-wrap:wrap;gap:4px 16px;padding:12px 16px;background:var(--raised);border-bottom:1px solid var(--line)}`,
    `header a{color:var(--text);text-decoration:none}header a:hover{color:var(--accent)}`,
    `main{max-width:1100px;margin:0 auto;padding:16px}`,
    `a{color:var(--accent)}h1,h2,h3{text-wrap:balance;line-height:1.25}`,
    `.id{color:var(--dim);font-family:ui-monospace,monospace;font-size:.9em}`,
    `pre{overflow-x:auto;background:var(--raised);border:1px solid var(--line);padding:10px 12px;font:13px/1.45 ui-monospace,"SF Mono",Menlo,monospace}`,
    `pre.frame{white-space:pre;background:var(--shade)}`,
    `table{border-collapse:collapse}td,th{padding:4px 12px 4px 0;text-align:left;vertical-align:top}.wide{overflow-x:auto}`,
    `.bar{display:flex;height:10px;min-width:120px;border-radius:3px;overflow:hidden;background:var(--shade)}`,
    ...STATUSES.map((s) => `.bar .s-${s}{background:var(--${STATUS_KEY[s]})}.badge.s-${s}{color:var(--${STATUS_KEY[s]});border-color:var(--${STATUS_KEY[s]})}`),
    `.badge{display:inline-block;border:1px solid;border-radius:3px;padding:0 6px;font-size:.8em;font-variant:small-caps;letter-spacing:.03em}`,
    ...Object.entries(TOKEN_KEY).map(([t, k]) => `.t-${t}{color:var(--${k})}`),
    `.t-title{font-weight:600}`,
    `.flow{color:var(--dim);margin:-4px 0 16px}section.step{margin-bottom:8px}`,
    `.absent{color:var(--dim);font-style:italic}figure{margin:12px 0}figcaption{color:var(--dim);font-size:.85em}`,
    `img,video{max-width:100%}.cast{max-width:100%}`,
    `.problem{color:var(--error)}.warning{color:var(--attention)}`,
    `#q{width:100%;max-width:480px;padding:6px 8px;font:inherit;background:var(--raised);color:var(--text);border:1px solid var(--line)}`,
  ].join("\n") + "\n"

/** Data for a script element: JSON that cannot close the element early. */
const scriptData = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c")

const badge = (s: Status) => `<span class="badge s-${s}">${s}</span>`
const bar = (c: Counts) => `<div class="bar">${STATUSES.filter((s) => c[s] > 0).map((s) => `<span class="s-${s}" style="flex:${c[s]}" title="${c[s]} ${s}"></span>`).join("")}</div>`
const counts = (c: Counts) => STATUSES.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`).join(" · ")

/** Gherkin, coloured: spans by token. */
const gherkin = (text: string) =>
  `<pre class="gherkin">${highlight("gherkin", text)
    .map((line) => line.map((sp) => (sp.token === undefined ? esc(sp.text) : `<span class="t-${sp.token}">${esc(sp.text)}</span>`)).join(""))
    .join("\n")}</pre>`
const scenarioText = (s: ScenarioPage) =>
  [
    `${s.id} ${s.title}`,
    ...(s.by.length > 0 ? [`  By    ${s.by.map((p) => p.name).join(", ")}  # ${s.by.map((p) => p.id).join(", ")}`] : []),
    ...(s.journeys.length > 0 ? [`  In    ${s.journeys.map((j) => j.name).join(", ")}  # ${s.journeys.map((j) => j.id).join(", ")}`] : []),
    ...s.lines.map((l) => `  ${l.keyword.padEnd(5)} ${l.text}${l.ref === undefined ? "" : `  # ${l.ref}`}`),
  ].join("\n")

const layout = (c: Catalog, up: string, title: string, body: string, scripts = "", head = "") =>
  [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(title)} · ${esc(c.project || "zarg")} catalog</title>`,
    `<link rel="stylesheet" href="${up}catalog.css">`,
    ...(head === "" ? [] : [head]),
    `</head>`,
    `<body>`,
    `<header><a href="${up}index.html"><strong>${esc(c.project || "zarg")} catalog</strong></a>${c.intents.map((i) => `<a href="${up}intents/${i.id}.html">${esc(i.title)}</a>`).join("")}<a href="${up}search.html">Search</a></header>`,
    `<main>`,
    body,
    `</main>`,
    scripts,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n")

const link = (up: string, id: string) => {
  const dir = id.startsWith("S-") ? "scenarios" : id.startsWith("J-") ? "journeys" : id.startsWith("I-") ? "intents" : undefined
  return dir === undefined ? `<span class="id">${esc(id)}</span>` : `<a href="${up}${dir}/${esc(id)}.html">${esc(id)}</a>`
}

const overview = (c: Catalog) => {
  const o = c.overview
  return layout(
    c,
    "",
    "Overview",
    [
      `<h1>Is everything working?</h1>`,
      ...(c.intents.length === 0 ? [`<p class="absent">No intents yet: talk to zarg about what this project is for.</p>`] : []),
      `<p>${counts(o.totals) || "no scenarios yet"}</p>`,
      `<h2>Checks</h2>`,
      `<div class="wide"><table>${o.checks.map((k) => `<tr><td>${esc(k.name)}</td><td class="${k.count > 0 ? k.level : ""}">${k.count}</td><td class="id">${k.level}</td></tr>`).join("")}</table></div>`,
      `<h2>Journeys</h2>`,
      `<div class="wide"><table>${o.journeys.map((j) => `<tr><td>${link("", j.id)}</td><td>${esc(j.name)}</td><td>${bar(j.counts)}</td><td class="id">${counts(j.counts)}</td></tr>`).join("")}</table></div>`,
      `<h2>Evidence</h2>`,
      `<p>runs: ${o.runs.map((r) => `<span class="id">${esc(r)}</span>`).join(", ") || "none"}<br>commits: ${o.commits.map((r) => `<span class="id">${esc(r)}</span>`).join(", ") || "none"}</p>`,
    ].join("\n"),
  )
}

const intentPage = (c: Catalog, i: Catalog["intents"][number]) =>
  layout(
    c,
    "../",
    i.title,
    [
      `<h1>${esc(i.title)} <span class="id">${esc(i.id)} · ${esc(i.status)}</span></h1>`,
      ...(i.problem === "" ? [] : [`<p>${esc(i.problem)}</p>`]),
      `<h2>Outcomes</h2>`,
      `<ul>${i.outcomes.map((o) => `<li id="${esc(o.id)}">${esc(o.text)} <span class="id">${esc(o.id)}</span> ← ${o.journeys.length > 0 ? o.journeys.map((j) => link("../", j)).join(", ") : "◇ no journey"}</li>`).join("")}</ul>`,
      ...(i.constraints.length === 0 ? [] : [`<h2>Constraints</h2>`, `<ul>${i.constraints.map((k) => `<li id="${esc(k.id)}">${esc(k.text)} <span class="id">${esc(k.id)}</span>${k.bounds.length > 0 ? ` → ${k.bounds.map((b) => link("../", b)).join(", ")}` : ""}</li>`).join("")}</ul>`]),
      ...(i.questions.length === 0 ? [] : [`<h2>Questions</h2>`, `<ul>${i.questions.map((q) => `<li id="${esc(q.id)}">${esc(q.text)} <span class="id">${esc(q.id)}</span> ${q.answer === undefined ? "(open)" : `— ${esc(q.answer)}`}</li>`).join("")}</ul>`]),
    ].join("\n"),
  )

const journeyPage = (c: Catalog, j: Catalog["journeys"][number], byId: ReadonlyMap<string, ScenarioPage>) => {
  const order = new Map(j.steps.map((s, i) => [s.id, i]))
  const block = (id: string) => {
    const s = byId.get(id)!
    return `<section class="step" id="${esc(id)}">${badge(s.status)} ${link("../", id)}\n${gherkin(scenarioText(s))}`
  }
  return layout(
    c,
    "../",
    j.name,
    [
      `<h1>${esc(j.name)} <span class="id">${esc(j.id)}</span></h1>`,
      `<p>${bar(j.counts)}</p><p class="id">${counts(j.counts)}</p>`,
      ...(j.outcomes.length === 0 ? [] : [`<p>Serves: ${j.outcomes.map((o) => `${esc(o.text)} <span class="id">${esc(o.id)}</span>`).join("; ")}</p>`]),
      ...j.steps.map((st, i) => {
        const at = (n: string) => `${link("../", n)}${(order.get(n) ?? i) < i ? " (above)" : ""}`
        const flow = [
          ...(st.next.length === 1 ? [`→ ${at(st.next[0]!)}`] : []),
          ...(st.next.length > 1 ? [`→ ${st.next.map(at).join(" or ")} (branches)`] : []),
          ...st.back.map((b) => `↺ back to ${link("../", b)}`),
        ]
        return `${block(st.id)}${flow.length > 0 ? `<p class="flow">${flow.join("<br>")}</p>` : ""}</section>`
      }),
      ...(j.apart.length === 0 ? [] : [`<h2>Not connected to the journey's other scenarios</h2>`, ...j.apart.map((id) => `${block(id)}</section>`)]),
    ].join("\n"),
  )
}

/** What an evidence plugin rendered for a medium (sanitized), with the assets it needs; or why it could not be. */
export type Fragment = { readonly html: string; readonly assets: ReadonlyArray<{ readonly owner: string; readonly name: string; readonly path: string }> } | { readonly fallback: string }
/** Media path → its fragment, rendered and sanitized before pages() runs. */
export type Rendered = ReadonlyMap<string, Fragment>
type Medium = NonNullable<ScenarioPage["proof"]>["media"][number]

const medium = (m: Medium, rendered: Rendered) => {
  const cap = `<figcaption>${esc(m.caption)} <span class="id">${esc(m.label)}</span></figcaption>`
  if (!m.present) return `<figure class="medium"><p class="absent">${esc("captured on the run's machine, not committed")}: ${esc(m.path)}</p>${cap}</figure>`
  const f = rendered.get(m.path)
  if (f !== undefined && "html" in f) return `<figure class="medium">${f.html}${cap}</figure>`
  // A kind nobody here renders: say why, and link its files.
  const links = m.files.map((x) => `<li><a href="../${esc(encodePath(x.url))}">${esc(x.name)}</a></li>`).join("")
  return `<figure class="medium fallback"><p>${esc(m.label)}: ${esc(m.caption)}</p><p class="absent">${esc(f?.fallback ?? `nothing renders ${m.kind}`)}</p><ul>${links}</ul></figure>`
}

/** The assets a page's rendered media need, once each, in a stable order. */
const assetsOf = (media: ReadonlyArray<Medium>, rendered: Rendered) => {
  const all = media.flatMap((m) => {
    const f = rendered.get(m.path)
    return m.present && f !== undefined && "html" in f ? f.assets.map((a) => `${a.owner}/${a.name}`) : []
  })
  // In the order the media and their plugins give them (a player before the script that starts it).
  return [...new Set(all)]
}
const assetTags = (up: string, assets: ReadonlyArray<string>) => ({
  head: assets.filter((a) => a.endsWith(".css")).map((a) => `<link rel="stylesheet" href="${up}plugins/${esc(a)}">`).join("\n"),
  body: assets.filter((a) => a.endsWith(".js")).map((a) => `<script src="${up}plugins/${esc(a)}"></script>`).join("\n"),
})

const scenarioPage = (c: Catalog, s: ScenarioPage, rendered: Rendered) => {
  const p = s.proof
  const assets = assetTags("../", assetsOf(p?.media ?? [], rendered))
  return layout(
    c,
    "../",
    `${s.id} ${s.title}`,
    [
      `<h1>${esc(s.title)} <span class="id">${esc(s.id)}</span> ${badge(s.status)}</h1>`,
      gherkin(scenarioText(s)),
      `<p class="id">version ${esc(s.version)}${s.journeys.length > 0 ? ` · in ${s.journeys.map((j) => link("../", j.id)).join(", ")}` : ""}</p>`,
      `<h2>Code</h2>`,
      s.code.length === 0 ? `<p class="absent">no code tagged with ${esc(s.id)}</p>` : `<ul>${s.code.map((k) => `<li>${k.url === undefined ? esc(`${k.file}:${k.line}`) : `<a href="${esc(k.url)}">${esc(`${k.file}:${k.line}`)}</a>`}</li>`).join("")}</ul>`,
      `<h2>Proof</h2>`,
      p === undefined
        ? `<p class="absent">${s.status === "planned" ? "planned: no code yet" : "no evidence yet"}</p>`
        : [
            `<p>${badge(s.status)} run <span class="id">${esc(p.run)}</span> · commit <span class="id">${esc(p.commit)}</span> · ${esc(p.at)} · ${p.ms} ms${p.flaky ? " · flaky (passed on its retry)" : ""}</p>`,
            ...(p.failure === null ? [] : [`<h3>Expected</h3><pre>${esc(p.failure.expected)}</pre><h3>Saw</h3><pre class="frame">${esc(p.failure.saw)}</pre>`]),
            `<h2>Evidence</h2>`,
            ...p.media.map((m) => medium(m, rendered)),
          ].join("\n"),
    ].join("\n"),
    assets.body,
    assets.head,
  )
}

const SEARCH_SCRIPT = `<script>
{
  const all = JSON.parse(document.getElementById("search-data").textContent)
  const q = document.getElementById("q"), out = document.getElementById("hits")
  const show = () => {
    const t = q.value.trim().toLowerCase()
    out.replaceChildren(...all.filter((e) => t === "" || (e.id + " " + e.text).toLowerCase().includes(t)).slice(0, 200).map((e) => {
      const li = document.createElement("li"), a = document.createElement("a")
      a.href = e.url
      a.textContent = e.id + " " + e.text
      li.append(a, " ", Object.assign(document.createElement("span"), { className: "id", textContent: e.kind }))
      return li
    }))
  }
  q.addEventListener("input", show)
  show()
}
</script>`

/** Every page as path → content. */
export const pages = (c: Catalog, rendered: Rendered): ReadonlyMap<string, string> => {
  const byId = new Map(c.scenarios.map((s) => [s.id, s]))
  return new Map([
    ["index.html", overview(c)],
    ["search.html", layout(c, "", "Search", `<h1>Search</h1>\n<input id="q" type="search" placeholder="an id or words" autofocus>\n<ul id="hits"></ul>\n<script type="application/json" id="search-data">${scriptData(c.search)}</script>`, SEARCH_SCRIPT)],
    ["search.json", `${JSON.stringify(c.search)}\n`],
    ...c.intents.map((i) => [`intents/${i.id}.html`, intentPage(c, i)] as const),
    ...c.journeys.map((j) => [`journeys/${j.id}.html`, journeyPage(c, j, byId)] as const),
    ...c.scenarios.map((s) => [`scenarios/${s.id}.html`, scenarioPage(c, s, rendered)] as const),
  ])
}
