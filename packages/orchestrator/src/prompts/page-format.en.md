# Page format contract (hard constraints, independent of narrative tone)

<!-- Source: lecture-to-notes' skills/lecture-to-md/lecture-to-md/assets/notes-prompt.md
     (Chinese source; this is the translation of prompts/page-format.zh.md with equal
     adaptation). The four carried-over sections
     (Markdown format rules / figure rules / image reference syntax / final checklist)
     keep the source's rule numbering and checklist order one-to-one.
     Only edit together with the zh version and prompts/page-agent.ts. -->

> This asset holds the page's **hard format contract**. It is orthogonal to the style
> discipline (`humanizer.*.md`, anti-AI prose) and the reader-first discipline
> (`reader-first.*.md`, teaching the reader): this file only states what the format must
> satisfy, not how to write well.

## YAML frontmatter

- The page's `--- ... ---` frontmatter is **injected automatically** by the `write_page`
  tool from its `slug` / `title` parameters. Do **not** hand-write frontmatter
  (it would be overwritten and drift from wiki.json).
- The body starts at the first `#` level-one heading.

## Heading levels

- Exactly **one** level-one heading (`#`), matching the page title; never repeat H1 and
  never skip levels (e.g. `##` directly followed by `####`).
- Level-two headings (`##`) divide the page into the topic blocks you diagnosed; every
  H2 must have **substantive prose** beneath it, not a list of headings.
- The source-navigation section title is fixed: shape A (overview) uses
  `## 🧭 源码导航 (Codebase Map)`; shapes B/C/D (local modules) use
  `## 🔗 关联模块与上下游`. Do not invent your own title.

## Mermaid diagrams

- You **must** use Mermaid (\`\`\`mermaid) for the architecture or module-dependency diagram.
- Mermaid flowchart node labels must use quoted labels: `A["Node text"]`. Whenever a label
  contains parentheses, HTML line breaks (`<br/>`), pipes, braces, paths, symbols, or mixed
  CJK/Latin text, never write the bare form `A[Node text]` — always `A["Node text"]`.
- Re-check the syntax before emitting a Mermaid diagram, especially to avoid unquoted labels
  such as `A[O(n) note]`; the correct form is `A["O(n) note"]`.
- **Anti-padding**: draw a diagram only when the page genuinely covers module topology. When
  it does not, the correct number of Mermaid diagrams is **0** (the `minimal` panorama
  overview is the only mandatory exception); **never add a diagram just to have a diagram**.

## Provenance format (`Sources:`)

This is the system's core interactive feature — **never omit it**:

- When you finish a subsection, or after detailed prose about an architectural design, a
  core class, or business logic, you **must** append the concrete file paths that back the
  claim at the end of the paragraph.
- Format (strict): after one blank line, use `Sources: [file](path#Lstart-Lend)`. Without
  line numbers, keep just the path. Multiple provenance entries are comma-separated.

Correct example:

> Midscene.js's core layer provides AI inference and task scheduling. Agent wraps the user
> intent and coordinates AI with device operations...
>
> Sources: [agent.ts](packages/core/src/agent/agent.ts#L1-L50), [package.json](packages/core/package.json)

## Code blocks

- Code snippets may **only** come from the associated files (copied or excerpted); never
  invent "example code" on the spot.
- **Anti-padding**: when the associated files contain nothing writable as code (pure config,
  pure type declarations, pure Markdown), the correct number of code blocks is **0** —
  forcing one in means fabricating source code, which is a failure, not compliance.
- Never pad length with glossaries; a glossary is warranted only when terms are genuinely
  dense and need a single shared explanation.

## Pre-delivery checklist

Confirm each item before emitting `write_page` (aligned with lecture-to-notes' delivery
checklist, adapted from "lecture notes" to "code wiki"):

1. Every H2 has **substantive prose** beneath it — not a heading list or pure diagram stacking.
2. Every key claim is followed by a `Sources:` line pointing at a real file (paths and line
   numbers are never invented).
3. All Mermaid node labels are quoted.
4. Every referenced file path **actually exists** (confirmed with `read` / `find`, not guessed).
5. Code snippets come from the associated files (copied or excerpted), not invented on the spot.
6. No invented interfaces, function signatures, parameters, return values, or version numbers.
7. No chatbot residue ("let's take a look", "it's worth noting"), marketing-style long
   sentences, or decorative bold (bold is only for a core concept introduced for the first time).
8. Sections end on **concrete facts**, not on empty phrases like "the future is promising".
9. No padding by paraphrase (the same claim restated in different words, or one idea split
   across two paragraphs to look longer).
10. No copying README / AGENTS.md / CHANGELOG prose wholesale — project docs are injected
    automatically via `<project_context>`; the page explains the code itself and must not
    restate those documents.
11. Mermaid and code-block counts follow the "0 is the right answer when the source has none"
    rule (0 diagrams when the page covers no topology; 0 code blocks when the associated
    files hold nothing writable as code).
