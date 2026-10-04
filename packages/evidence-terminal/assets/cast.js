// Each terminal recording plays in the asciinema player; its cast is in the page, so it plays opened from disk too.
document.querySelectorAll(".evidence-cast").forEach((el) => {
  AsciinemaPlayer.create({ data: el.dataset.castData }, el, { fit: "width", terminalFontFamily: "ui-monospace, Menlo, monospace" })
})
