/** A hand-written bundle in the runner's contract: module.exports.default.serve(powers) → methods. */
export const bundle = (methods: string) => `module.exports.default = { serve: (powers) => (${methods}) }`
export const echo = bundle(`{ echo: async (p) => p, add: async ({ a, b }) => a + b, secret: async ({ key }) => powers.call("secrets.get", { name: key }) }`)
export const looping = bundle(`{ spin: async () => { for (;;) {} }, ok: async () => "ok" }`)
export const crashing = bundle(`{ boom: async () => { throw new Error("plugin failed on purpose") } }`)
