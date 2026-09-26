/** Project root: `ZARG_ROOT` when set, else the working directory. The graph lives in `<root>/.zarg/graph`. */
export const root = process.env.ZARG_ROOT ?? process.cwd()
export const graphDir = `${root}/.zarg/graph`
