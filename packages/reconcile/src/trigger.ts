/**
 * Runs `run` once things have been quiet for `quietMs` after the last `notify`. One run at a time: a notify
 * during a run schedules exactly one more run after it.
 */
export const makeTrigger = (quietMs: number, run: () => Promise<unknown>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let again = false
  let closed = false
  const fire = () => {
    timer = undefined
    if (closed) return
    if (running) {
      again = true
      return
    }
    running = true
    void run()
      .catch(() => {})
      .finally(() => {
        running = false
        if (again && !closed) {
          again = false
          notify()
        }
      })
  }
  const notify = () => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(fire, quietMs)
  }
  return {
    notify,
    close: () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
    },
    busy: () => running || timer !== undefined,
  }
}
