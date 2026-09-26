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

- `packages/cli` (`@zarg/cli`): primary package. Harness CLI for a coding agent. TUI built on OpenTUI (`@opentui/core`). Entry: `src/index.ts`. Tasks: `dev`, `start`, `typecheck`.

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

- Run tools through mise (`mise exec -- bun ...`) or in a shell with mise activated. Never rely on a globally installed tool version.
- Add or change a tool version only in `mise.toml`. Never document a version anywhere else.
- Use `bun`, never `npm`, `npx`, `yarn`, `pnpm`, or `node`. Use `bunx` in place of `npx`.
- Use `bun add` / `bun remove` to change dependencies. Commit `bun.lock`.
- Use `bun test` for tests and `bun run <script>` for package scripts.
- Define repeatable project commands as `[tasks]` in `mise.toml`, so humans and agents run the same thing (`mise run <task>`).
