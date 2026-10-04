import { expect, test } from "bun:test"
import { noticeOf, priorityOf, sortTopics, type Topic } from "../src/inbox"

const t = (id: string, over: Partial<Topic> = {}): Topic => ({ id, kind: "question", from: { plugin: "p" }, title: id, why: "", about: [], blocking: false, messages: [], state: "open", created: 0, updated: 0, ...over })
// @scenario S-0092 S-0096
test("priority: blocking, then answers, then by severity, then reports; older first within a tier; snoozed last", () => {
  const list = [
    t("report", { kind: "report", created: 1 }),
    t("finding-low", { severity: "low", created: 1 }),
    t("finding-high", { severity: "high", created: 5 }),
    t("choice-new", { answers: [{ id: "a", label: "A" }], created: 9 }),
    t("choice-old", { answers: [{ id: "a", label: "A" }], created: 2 }),
    t("grant", { blocking: true, answers: [{ id: "a", label: "A" }], created: 50 }),
    t("snoozed", { answers: [{ id: "a", label: "A" }], snoozed: { until: "change" }, created: 0 }),
  ]
  expect(sortTopics(list, 100).map((x) => x.id)).toEqual(["grant", "choice-old", "choice-new", "finding-high", "finding-low", "report", "snoozed"])
  expect(priorityOf(list[5]!, 100)).toBeLessThan(priorityOf(list[4]!, 100))
})

test("a refusal's notice: the core's JSON notice, or the body itself when it is not JSON", () => {
  expect(noticeOf('{"notice":"that topic is answered"}')).toBe("that topic is answered")
  expect(noticeOf("Conflict")).toBe("Conflict")
})
