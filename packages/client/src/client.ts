import { Data, Effect, Stream } from "effect"
import type { Answer, WireEvent } from "./events"
import type { Body } from "./state"
import type { CoreInfo } from "./info"
import { parseSse } from "./sse"

export class CoreError extends Data.TaggedError("CoreError")<{ readonly status: number; readonly message: string }> {}

export interface ThreadInfo {
  readonly id: string
  readonly focus: ReadonlyArray<string>
  readonly status: "idle" | "running" | "waiting"
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
    /** Start a rehearsal; answers with the run, or `{ refused }`. */
    rehearse: (strategy?: "edge-pair" | "teleport", focus?: ReadonlyArray<string>) =>
      request("/rehearse", { method: "POST", body: JSON.stringify({ ...(strategy ? { strategy } : {}), ...(focus && focus.length > 0 ? { focus } : {}) }) }).pipe(
        Effect.flatMap((res) =>
          Effect.promise(() => res.json() as Promise<{ readonly run?: string; readonly stories?: number; readonly steps?: number; readonly personas?: ReadonlyArray<string>; readonly refused?: string }>),
        ),
      ),
    /** YOLO on or off, for every plugin or one; answers whether any plugin is in YOLO now. */
    yolo: (on: boolean, plugin?: string) =>
      request("/yolo", { method: "POST", body: JSON.stringify({ on, ...(plugin !== undefined ? { plugin } : {}) }) }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ readonly on: boolean }>)),
      ),
    /** An agent's body: its history, or what its plugin draws. */
    body: (threadId: string, agent: string) =>
      request(`/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agent)}/body`).pipe(Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<Body>))),
    /** An action on an agent's selected rows; answers a notice for the developer. */
    act: (threadId: string, agent: string, action: string, rows: ReadonlyArray<string>) =>
      request(`/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agent)}/actions/${encodeURIComponent(action)}`, { method: "POST", body: JSON.stringify({ rows }) }).pipe(
        Effect.flatMap((res) => Effect.promise(() => res.json() as Promise<{ readonly notice: string }>)),
      ),
    stop: (threadId: string) => request(`/threads/${encodeURIComponent(threadId)}/stop`, { method: "POST", body: "{}" }).pipe(Effect.asVoid),
  }
}

export type Client = ReturnType<typeof makeClient>
