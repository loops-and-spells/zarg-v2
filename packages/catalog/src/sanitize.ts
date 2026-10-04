/** Elements removed with everything in them: they run code, reach out, or take input. */
const BLOCKED = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "link", "meta", "base", "style", "form", "input", "textarea", "button", "select", "option", "noscript", "template"])
/** Elements kept; any other is unwrapped (its text stays). */
const TAGS = new Set(
  "div span p pre code figure figcaption img video source picture details summary a ul ol li table thead tbody tr td th h3 h4 h5 strong em b i u s small br hr time kbd samp abbr mark sup sub svg g rect circle line polyline polygon path text tspan title desc defs clippath".split(" "),
)
const ATTRS = new Set(
  (
    "class title alt width height loading decoding controls loop muted playsinline preload poster type open colspan rowspan datetime role lang dir " +
    "viewbox xmlns x y x1 y1 x2 y2 cx cy r rx ry dx dy points d fill fill-opacity stroke stroke-width opacity font-family font-size font-weight font-style text-decoration text-anchor dominant-baseline xml:space transform preserveaspectratio"
  ).split(" "),
)
const URL_ATTRS = new Set(["href", "src", "poster", "xlink:href"])
const DATA_IMAGE = /^data:image\/(png|gif|jpeg|webp);base64,/

/** A URL in a page that reaches nothing outside the site: relative, a fragment, or an inline image. */
const safeUrl = (raw: string): boolean => {
  const v = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(colon|tab|newline);/gi, (_, n: string) => ({ colon: ":", tab: "\t", newline: "\n" })[n.toLowerCase()]!)
    .replace(/[\u0000- \u007f]/g, "")
    .toLowerCase()
  if (DATA_IMAGE.test(v)) return true
  if (v.startsWith("//")) return false
  // A scheme is anything before the first ":" that comes before any "/", "?" or "#".
  const colon = v.indexOf(":")
  return colon === -1 || /[/?#]/.test(v.slice(0, colon))
}

/** Plugin-rendered HTML with nothing that runs or reaches out: an allowlist of tags and attributes. */
export const sanitize = async (html: string): Promise<string> => {
  const rewriter = new HTMLRewriter().on("*", {
    element(e) {
      const tag = e.tagName.toLowerCase()
      if (BLOCKED.has(tag)) return void e.remove()
      if (!TAGS.has(tag)) return void e.removeAndKeepContent()
      const names = [...e.attributes].map(([n]) => n)
      for (const n of names) {
        const name = n.toLowerCase()
        const keep = name.startsWith("data-") || name.startsWith("aria-") ? true : URL_ATTRS.has(name) ? name !== "xlink:href" && safeUrl(e.getAttribute(n) ?? "") : ATTRS.has(name)
        if (!keep) e.removeAttribute(n)
      }
    },
  })
  return rewriter.transform(new Response(html)).text()
}
