/**
 * Evidence any runner can capture: the evidence JSON, kinds (`<plugin>/<kind>`, rendered by the plugin that owns
 * them), captures and generic builders. No dependencies and no I/O here; the writer is `@zarg/evidence-capture/writer`.
 */

export type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [k: string]: Json }
export type Media = { readonly kind: string; readonly path: string; readonly caption: string; readonly mime?: string; readonly meta?: Json }
export type Evidence = {
  readonly scenario: string
  readonly version: string
  readonly commit: string
  readonly run: string
  readonly journey: string
  readonly passed: boolean
  readonly flaky: boolean
  readonly at: string
  readonly ms: number
  readonly media: ReadonlyArray<Media>
  readonly failure: { readonly expected: string; readonly saw: string } | null
  /** The scenario's tagged files at the run, by content (git blob hashes): staleness that survives squash, rebase and shallow clones. */
  readonly code?: Readonly<Record<string, string>>
}
export const EVIDENCE_DIR = ".zarg/evidence"

/** A kind's declaration: text media is committed, binary media stays on the run's machine unless media = "commit". */
export type KindDecl = { readonly label: string; readonly files: "text" | "binary" }
/** The kinds evidence had before they were plugins'. */
export const ALIASES: Readonly<Record<string, string>> = {
  buffer: "evidence-terminal/text",
  log: "evidence-terminal/text",
  cast: "evidence-terminal/cast",
  image: "evidence-screen/screenshot",
  gif: "evidence-screen/gif",
  video: "evidence-screen/video",
}
/** zarg's own kinds, known even where their plugins are not loaded (the audit, a bare clone). */
export const FIRST_PARTY_KINDS: Readonly<Record<string, KindDecl>> = {
  "evidence-terminal/frame": { label: "terminal frame", files: "text" },
  "evidence-terminal/cast": { label: "terminal recording", files: "text" },
  "evidence-terminal/text": { label: "terminal text", files: "text" },
  "evidence-terminal/gif": { label: "terminal gif", files: "binary" },
  "evidence-screen/screenshot": { label: "screenshot", files: "binary" },
  "evidence-screen/gif": { label: "animation", files: "binary" },
  "evidence-screen/video": { label: "video", files: "binary" },
  "evidence-screen/trace": { label: "trace", files: "binary" },
}
export const resolveKind = (kind: string): string => ALIASES[kind] ?? kind
export const isKindRef = (s: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)
/** Text or binary, from the declared kinds and zarg's own; a kind nobody declared is binary. */
export const isText =
  (declared: Readonly<Record<string, KindDecl>>) =>
  (kind: string): boolean => {
    const ref = resolveKind(kind)
    return (declared[ref] ?? FIRST_PARTY_KINDS[ref])?.files === "text"
  }

/** What a capture adapter hands the writer: its kind, a caption and its files (the first is the medium's own). */
export type Capture = { readonly kind: string; readonly caption: string; readonly files: Readonly<Record<string, string | Uint8Array>>; readonly meta?: Json }

export const text = (caption: string, body: string, opts: { readonly fold?: boolean } = {}): Capture => ({
  kind: "evidence-terminal/text",
  caption,
  files: { "text.txt": body },
  ...(opts.fold === undefined ? {} : { meta: { fold: opts.fold } }),
})
export const screenshot = (caption: string, png: Uint8Array): Capture => ({ kind: "evidence-screen/screenshot", caption, files: { "screenshot.png": png } })
export const gif = (caption: string, bytes: Uint8Array): Capture => ({ kind: "evidence-screen/gif", caption, files: { "anim.gif": bytes } })
const EXT: Readonly<Record<string, string>> = { "video/webm": "webm", "video/mp4": "mp4" }
export const video = (caption: string, bytes: Uint8Array, mime: string): Capture => ({ kind: "evidence-screen/video", caption, files: { [`video.${EXT[mime] ?? "bin"}`]: bytes }, meta: { mime } })

export type TraceAction = {
  readonly action: string
  readonly screenshot?: Uint8Array
  readonly console?: ReadonlyArray<{ readonly level: string; readonly text: string }>
  readonly requests?: ReadonlyArray<{ readonly method: string; readonly url: string; readonly status: number; readonly ms?: number }>
  readonly ms?: number
}
/** A run, action by action: what the screen showed, what the app logged, what it asked for. Any runner fills it from its own hooks. */
export const trace = (caption: string) => {
  const actions: Array<Json> = []
  const shots: Array<[string, Uint8Array]> = []
  return {
    action: (name: string, a: Omit<TraceAction, "action"> = {}) => {
      const shot = a.screenshot === undefined ? undefined : `${String(shots.length + 1).padStart(3, "0")}.png`
      if (shot !== undefined) shots.push([shot, a.screenshot!])
      actions.push({ action: name, ...(shot === undefined ? {} : { screenshot: shot }), console: (a.console ?? []) as Json, requests: (a.requests ?? []) as Json, ...(a.ms === undefined ? {} : { ms: a.ms }) })
    },
    done: (): Capture => ({ kind: "evidence-screen/trace", caption, files: { "trace.json": JSON.stringify(actions), ...Object.fromEntries(shots) } }),
  }
}
