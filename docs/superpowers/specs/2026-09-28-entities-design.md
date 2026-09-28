# Entities

Date: 2026-09-28
Status: design approved in conversation, pending written review
Touches: new `@zarg/entities`; `@zarg/plugin-sdk` (`defineEntity`, the `Entities` power), `@zarg/plugin` (the host routes refs to providers), `@zarg/rlm` (the `Entities` service), `@zarg/kernel` (typed per-kind data in the manifest), `@zarg/view` and `@zarg/view-tui` (ref cells drawn as labels), `@zarg/plugin-gherkin` (its providers)

## Outcome

Any plugin's data can be named, fetched, shown and acted on by any other plugin or agent without either knowing the other. A plugin owns its kinds and serves them through a provider; everyone else speaks only to one service, `Entities`, through references. Agents fetch context for any entity the same way, views draw any reference as a coloured label that opens its owner's view, and every entity has a version, so anything that points at an entity can tell when it changed.

## References

- A ref is `<type>:<id>[@<version>]`. The type is `<plugin>/<kind>` (graph node types already are: `gherkin/card`). Examples: `gherkin/card:UX-0062`, `gherkin/card:UX-0062@3f9a1c20b7e4`, `backlog/item:B-12`.
- An id is unique within its type. The version, when present, is the one the holder saw; without it the ref means the entity as it is now.
- `@zarg/entities` (no dependencies, runs in the sandbox): `parseRef`, `formatRef`, the `Ref`, `Entity`, `Label` and query schemas.

## Providers

A plugin declares the kinds it serves and implements them with `defineEntity` (`@zarg/plugin-sdk`):

```ts
defineEntity("item", {
  data: BacklogItem,                     // a Schema: the entity's data, travels in the manifest
  get: (ids) => …,                       // ids → data (missing ids absent)
  query: ({ where, text, limit }) => …,  // ids matching; where: equality on data fields
  label: (item) => ({ text: item.title, tone: "accent", glyph: "▦" }),
  context: (item) => "…",               // agent-ready text (Markdown)
  version: (item) => …,                  // optional; default: a hash of the canonical data
  open: (id) => ({ view: "backlog", focus: id }),                 // optional: where the operator sees it
  commands: { move: { params: MoveParams, method: "moveItem" } }, // optional: named writes, routed to the owner's methods
})
```

- `label.tone` must be a plugin tone (`@zarg/tokens` `PLUGIN_TONES`), refused at build and load like view tones.
- Commands are the plugin's own methods: they keep their validation, write gate and grants. There is no generic create, update or delete.
- **Graph kinds get a provider for free.** For every graph node type the host serves `get` (props and edges), `query` (by props), `version` (the node hash), `label` (the node's title or id) and `context` (the owner's `render` hook for that node). A graph plugin overrides any of these per kind with `defineEntity`. Gherkin overrides `gherkin/card`: its version covers the card, its states' text and its personas' names, so rewording a state changes the versions of the cards that use it; its label is `UX-0062 Plugin asks for an optional scope` in the `card` tone.

## The service

One service, the same shape everywhere:

- `get(ref) → Entity` where `Entity = { ref (with the current version), type, id, version, label, data, context? }`.
- `many(refs) → Entity[]` (batched per provider).
- `query({ type, where?, text?, limit? }) → Entity[]`: one type per query; `text` ranks by BM25 over label and context (`@zarg/bm25`) when the provider does not rank itself.
- `version(ref) → string | null` and `changed(ref@version) → boolean`.
- `label(ref) → Label`, `context(ref) → string`.
- `command(ref, name, args)`: routed to the owner's method; fails with the owner's error.
- `types() → { type, doc, commands }[]`: what exists.

Failures: `NotFound`, `UnknownType`, `NotAllowed` (the caller's grant does not cover the type), `ProviderFailed` (the provider's error, with its message).

### Who gets it

- **Plugins**: the `Entities` power in `@zarg/plugin-sdk`, under a new scope `entities: { read: [patterns], command: [patterns] }` (type patterns like `gherkin/*`, `backlog/item`), granted like other scopes. A plugin always reaches its own kinds.
- **RLMs**: an `Entities` kernel service, named in a preset's `layer` (`"Entities"`, `"Entities:read"`). It honours the RLM's scope: graph-backed refs outside the scope's focus fail with `OutOfScope`, like `Graph.show`. The kernel manifest carries each kind's data schema and commands, so `get` on a `gherkin/card` ref is typed as card data and `command` checks its name and arguments per kind; a cell that misreads a field fails the typecheck before it runs.
- **The core and clients**: views may put refs in their data (a table cell, a list item, a text's `[[ref]]`); the core resolves their labels when it forwards view data (`refs: { [ref]: Label }`), so clients draw labels without calling providers. The TUI draws a ref as its glyph and text in its tone; ⏎ or a click on it opens its owner's `open` view (a nav item, focused on the id). Clients never import providers.

## Folding

A ref is a small, stable handle: an RLM folds entities to refs with the version it saw and re-reads `context` only when it needs the body. `changed(ref@version)` tells it a folded view is out of date.

## Errors

- A provider that throws or times out: `ProviderFailed` for its refs only; `many` and `query` return what the others served, with the failed refs listed.
- Two plugins declaring the same type: the second is refused at load (a type has one owner).
- A ref to a type whose plugin is not loaded: `UnknownType`, naming the plugin.
- A label with a tone plugins may not name: refused at build and load.

## Testing

- Refs: parse and format round-trip, with and without a version; bad refs are refused with the reason.
- Host: a ref reaches its owner's provider only; `many` batches per provider; one failing provider does not fail the others; a duplicate type is refused at load.
- Graph kinds: served without a provider; gherkin's card version changes when a state it uses is reworded and not when an unrelated node changes.
- Grants: a plugin reads only the types its scope names, and its own.
- RLM: a cell reads typed card data; a misspelt field fails the typecheck; an out-of-scope ref fails with `OutOfScope`; `command` routes to the owner's method through its gate.
- Views: a ref cell draws its label in its tone and opens its owner's view.

## Scope

In: refs, `defineEntity`, the host's routing and graph providers, gherkin's card, state, persona and journey providers, the `Entities` power and scope, the RLM service with typed kinds, ref labels in views.

Out: cross-type full-text search, entity subscriptions (watch a ref), generic CRUD.
