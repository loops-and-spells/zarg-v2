import { highlight } from "@zarg/highlight"
import { BASE, type BaseKey, makeTheme, PALETTES } from "@zarg/tokens"
import { type Catalog, type Counts, type ScenarioPage, type Status, STATUSES, VISUAL } from "./model"

/** A site path as a URL: each segment percent-encoded (a space, #, ?, %). */
export const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/")

/** Text as HTML text: never markup. */
export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")

const STATUS_KEY: Readonly<Record<Status, BaseKey>> = { proven: "ok", failing: "error", stale: "attention", unproven: "dim", planned: "faint" }
const TOKEN_KEY: Readonly<Record<string, BaseKey>> = { keyword: "accent", comment: "dim", string: "ok", number: "attention", persona: "accent", journey: "ok", id: "dim", flow: "accent" }
/** The self-hosted faces (copied into fonts/ by the build): prose, and the things one copies or compares. */
export const FONTS = [
  { family: "Atkinson Hyperlegible Next", file: "atkinson-hyperlegible-next-latin-wght-normal.woff2", pkg: "@fontsource-variable/atkinson-hyperlegible-next" },
  { family: "JetBrains Mono", file: "jetbrains-mono-latin-wght-normal.woff2", pkg: "@fontsource-variable/jetbrains-mono" },
] as const
const SANS = `"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif`
const MONO = `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace`

const vars = (platform: "web.light" | "web.dark") => {
  const theme = makeTheme(PALETTES[platform], platform)
  return (Object.keys(BASE) as Array<BaseKey>).map((k) => `--${k}:${theme.value(k).fg};`).join("")
}
/** The design (DESIGN.md) as CSS: the tokens light by default, dark by the system's choice or the viewer's. */
export const css = (): string =>
  [
    ...FONTS.map((f) => `@font-face{font-family:"${f.family}";src:url("fonts/${f.file}") format("woff2-variations");font-weight:200 800;font-style:normal;font-display:swap}`),
    `:root{${vars("web.light")}color-scheme:light}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars("web.dark")}color-scheme:dark}}`,
    `:root[data-theme="dark"]{${vars("web.dark")}color-scheme:dark}`,
    `*,*::before,*::after{box-sizing:border-box}`,
    `body{margin:0;background:var(--ground);color:var(--text);font:15px/1.55 ${SANS};-webkit-text-size-adjust:100%;overflow-wrap:anywhere}`,
    `a{color:var(--accent);text-underline-offset:2px}a:hover{text-decoration-thickness:2px}`,
    `:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}`,
    `h1,h2,h3{text-wrap:balance;line-height:1.2;margin:0}h1{font-size:1.95rem;font-weight:700;letter-spacing:-.01em}h2{font-size:1.25rem;font-weight:650;margin-top:2.2rem}h3{font-size:1rem;font-weight:650}`,
    `p{max-width:72ch}`,
    `code,pre,.id,.mono{font-family:${MONO};font-size:.86em}`,
    `.id{color:var(--dim)}`,
    // The frame: header, main, footer.
    `.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:10px 16px;background:var(--raised);border-bottom:1px solid var(--line)}`,
    `.top .name{font-weight:700;color:var(--text);text-decoration:none;margin-right:auto}`,
    `.top nav{display:flex;gap:16px}.top nav a{color:var(--text);text-decoration:none}.top nav a:hover{color:var(--accent)}`,
    `.top form{margin:0}.top input,.filter{font:inherit;color:var(--text);background:var(--ground);border:1px solid var(--line);border-radius:4px;padding:5px 9px;width:14rem;max-width:100%}`,
    `button.theme{font:inherit;font-size:.86em;color:var(--dim);background:none;border:1px solid var(--line);border-radius:4px;padding:4px 9px;cursor:pointer}`,
    `main{max-width:1180px;margin:0 auto;padding:28px 16px 64px}`,
    `.lede{color:var(--dim);margin:.5rem 0 0}`,
    // The tick strip: one cell per scenario, red first (DESIGN.md).
    `.ticks{display:flex;flex-wrap:wrap;gap:2px;line-height:0}`,
    `.tick{width:8px;height:14px;border-radius:1px;background:var(--line)}`,
    `.ticks.big{gap:3px;margin:20px 0 6px}.ticks.big .tick{width:13px;height:22px;border-radius:2px}`,
    ...STATUSES.map((s) => `.tick.s-${s}{background:var(--${STATUS_KEY[s]})}.badge.s-${s}{color:var(--${STATUS_KEY[s]});border-color:var(--${STATUS_KEY[s]})}.word.s-${s}{color:var(--${STATUS_KEY[s]})}`),
    `.tick.s-planned{background:none;box-shadow:inset 0 0 0 1px var(--faint)}`,
    `.badge{display:inline-block;border:1px solid;border-radius:999px;padding:0 8px;font-size:.78rem;font-weight:600;line-height:1.6;vertical-align:.15em;white-space:nowrap}`,
    // Home.
    `.verdict{font-size:2.3rem;font-weight:700;letter-spacing:-.015em;max-width:24ch}`,
    `.counts{display:flex;flex-wrap:wrap;gap:4px 16px;margin:6px 0 0;padding:0;list-style:none;color:var(--dim)}`,
    `.checks{display:flex;flex-wrap:wrap;gap:4px 18px;margin:22px 0 0;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);list-style:none;font-size:.92em}`,
    `.checks .quiet{color:var(--faint)}.checks .problem{color:var(--error);font-weight:650}.checks .warning{color:var(--attention)}`,
    `.filter{width:22rem;margin:14px 0 8px}`,
    `.ledger{list-style:none;margin:0;padding:0}`,
    `.ledger>li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 20px;padding:14px 0;border-bottom:1px solid var(--line)}`,
    `.ledger .what a{font-weight:650;font-size:1.05rem;text-decoration:none;color:var(--text)}.ledger .what a:hover{color:var(--accent)}`,
    `.ledger .meta{color:var(--dim);font-size:.9em;margin:2px 0 8px}`,
    `.ledger .red{text-align:right;font-size:.9em;white-space:nowrap}`,
    `.plain{list-style:none;padding:0;margin:8px 0 0}.plain li{padding:4px 0}`,
    `.prov{margin-top:3rem;color:var(--faint);font-size:.85em}`,
    // Intent.
    `.outcomes{list-style:none;padding:0;margin:10px 0 0}.outcomes>li{padding:14px 0;border-bottom:1px solid var(--line)}`,
    `.serving{list-style:none;padding:0;margin:8px 0 0 0}.serving li{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:3px 0}`,
    `.nojourney{color:var(--attention)}`,
    // Journey: the timeline.
    `.timeline{list-style:none;margin:20px 0 0;padding:0 0 0 22px;position:relative}`,
    `.timeline::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:var(--line)}`,
    `.step{position:relative;margin:0 0 22px}`,
    `.step::before{content:"";position:absolute;left:-22px;top:6px;width:12px;height:12px;border-radius:50%;background:var(--ground);box-shadow:inset 0 0 0 3px var(--line)}`,
    ...STATUSES.map((s) => `.step.s-${s}::before{box-shadow:inset 0 0 0 3px var(--${STATUS_KEY[s]})}`),
    `.card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 22px;padding:12px 14px;background:var(--raised);border:1px solid var(--line);border-radius:6px}`,
    `.card .title{font-weight:650;font-size:1.05rem;color:var(--text);text-decoration:none}.card .title:hover{color:var(--accent)}`,
    `.card .who{color:var(--dim);font-size:.9em}`,
    // The catalog's own class: evidence plugins have their own (a trace's film strip uses .thumb).
    `.card-thumb{width:260px;max-width:100%;max-height:180px;overflow:hidden;border-radius:4px;border:1px solid var(--line);align-self:start;line-height:0}.card-thumb svg,.card-thumb img{display:block;width:100%;height:auto;max-height:180px;object-fit:cover;object-position:top}`,
    `.flow{grid-column:1/-1;color:var(--dim);font-size:.9em;margin:0}`,
    `details{grid-column:1/-1}summary{cursor:pointer;color:var(--dim);font-size:.9em}`,
    // Scenario.
    `.failure{margin:22px 0 0;padding:16px;border:1px solid var(--error);border-left-width:4px;border-radius:6px}`,
    `.pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:16px;margin-top:10px}`,
    `pre{overflow-x:auto;background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:12px 14px;line-height:1.5;margin:12px 0}`,
    // Frames and screenshots side by side when there is room (before beside after); a recording spans the row.
    `.gallery{display:grid;gap:22px 18px;margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr))}.gallery>.medium:has(.evidence-cast),.gallery>.medium:has(details),.gallery>.medium:has(pre),.gallery>.fallback{grid-column:1/-1}`,
    `figure{margin:0;min-width:0}figure>:first-child{max-width:100%}figcaption{color:var(--dim);font-size:.85em;margin-top:6px}`,
    `.medium svg,.medium img,.medium video{max-width:100%;height:auto}`,
    `.absent{color:var(--dim);font-style:italic}`,
    `.fallback{padding:12px 14px;border:1px dashed var(--line);border-radius:6px}`,
    `dl.proof{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 18px;margin:10px 0 0}dl.proof dt{color:var(--dim)}dl.proof dd{margin:0;overflow-wrap:anywhere}`,
    `.code{list-style:none;padding:0;margin:8px 0 0}.code li{padding:2px 0;overflow-wrap:anywhere}`,
    // Search.
    `.hits{list-style:none;padding:0}.hits li{padding:6px 0;border-bottom:1px solid var(--line)}`,
    ...Object.entries(TOKEN_KEY).map(([t, k]) => `.t-${t}{color:var(--${k})}`),
    `.t-title{font-weight:700}`,
    `@media (max-width:640px){.verdict{font-size:1.7rem}.card{grid-template-columns:minmax(0,1fr)}.card-thumb{width:100%}.pair{grid-template-columns:minmax(0,1fr)}.ledger>li{grid-template-columns:minmax(0,1fr)}.ledger .red{text-align:left}.top input{width:100%}}`,
    `@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`,
  ].join("\n") + "\n"

/** Data for a script element: JSON that cannot close the element early. */
const scriptData = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c")

const badge = (s: Status) => `<span class="badge s-${s}">${s}</span>`
const words = (c: Counts) => STATUSES.filter((s) => c[s] > 0).map((s) => `${c[s]} ${s}`).join(", ")
/** The tick strip: one cell per scenario, red first. */
// @scenario S-0118
const ticks = (c: Counts, big = false) => {
  const cells = STATUSES.flatMap((s) => Array.from({ length: c[s] }, () => `<span class="tick s-${s}"></span>`)).join("")
  return cells === "" ? "" : `<div class="ticks${big ? " big" : ""}" role="img" aria-label="${esc(words(c))}">${cells}</div>`
}
const total = (c: Counts) => STATUSES.reduce((n, s) => n + c[s], 0)

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

/** The viewer's theme: before the first paint (no flash), then the toggle cycles system, light, dark. */
const THEME_HEAD = `<script>try{const t=localStorage.getItem("zarg-catalog-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}</script>`
const THEME_SCRIPT = `<script>
{
  const root = document.documentElement, b = document.getElementById("theme")
  const label = () => {
    b.textContent = { light: "Light", dark: "Dark" }[root.dataset.theme] || "System"
    b.setAttribute("aria-label", "Theme: " + b.textContent)
  }
  label()
  b.addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : root.dataset.theme === "dark" ? "system" : "light"
    if (next === "system") delete root.dataset.theme
    else root.dataset.theme = next
    try { localStorage.setItem("zarg-catalog-theme", next) } catch {}
    label()
  })
}
</script>`

const layout = (c: Catalog, up: string, title: string, body: string, scripts = "", head = "") =>
  [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${esc(title)} · ${esc(c.project || "zarg")} catalog</title>`,
    THEME_HEAD,
    `<link rel="stylesheet" href="${up}catalog.css">`,
    ...(head === "" ? [] : [head]),
    `</head>`,
    `<body>`,
    `<header class="top"><a class="name" href="${up}index.html">${esc(c.project || "zarg")} catalog</a><nav><a href="${up}index.html">Intents</a><a href="${up}search.html">Search</a></nav><form action="${up}search.html" method="get" role="search"><input name="q" type="search" placeholder="Search scenarios, journeys…" aria-label="Search"></form><button type="button" class="theme" id="theme" aria-label="Theme: System">System</button></header>`,
    `<main>`,
    body,
    `</main>`,
    THEME_SCRIPT,
    scripts,
    `</body>`,
    `</html>`,
    ``,
  ].join("\n")

const link = (up: string, id: string) => {
  const dir = id.startsWith("S-") ? "scenarios" : id.startsWith("J-") ? "journeys" : id.startsWith("I-") ? "intents" : undefined
  return dir === undefined ? `<span class="id">${esc(id)}</span>` : `<a href="${up}${dir}/${esc(id)}.html">${esc(id)}</a>`
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The home's verdict: the most urgent thing true about the product, in one sentence. */
const verdict = (c: Counts) => {
  const built = total(c) - c.planned
  if (built === 0) return c.planned > 0 ? `Nothing built yet: ${plural(c.planned, "scenario")} planned.` : "No scenarios yet."
  if (c.failing > 0) return `${plural(c.failing, "scenario")} failing.`
  if (c.stale > 0) return `Nothing failing; ${plural(c.stale, "scenario")} stale since ${c.stale === 1 ? "its" : "their"} code changed.`
  if (c.unproven > 0) return `Nothing failing. ${c.proven} of ${plural(built, "built scenario")} proven.`
  return `Every built scenario is proven: all ${built}.`
}

/** A filter only once the list is long enough to need one. */
const FILTER_FROM = 6
const FILTER_SCRIPT = `<script>
{
  const f = document.getElementById("filter"), rows = [...document.querySelectorAll(".ledger > li")]
  f.addEventListener("input", () => {
    const t = f.value.trim().toLowerCase()
    for (const r of rows) r.hidden = t !== "" && !r.dataset.text.includes(t)
  })
}
</script>`

const overview = (c: Catalog) => {
  const o = c.overview
  const rows = o.intents.map((i) => {
    const red = [...(i.counts.failing > 0 ? [`<span class="word s-failing">${i.counts.failing} failing</span>`] : []), ...(i.counts.stale > 0 ? [`<span class="word s-stale">${i.counts.stale} stale</span>`] : [])]
    return [
      `<li data-text="${esc(`${i.id} ${i.title}`.toLowerCase())}">`,
      `<div class="what"><a href="intents/${esc(i.id)}.html">${esc(i.title)}</a>`,
      `<p class="meta"><span class="id">${esc(i.id)}</span> · ${esc(i.status)} · ${plural(i.outcomes, "outcome")} · ${i.journeys === 0 ? `<span class="nojourney">◇ no journey</span>` : plural(i.journeys, "journey")}</p>`,
      ticks(i.counts) || `<p class="absent">no scenarios yet</p>`,
      `</div>`,
      `<div class="red">${red.join("<br>")}</div>`,
      `</li>`,
    ].join("")
  })
  const checks = o.checks.map((k) => `<li class="${k.count === 0 ? "quiet" : k.level}">${esc(k.name)} ${k.count}</li>`).join("")
  return layout(
    c,
    "",
    "Intents",
    [
      `<h1 class="verdict">${esc(verdict(o.totals))}</h1>`,
      ticks(o.totals, true),
      total(o.totals) === 0 ? "" : `<ul class="counts">${STATUSES.filter((s) => o.totals[s] > 0).map((s) => `<li><span class="word s-${s}">${o.totals[s]} ${s}</span></li>`).join("")}</ul>`,
      `<ul class="checks" aria-label="Checks">${checks}</ul>`,
      `<h2>Intents</h2>`,
      ...(o.intents.length === 0
        ? [`<p class="absent">No intents yet: talk to zarg about what this project is for.</p>`]
        : [...(o.intents.length >= FILTER_FROM ? [`<input id="filter" class="filter" type="search" placeholder="Filter intents" aria-label="Filter intents">`] : []), `<ol class="ledger">${rows.join("")}</ol>`]),
      ...(o.uncovered.journeys.length === 0 ? [] : [`<h2>Not tied to an outcome yet</h2>`, `<ul class="plain">${o.uncovered.journeys.map((j) => `<li>${link("", j.id)} ${esc(j.name)}</li>`).join("")}</ul>`]),
      ...(o.uncovered.scenarios.length === 0 ? [] : [`<h2>In no journey</h2>`, `<ul class="plain">${o.uncovered.scenarios.map((s) => `<li>${link("", s.id)} ${esc(s.title)}</li>`).join("")}</ul>`]),
      `<p class="prov">Evidence from ${o.runs.length === 0 ? "no runs yet" : `${plural(o.runs.length, "run")} (${o.runs.map((r) => `<span class="id">${esc(r)}</span>`).join(", ")})`}${o.commits.length === 0 ? "" : ` at ${o.commits.map((r) => `<span class="id">${esc(r)}</span>`).join(", ")}`}.</p>`,
    ].join("\n"),
    o.intents.length >= FILTER_FROM ? FILTER_SCRIPT : "",
  )
}

const intentPage = (c: Catalog, i: Catalog["intents"][number]) => {
  const journeys = new Map(c.journeys.map((j) => [j.id, j]))
  return layout(
    c,
    "../",
    i.title,
    [
      `<h1>${esc(i.title)}</h1>`,
      `<p class="lede"><span class="id">${esc(i.id)}</span> · ${esc(i.status)} · ${words(i.counts) || "no scenarios yet"}</p>`,
      ticks(i.counts, true),
      ...(i.problem === "" ? [] : [`<p>${esc(i.problem)}</p>`]),
      `<h2>Outcomes</h2>`,
      `<ul class="outcomes">${i.outcomes
        .map(
          (o) =>
            `<li id="${esc(o.id)}"><div>${esc(o.text)} <span class="id">${esc(o.id)}</span></div>${
              o.journeys.length === 0
                ? `<p class="nojourney">◇ no journey serves it yet</p>`
                : `<ul class="serving">${o.journeys.map((id) => { const j = journeys.get(id); return `<li>${link("../", id)} ${esc(j?.name ?? "")} ${j === undefined ? "" : ticks(j.counts)}</li>` }).join("")}</ul>`
            }</li>`,
        )
        .join("")}</ul>`,
      ...(i.constraints.length === 0 ? [] : [`<h2>Constraints</h2>`, `<ul class="plain">${i.constraints.map((k) => `<li id="${esc(k.id)}">${esc(k.text)} <span class="id">${esc(k.id)}</span>${k.bounds.length > 0 ? ` → ${k.bounds.map((b) => link("../", b)).join(", ")}` : ""}</li>`).join("")}</ul>`]),
      ...(i.questions.length === 0 ? [] : [`<h2>Questions</h2>`, `<ul class="plain">${i.questions.map((q) => `<li id="${esc(q.id)}">${esc(q.text)} <span class="id">${esc(q.id)}</span> ${q.answer === undefined ? `<span class="word s-stale">open</span>` : `— ${esc(q.answer)}`}</li>`).join("")}</ul>`]),
    ].join("\n"),
  )
}

/** What an evidence plugin rendered for a medium (sanitized), with the assets it needs; or why it could not be. */
export type Fragment = { readonly html: string; readonly assets: ReadonlyArray<{ readonly owner: string; readonly name: string; readonly path: string }> } | { readonly fallback: string }
/** Media path → its fragment, rendered and sanitized before pages() runs. */
export type Rendered = ReadonlyMap<string, Fragment>
type Medium = NonNullable<ScenarioPage["proof"]>["media"][number]

const fragment = (rendered: Rendered, path: string | undefined) => {
  const f = path === undefined ? undefined : rendered.get(path)
  return f !== undefined && "html" in f ? f : undefined
}

/** The assets a page's fragments need, once each, in the order the media and their plugins give them. */
const assetsOf = (paths: ReadonlyArray<string>, rendered: Rendered) => [...new Set(paths.flatMap((p) => fragment(rendered, p)?.assets.map((a) => `${a.owner}/${a.name}`) ?? []))]
const assetTags = (up: string, assets: ReadonlyArray<string>) => ({
  head: assets.filter((a) => a.endsWith(".css")).map((a) => `<link rel="stylesheet" href="${up}plugins/${esc(a)}">`).join("\n"),
  body: assets.filter((a) => a.endsWith(".js")).map((a) => `<script src="${up}plugins/${esc(a)}"></script>`).join("\n"),
})

const journeyPage = (c: Catalog, j: Catalog["journeys"][number], byId: ReadonlyMap<string, ScenarioPage>, rendered: Rendered) => {
  const order = new Map(j.steps.map((s, i) => [s.id, i]))
  const card = (id: string, flow: ReadonlyArray<string>) => {
    const s = byId.get(id)!
    const thumb = fragment(rendered, s.thumb)
    return [
      `<li class="step s-${s.status}" id="${esc(id)}"><div class="card">`,
      `<div><a class="title" href="../scenarios/${esc(id)}.html">${esc(s.title)}</a> ${badge(s.status)}`,
      `<div class="who">${s.by.length > 0 ? `${esc(s.by.map((p) => p.name).join(", "))} · ` : ""}${link("../", id)}</div></div>`,
      thumb === undefined ? "" : `<div class="card-thumb">${thumb.html}</div>`,
      flow.length > 0 ? `<p class="flow">${flow.join("<br>")}</p>` : "",
      `<details><summary>Gherkin</summary>${gherkin(scenarioText(s))}</details>`,
      `</div></li>`,
    ].join("")
  }
  const thumbs = [...j.steps.map((s) => s.id), ...j.apart].map((id) => byId.get(id)?.thumb).filter((p): p is string => p !== undefined)
  const assets = assetTags("../", assetsOf(thumbs, rendered))
  return layout(
    c,
    "../",
    j.name,
    [
      `<h1>${esc(j.name)}</h1>`,
      `<p class="lede"><span class="id">${esc(j.id)}</span> · ${words(j.counts) || "no scenarios yet"}</p>`,
      ticks(j.counts, true),
      ...(j.outcomes.length === 0 ? [`<p class="nojourney">◇ serves no outcome yet</p>`] : [`<p>Serves ${j.outcomes.map((o) => `${esc(o.text)} <span class="id">${esc(o.id)}</span>`).join("; ")}</p>`]),
      `<ol class="timeline">${j.steps
        .map((st, i) => {
          const at = (n: string) => `${link("../", n)}${(order.get(n) ?? i) < i ? " (above)" : ""}`
          return card(st.id, [
            ...(st.next.length === 1 ? [`→ ${at(st.next[0]!)}`] : []),
            ...(st.next.length > 1 ? [`→ ${st.next.map(at).join(" or ")} (branches)`] : []),
            ...st.back.map((b) => `↺ back to ${link("../", b)}`),
          ])
        })
        .join("")}</ol>`,
      ...(j.apart.length === 0 ? [] : [`<h2>Not connected to the journey's other scenarios</h2>`, `<ol class="timeline">${j.apart.map((id) => card(id, [])).join("")}</ol>`]),
    ].join("\n"),
    assets.body,
    assets.head,
  )
}

// @scenario S-0119 S-0120
const medium = (m: Medium, rendered: Rendered) => {
  const cap = `<figcaption>${esc(m.caption)} · ${esc(m.label)}</figcaption>`
  if (!m.present) return `<figure class="medium"><p class="absent">${esc("captured on the run's machine, not committed")}: ${esc(m.path)}</p>${cap}</figure>`
  const f = rendered.get(m.path)
  if (f !== undefined && "html" in f) return `<figure class="medium">${f.html}${cap}</figure>`
  // A kind nobody here renders: say why, and link its files.
  const links = m.files.map((x) => `<li><a href="../${esc(encodePath(x.url))}">${esc(x.name)}</a></li>`).join("")
  return `<figure class="medium fallback"><p>${esc(m.label)}: ${esc(m.caption)}</p><p class="absent">${esc(f?.fallback ?? `nothing renders ${m.kind}`)}</p><ul>${links}</ul></figure>`
}

const scenarioPage = (c: Catalog, s: ScenarioPage, rendered: Rendered) => {
  const p = s.proof
  const media = p?.media ?? []
  const visual = media.filter((m) => VISUAL.has(m.kind))
  const other = media.filter((m) => !VISUAL.has(m.kind))
  const assets = assetTags("../", assetsOf(media.filter((m) => m.present).map((m) => m.path), rendered))
  const saw = fragment(rendered, s.saw)
  return layout(
    c,
    "../",
    `${s.id} ${s.title}`,
    [
      `<h1>${esc(s.title)} ${badge(s.status)}</h1>`,
      `<p class="lede">${s.by.length > 0 ? `${esc(s.by.map((b) => b.name).join(", "))} · ` : ""}<span class="id">${esc(s.id)}</span>${s.journeys.length > 0 ? ` · in ${s.journeys.map((j) => `${link("../", j.id)} ${esc(j.name)}`).join(", ")}` : ""}</p>`,
      ...(p?.failure === null || p === undefined
        ? []
        : [
            // @scenario S-0116
            `<section class="failure"><h2>It failed here</h2><div class="pair">`,
            `<div><h3>Expected</h3><pre>${esc(p.failure.expected)}</pre></div>`,
            `<div><h3>Saw</h3>${saw === undefined ? `<pre>${esc(p.failure.saw)}</pre>` : `<figure class="medium">${saw.html}</figure>`}</div>`,
            `</div></section>`,
          ]),
      gherkin(scenarioText(s)),
      `<h2>Evidence</h2>`,
      p === undefined
        ? `<p class="absent">${s.status === "planned" ? "Planned: no code yet, so nothing to prove." : "No evidence yet: no e2e step proves this scenario."}</p>`
        : `<div class="gallery">${[...visual, ...other].map((m) => medium(m, rendered)).join("")}</div>`,
      `<h2>Code</h2>`,
      s.code.length === 0 ? `<p class="absent">No code is tagged with ${esc(s.id)}.</p>` : `<ul class="code">${s.code.map((k) => `<li>${k.url === undefined ? `<span class="mono">${esc(`${k.file}:${k.line}`)}</span>` : `<a href="${esc(k.url)}">${esc(`${k.file}:${k.line}`)}</a>`}</li>`).join("")}</ul>`,
      ...(p === undefined
        ? []
        : [
            `<h2>Proof</h2>`,
            `<dl class="proof"><dt>Status</dt><dd>${badge(s.status)}${p.flaky ? " flaky: passed on its retry" : ""}</dd><dt>Run</dt><dd class="mono">${esc(p.run)}</dd><dt>Commit</dt><dd class="mono">${esc(p.commit)}</dd><dt>At</dt><dd class="mono">${esc(p.at)}</dd><dt>Took</dt><dd>${p.ms} ms</dd><dt>Version</dt><dd class="mono">${esc(s.version)}</dd></dl>`,
          ]),
    ].join("\n"),
    assets.body,
    assets.head,
  )
}

const SEARCH_SCRIPT = `<script>
{
  const all = JSON.parse(document.getElementById("search-data").textContent)
  const q = document.getElementById("q"), out = document.getElementById("hits")
  try { q.value = new URLSearchParams(location.search).get("q") || "" } catch {}
  const show = () => {
    const t = q.value.trim().toLowerCase()
    out.replaceChildren(...all.filter((e) => t === "" || (e.id + " " + e.text).toLowerCase().includes(t)).slice(0, 200).map((e) => {
      const li = document.createElement("li"), a = document.createElement("a")
      a.href = e.url
      a.textContent = e.text
      li.append(a, " ", Object.assign(document.createElement("span"), { className: "id", textContent: e.id + " · " + e.kind }))
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
    ["search.html", layout(c, "", "Search", `<h1>Search</h1>\n<input id="q" class="filter" type="search" placeholder="An id or words" aria-label="Search" autofocus>\n<ul id="hits" class="hits"></ul>\n<script type="application/json" id="search-data">${scriptData(c.search)}</script>`, SEARCH_SCRIPT)],
    ["search.json", `${JSON.stringify(c.search)}\n`],
    ...c.intents.map((i) => [`intents/${i.id}.html`, intentPage(c, i)] as const),
    ...c.journeys.map((j) => [`journeys/${j.id}.html`, journeyPage(c, j, byId, rendered)] as const),
    ...c.scenarios.map((s) => [`scenarios/${s.id}.html`, scenarioPage(c, s, rendered)] as const),
  ])
}
