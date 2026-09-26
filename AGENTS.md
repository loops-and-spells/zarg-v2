# Agent Guide

Rules for any agent (Claude, Codex, etc.) working in this repo.

## Toolchain

- **mise** manages every tool version. `mise.toml` is the source of truth.
- **bun** is the JavaScript runtime, package manager, test runner, and script runner.

## Layout

Monorepo. Every module lives in its own package under `packages/<name>/`.

```
mise.toml        # tool versions + monorepo root (config_roots = packages/*)
package.json     # bun workspaces = packages/*
packages/<name>/
  mise.toml      # this package's tasks (build, test, dev, ...)
  package.json   # name: @zarg/<name>
```

- One package = one module. No cross-package imports through relative paths; depend on the package by name (`"@zarg/<name>": "workspace:*"`).
- Tool versions live only in the root `mise.toml`. Package `mise.toml` files define tasks only.
- One `bun.lock` at the root. Run `bun install` from the root.

## Packages

- `packages/graph` (`@zarg/graph`): JSON graph store under `.zarg/graph`: snapshot, queries, diff.
- `packages/plugin` (`@zarg/plugin/server`): plugin contract, `PluginHost` and the write pipeline.
- `packages/plugin-gherkin` (`@zarg/plugin-gherkin/server`): atomic Gherkin user action graph (states and cards).
- `packages/cli` (`@zarg/cli`): the `zarg` CLI. Run it with `mise run -q zarg -- <command>`.
- `packages/model` (`@zarg/model`): `Env` and `Secrets` (varlock), config loader, `Model` service, provider contract, OpenRouter-wire client.
- `packages/provider-zarg-router`, `packages/provider-openrouter`: provider plugins. Each ships its `.env.schema` fragment.
- `packages/decisions` (`@zarg/decisions`): `Decisions` service (JEV `/systemone`, structured fallback).

Design: `docs/superpowers/specs/2026-09-25-harness-architecture-design.md` and `docs/superpowers/specs/2026-09-25-agent-runtime-design.md`.

## Secrets

- The root `.env.schema` declares every variable zarg reads (it imports the provider packages and `~/.config/zarg/`). Values live in gitignored `.env.local` files. Store secrets with varlock's device-bound encryption: `echo "$KEY" | mise x -- bunx varlock encrypt`.
- Never print, log or commit a secret value. In tests, use variable names unique to the test so a developer's real environment cannot override them or leak into output.

## Requirements

This repo's requirements live in its own zarg graph under `.zarg/graph`.

- Use the `zarg-drive` skill (`.claude/skills/zarg-drive/SKILL.md`) to refine requirements. It edits only the graph.
- Use the `zarg-sync` skill (`.claude/skills/zarg-sync/SKILL.md`) to make code match the graph. It edits only code.
- Never edit `.zarg/graph` files by hand. Change them through `zarg tool call`.
- Tag code that implements a card with a `// @card <id>` comment (for example `// @card UX-0003`).

## Tasks

mise orchestrates tasks across packages:

```sh
mise tasks ls --all             # list every task in the monorepo
mise //packages/<name>:test     # one task in one package
mise //...:test                 # the same task in every package
```

A task depends on another package's task with `depends = ["//packages/<other>:build"]`.

## Setup

```sh
mise trust
mise install
```

## Rules

- Run tools through mise (`mise x -- bun ...`). A globally installed bun can shadow the pinned one even inside `mise run`, so every task calls `mise x -- bun`, and tests spawn `process.execPath`, never a bare `bun`.
- Add or change a tool version only in `mise.toml`. Never document a version anywhere else.
- Use `bun`, never `npm`, `npx`, `yarn`, `pnpm`, or `node`. Use `bunx` in place of `npx`.
- Use `bun add` / `bun remove` to change dependencies. Commit `bun.lock`.
- Use `bun test` for tests and `bun run <script>` for package scripts.
- `mise run verify` typechecks and tests every package. It must pass before any commit.
- Define repeatable project commands as `[tasks]` in `mise.toml`, so humans and agents run the same thing (`mise run <task>`).
