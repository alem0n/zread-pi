<!-- Vendored from humanizer SKILL.md v3.0.0 (https://github.com/blader/humanizer, MIT license),
     based on Wikipedia "Signs of AI writing" (WikiProject AI Cleanup).
     Distilled for zread-pi wiki generation: pattern list + core rules + checklist kept,
     teaching before/after examples removed, project-specific protections added.
     Edit here only together with the zh variant. -->

# Writing discipline: make the prose read like a person wrote it

Apply this to every sentence you write. Keep every fact, name, number, path, quote, and citation
that the source supports. Change only how the prose sounds; never add a claim, measurement, date,
or source that you did not verify in the code or context you read.

## Never touch (hard protections for this task)
- Code blocks, inline code, commands, paths, URLs, and link targets: keep them byte for byte.
- YAML frontmatter (`title:` / `slug:`): never rewrite, reorder, or drop it.
- `Sources: [file](path#Lx-Ly)` trace lines: never delete, merge, or reword an existing line.
  Add one only when the path and line range come from files you actually read.
- Mermaid: keep every diagram syntactically valid. A flowchart node label that contains `()`,
  `{}`, `|`, `<br/>`, punctuation, spaces, a path, or mixed CJK/English must stay quoted:
  `A["用户(输入)<br/>说明"]`. Never strip quotes from an existing quoted label.
- Heading levels, table structure, and the section order the page template requires.

## Core rules
1. Cut filler: openers, emphasis crutches, and sentences that only repeat the previous one.
2. Break formulaic structures: binary contrasts, dramatic staging, rhetorical setups.
3. Vary rhythm: mix short and long sentences; two solid items beat three padded ones.
4. Trust the reader: state the fact and skip the softening, hedging, and hand-holding.
5. Cut the quotable line: if a sentence sounds like a slogan, rewrite it as a statement.

## Patterns to remove (strongest first; #1-#5 act on a single sighting)
1. Not X but Y: "not just…, but", "it's not X, it's Y", the contrast split across two sentences. State the point directly; keep a contrast only when both halves inform.
2. One-line closers and dramatic fragments: "That is the real win.", rows of fragments, a word in ALL CAPS. Merge them into a sentence with a specific claim, or cut.
3. Fake profundity: "the real question is", "at its core", "the heart of the matter", "X is the language of Y". Replace the saying with the concrete point.
4. Staged run-ups: "Let's dive in", "Here's what you need to know", "The thing is", a standalone "Honestly". Remove the run-up, not just its tone.
5. Arguing with no one: "This isn't about X", "I'm not saying", "Don't get me wrong", "A tempting approach would be" against an option that appears nowhere else.
6. Forced triads: three parallel items or examples that restate one idea. Merge them or vary the structure.
7. Repeated sentence openings: several sentences in a row starting with the same subject. Merge them or change the subject.
8. Dashes as the universal connector: no em dash (—) or en dash (–) unless the writer's sample
   uses them; use a comma, colon, period, or parentheses instead. Hyphens inside code, paths, and URLs are untouched.
9. Stacked qualifiers: "could potentially arguably". Keep one qualifier only where the source supports it. *Weak alone.*
10. Hyphenated pairs everywhere: hyphen before a noun (`a high-quality report`), none after (`the report is high quality`). *Weak alone.*
11. Passive voice and missing subjects: name the actor when it makes the sentence clearer. *Weak alone.*
12. Overused AI words: additionally, crucial, delve, deep dive, enduring, enhance, foster,
    highlight, interplay, intricate, key, landscape, meticulous, pivotal, robust, showcase,
    tapestry, testament, underscore, valuable, vibrant. Technical uses are fine.
13. Inflated significance: "stands as a testament", "pivotal moment", "plays a key role",
    "enduring legacy", a "challenges and outlook" section, a bright-future send-off.
    Keep the fact and end on the last concrete detail.
14. Vague connection: "associated with", "linked to", "in connection with". Say how the two things relate, or keep the vague wording the source actually gives.
15. Shallow -ing riders: a trailing "highlighting…", "underscoring…", "reflecting…", "showcasing…" bolted onto a simple fact.
16. Sales language: "nestled in", "vibrant", "rich cultural heritage", "breathtaking", "groundbreaking", "in the heart of". State what the thing is.
17. Borrowed authority: "experts argue", "industry reports", "some critics". Name the real source and what it said, or cut the claim. Never invent a source.
18. Avoiding is / are / has: "serves as", "stands as", "boasts", "features", "maintains". Use the plain verb.
19. Bold as decoration: no bold for emphasis by default; a list where every item carries a bold label before the colon becomes prose.
20. Decorative headings: sentence case; no emoji, arrows, or horizontal rules between sections; no top-level heading that repeats the document title.
21. Curly quotation marks: use straight quotes when the target format does. *Weak alone.*
22. Chatbot residue: "Great question!", "I hope this helps", "Let me know if…", offers to continue. Remove the wrapper and keep the content.
23. Knowledge-limit disclaimers and guesses: "as of my last update", "based on available information", "likely". State what the source does not show instead.
24. Heading repeated in the first sentence: cut the echo and start on the content.
25. Writing about the previous version: describe current behavior, not what it replaced.

## Checklist before you finish
- Any not-X-but-Y contrast, one-line closer, dash, forced triad, or decorative bold left?
- Does each section end on a concrete fact instead of a "future outlook" send-off?
- Did you keep every `Sources:` line, code block, frontmatter field, and Mermaid quote intact?
- Did you add any fact, number, date, quote, or citation the source does not support? Remove it.
- Read the prose aloud: is the rhythm human, or is every sentence the same length?
