import { Data, Effect, Stream } from "effect"
import type { Answer, WireEvent } from "./events"
import type { CoreInfo } from "./info"
import { parseSse } from "./sse"

export class CoreError extends Data.TaggedError("CoreError")<{ readonly status: number; readonly message: string }> {}

export interface ThreadInfo {
  readonly id: string
  readonly focus: ReadonlyArray<string>
  readonly status: "idle" | "running" | "waiting"
}

/** A slash command a plugin adds, as the core lists it. */
export interface PluginCommandInfo {
  readonly plugin: string
  readonly cmd: string
  readonly desc: string
  readonly method: string
  readonly arg: { readonly kind: "none" | "choice" | "text" | "path"; readonly hint?: string; readonly choices?: ReadonlyArray<string>; readonly required?: boolean; readonly params?: { readonly keys: ReadonlyArray<string>; readonly flags?: ReadonlyArray<string> } }
}

/** What one run sends: a new message (possibly an interjection), an answer to an inquiry, or neither (start the loop). */
export interface RunRequest {
  readonly threadId: string
  readonly focus?: ReadonlyArray<string>
  readonly message?: string
  readonly answer?: { readonly interruptId: string; readonly answer: Answer }
}

/** The AG-UI RunAgentInput for a run. Each message gets a fresh id, so core counts it as new. */
export const runInput = (r: RunRequest) => ({
  threadId: r.threadId,
  runId: crypto.randomUUID(),
  state: {},
  messages: r.message !== undefined ? [{ id: crypto.randomUUID(), role: "user", content: r.message }] : [],
  tools: [],
  context: [],
  forwardedProps: { focus: r.focus ?? [] },
  ...(r.answer !== undefined ? { resume: [{ interruptId: r.answer.interruptId, status: "resolved", payload: r.answer.answer }] } : {}),
})

/** A client for one core, over its unix socket with its token. */
export const makeClient = (info: Pick<CoreInfo, "socket" | "token">) => {
  const request = (path: string, init: RequestInit = {}) =>
    Effect.tryPromise({
      try: () =>
        fetch(`http://core${path}`, {
          ...init,
          unix: info.socket,
          headers: { authorization: `Bearer ${info.token}`, "content-type": "application/json", ...init.headers },
        } as RequestInit),
      catch: (e) => new CoreError({ status: 0, message: `core is not reachable: ${e instanceof Error ? e.message : String(e)}` }),
    }).pipe(
      Effect.flatMap((res) =>
        res.ok
          ? Effect.succeed(res)
          : Effect.promise(() => res.text()).pipe(Effect.flatMap((text) => Effect.fail(new CoreError({ status: res.status, message: text })))),
      ),
    )

  const events = (path: string, init?: RequestInit): Stream.Stream<WireEvent, CoreError> =>
    Stream.unwrap(Effect.map(request(path, init), (res) => parseSse(res.body!))).pipe(
      Stream.mapError((e) => (e instanceof CoreError ? e : new CoreError({ status: 0, message: `core stopped: ${e.message}` }))),
    )

  return {
    /** Post a run; its events until the run finishes or fails. */
    run: (r: RunRequest) => events("/runs", { method: "POST", body: JSON.stringify(runInput(r)) }),
    /** Every thread's events after `since`, then live ones. */
    stream: (since: number) => events(`/stream?since=${since}`),
    threads: () => request("/threads").pipe(Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<ReadonlyArray<ThreadInfo>>))),
    /** Turn plan and implement on for this session; says whether it worked and how many cards are pending. */
    reconcile: () =>
      request("/reconcile", { method: "POST", body: "{}" }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ readonly on: boolean; readonly reason?: string; readonly pending?: number }>)),
      ),
    /** YOLO on or off, for every plugin or one; answers whether any plugin is in YOLO now. */
    yolo: (on: boolean, plugin?: string) =>
      request("/yolo", { method: "POST", body: JSON.stringify({ on, ...(plugin !== undefined ? { plugin } : {}) }) }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ readonly on: boolean }>)),
      ),
    /** Slash commands the core's plugins add. */
    commands: () => request("/commands").pipe(Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<ReadonlyArray<PluginCommandInfo>>))),
    /** Run a plugin's slash command; answers a notice. */
    runCommand: (plugin: string, cmd: string, args: ReadonlyArray<string>) =>
      request(`/plugins/${encodeURIComponent(plugin)}/commands/${encodeURIComponent(cmd.replace(/^\//, ""))}`, { method: "POST", body: JSON.stringify({ args }) }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ readonly notice: string }>)),
      ),
    /** An action on an agent's selected rows; answers a notice for the developer. */
    act: (threadId: string, agent: string, action: string, section: string | undefined, rows: ReadonlyArray<string>) =>
      request(`/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agent)}/actions/${encodeURIComponent(action)}`, { method: "POST", body: JSON.stringify({ ...(section !== undefined ? { section } : {}), rows }) }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ readonly notice: string }>)),
      ),
    /** The developer's answer to a question in a plugin agent's conversation. */
    answerAgent: (threadId: string, agent: string, question: string, answer: { readonly choice?: string; readonly other?: string }) =>
      request(`/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agent)}/answers`, { method: "POST", body: JSON.stringify({ question, answer }) }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ notice: string }>)),
      ),
    stop: (threadId: string) => request(`/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST", body: "{}" }).pipe(Effect.asVoid),
  }
}

export type Client = ReturnType<typeof makeClient>
