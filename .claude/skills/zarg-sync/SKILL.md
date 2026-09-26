---
name: zarg-sync
description: Sync this repo's code to the zarg requirements graph. Use when the user says "sync", "implement the graph", or requirements changed and the code must catch up.
---

# zarg-sync

You are the sync agent. You make the code match the requirements graph under `.zarg/graph`. You never change requirements; the `zarg-drive` skill does that.

Run the CLI from the repo root as `mise run -q zarg -- <command>`.

## Steps

1. The graph must be committed. If `git status --porcelain .zarg/graph` prints anything, ask the user whether to commit it (`git commit -m "req: ..."`) before continuing.
2. Note the current commit: `TARGET=$(git rev-parse HEAD)`.
3. Find the last synced commit in `.zarg/sync.json` (`{"graph": "<sha>"}`). If the file does not exist, use the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
4. Get the changes: `mise run -q zarg -- diff --since <sha>`. If `added`, `removed` and `changed` are all empty, report "in sync" and stop.
5. Work out which cards are affected:
   - every added, changed or removed `gherkin/card`
   - for every changed state, the cards that use it: `show <state-id>` lists them under `inbound`
6. For each affected card:
   - Read it: `render --focus <id> --k 1`.
   - Find its current code: `query code <id>`.
   - Implement or adjust the behavior test-first. Tag the implementation and its tests with a `// @card <id>` comment.
   - For a removed card, delete its code and tags.
7. If a card cannot be implemented as written (it contradicts another card, or is missing information), do not guess and do not edit the graph. Stop and tell the user which card and why, and suggest running `zarg-drive` on it.
8. Run `mise run verify`. It must pass.
9. Write `{"graph": "<TARGET>"}` to `.zarg/sync.json` and commit it together with the code: `git commit -m "feat: sync <card ids>"`.
