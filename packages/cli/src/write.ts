import { writeSync } from "node:fs"

/** Writes all of `text` to `fd`, waiting while a pipe is full (a non-blocking pipe answers EAGAIN until its reader catches up). */
export const writeAll = (fd: number, text: string): void => {
  let buf = Buffer.from(text)
  while (buf.length > 0) {
    try {
      const n = writeSync(fd, buf)
      buf = buf.subarray(n)
    } catch (e) {
      if ((e as { code?: string }).code !== "EAGAIN") throw e
      Bun.sleepSync(1)
    }
  }
}
