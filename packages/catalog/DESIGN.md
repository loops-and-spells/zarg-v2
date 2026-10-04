# Catalog design

The catalog is a **proof ledger** for one product. People open it to learn whether the product works: the operator after a run, a teammate or reviewer deciding whether to trust a change, or anyone reading the published site. Its first job is to show **what is broken, and why**. Its second job is to explain what the product is for: intent, outcomes, journeys and scenarios.

## The one memorable thing: the tick strip

Each scenario is one small square cell, coloured by its status, with red first: failing, stale, unproven, proven, then planned. On the home page the strip of every scenario is the hero, so the state of the whole product is visible before a word is read. The same strip appears in each intent row and each journey header, scoped to their scenarios. The design spends its boldness here and nowhere else. A smooth progress bar, the generic default, would hide the count and the order, so the catalog never uses one.

## Colour

All colour comes from `@zarg/tokens` (web light and web dark), so the site and zarg's terminal UI agree:

| Token | Use |
|---|---|
| `ground`, `raised`, `shade`, `line` | page, header, panels and frames, rules |
| `text`, `dim`, `faint` | body, secondary, quiet |
| `accent` | links, focus |
| `error`, `attention`, `ok`, `dim`, `faint` | failing, stale, proven, unproven, planned: the status colours, and the only other colours used |

Colour always comes with a word: every status is also written out (`failing`, `stale`, …), so meaning never depends on colour alone.

## Type

- **Atkinson Hyperlegible Next** (variable, self-hosted): all prose and interface text. It was designed for legibility, which suits a page any human in the loop should be able to read.
- **JetBrains Mono** (variable, self-hosted): Gherkin, ids, versions, runs and commits, which are the things you copy or compare.
- **Scale:** 15px base, with a 1.25 ratio for headings. Body lines stay under 72ch. Headings use `text-wrap: balance`. Text is sentence case everywhere, with no all-caps labels.

## Layout

- Left-aligned on one column with a 1180px maximum width and a 16px gutter on phones. Only frames, Gherkin and the timeline rail are wider than text.
- **Header:** the project's name, Intents, a search box (it opens Search with the query), and a theme toggle (system, light, dark, stored per viewer).
- **Home:**
  - the verdict as a plain sentence;
  - the tick strip of every scenario;
  - the checks, as one line of counts (problems red when non-zero, the rest quiet);
  - the intent ledger, red first, with a filter: each row has its strip, title, and status, outcomes and journeys;
  - "Not tied to an outcome yet" and "In no journey" sections;
  - run and commit provenance last.
- **Intent:** the problem, then each outcome with the journeys serving it (name and strip) or "◇ no journey", then constraints and questions.
- **Journey:** the strip and the outcomes it serves, then a vertical timeline. A rail on the left carries a status dot per scenario. Each card holds the persona, the title, the status, and a thumbnail of the scenario's visual evidence (the screen after), with the Gherkin folded underneath. Branches and "↺ back to" are links.
- **Scenario:**
  1. On failure, first: what was expected beside what it saw (the last frame or screenshot).
  2. The Gherkin.
  3. The evidence: visual media large, text media after.
  4. The code.
  5. The proof's provenance.

## Motion

None by default. Only user-triggered changes animate (a disclosure opening), and `prefers-reduced-motion` turns even those off.

## Guarantees

Every page:
- is deterministic;
- uses relative links (it works under any sub-path and opened from disk);
- loads nothing from a CDN;
- works in light and dark;
- has visible keyboard focus;
- never scrolls sideways at 400px.

Evidence plugins render their own media inside this frame, sanitized. The design styles the frame around them, never their insides.
