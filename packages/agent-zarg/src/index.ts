import { type AgentHost, defineTrustedAgent } from "@zarg/agent-host"
import { makeZarg } from "./zarg"

/** zarg, the conversational agent: trusted (it runs the RLM kernel), first-party. */
export default defineTrustedAgent({ name: "zarg", start: (host: AgentHost) => makeZarg(host) })
