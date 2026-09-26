import { Stream } from "effect"
import type { WireEvent } from "./events"

/** Split an SSE body into its `data:` payloads, parsed as JSON. Comments and other fields are ignored. */
export const parseSse = (body: ReadableStream<Uint8Array>): Stream.Stream<WireEvent, Error> =>
  Stream.fromReadableStream({ evaluate: () => body, onError: (e) => (e instanceof Error ? e : new Error(String(e))) }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.mapAccum(
      () => [] as ReadonlyArray<string>,
      (data, line): readonly [ReadonlyArray<string>, ReadonlyArray<WireEvent>] => {
        if (line === "") return data.length === 0 ? [[], []] : [[], [JSON.parse(data.join("\n")) as WireEvent]]
        if (line.startsWith("data:")) return [[...data, line.slice(line.startsWith("data: ") ? 6 : 5)], []]
        return [data, []]
      },
    ),
  )
