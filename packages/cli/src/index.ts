#!/usr/bin/env bun
import { TextRenderable, createCliRenderer } from "@opentui/core"

const renderer = await createCliRenderer({ exitOnCtrlC: true })

renderer.root.add(new TextRenderable(renderer, { content: "zarg" }))
