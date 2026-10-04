// Each terminal recording plays in the asciinema player; its cast is in the page, so it plays opened from disk too.
document.querySelectorAll(".evidence-cast").forEach((el) => {
  // A step's cast is the session so far: it starts at the step, its screen already whole.
  const startAt = Number(el.dataset.startAt || 0)
  AsciinemaPlayer.create({ data: el.dataset.castData }, el, { fit: "width", terminalFontFamily: "ui-monospace, Menlo, monospace", ...(startAt > 0 ? { startAt, preload: true } : {}) })
})
