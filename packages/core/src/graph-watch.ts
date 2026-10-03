import { mkdirSync, watch } from "node:fs"

/** Calls onChange once per burst of writes under the graph directory, after it has been quiet for quietMs. The directory is made when missing (a fresh project's first write must wake too). */
export const watchGraph = (dir: string, onChange: () => void, quietMs = 1000) => {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return { close: () => {} }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const w = watch(dir, { recursive: true }, () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(onChange, quietMs)
  })
  return {
    close: () => {
      if (timer !== undefined) clearTimeout(timer)
      w.close()
    },
  }
}
