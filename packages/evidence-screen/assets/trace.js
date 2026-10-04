// A trace's film strip: a thumbnail scrolls to its step.
document.querySelectorAll(".evidence-trace").forEach((trace) => {
  trace.querySelectorAll(".evidence-strip .thumb").forEach((thumb) => {
    thumb.addEventListener("click", () => {
      trace.querySelector(`.evidence-step[data-step="${thumb.dataset.step}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  })
})
