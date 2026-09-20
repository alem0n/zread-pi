# Reader-first writing discipline (teaching code wiki)

> Adapted from lecture-to-notes' `references/reader-first-writing.md`
> (skill: lecture-to-notes — each item copied first, then made compatible with a
> "code wiki" context). The original wording and numbering **must be preserved**.
>
> Division of labor with humanizer: humanizer = "reads like a human" (anti-AI prose,
> 60–80 patterns); this block = "**teaches the reader**". The two are orthogonal;
> this block is appended **after** humanizer.

## 1. Protect the source before improving the prose

Record these boundaries before drafting (what goes into the page is **code fact**,
not your inference):

- interface signatures, function signatures, parameters and return values, enums and constants;
- call relationships, trigger conditions, failure modes and error-handling paths;
- module boundaries, layering intent, and version behaviors written in the code;
- the boundary between "how the code currently implements this" and "why it was designed
  this way".

Never present an implementation detail as design intent, a single call path as a general
guarantee, or a TODO in a comment as shipped behavior. Explicitly flag uncertain version
behavior as "per the current code". Use attribution ("in the current implementation",
"per `X`") only where it protects a factual boundary — not at the start of every sentence.

## 2. Build the reader's argument map first

Answer each question in one sentence before choosing section titles:

1. What central question does this page answer for the reader?
2. What does the intended reader already know (prerequisite concepts)?
3. After reading, what can the reader **explain / locate / compare / decide**?
4. Which concepts must come first because later concepts depend on them?
5. What evidence (files / line ranges) backs each main answer, and where does it stop?

Turn these answers into **section questions**. A section exists because the reader needs
its answer — not because the source happened to be split into ten files. When a later
explanation supplies the prerequisite for an earlier claim, reorder to close the gap.

## 3. Turn code into teaching prose

- Remove transition sentences that carry no information, repeated rhetorical questions,
  and empty warm-ups.
- Merge explanations scattered across places that answer the same reader question.
- Keep one concrete example close to the mechanism it explains.
- Preserve design trade-offs and known limitations that teach; omit process-level
  small talk that does not.
- Use an analogy only when it genuinely reduces cognitive load, and state where it breaks.
- Do not add examples, motives, or background absent from the source unless verified and
  explicitly marked as "added context".

## 4. Give paragraphs one main job

A useful teaching paragraph usually performs one of these moves:

1. state the answer or claim;
2. explain the mechanism or reasoning;
3. present source evidence or a walkable example;
4. state the consequence, decision rule, or limitation.

Do not force all four into one paragraph: when a paragraph defines a concept, derives a
flow, lists several results, and appends a caveat, split it. When short paragraphs merely
repeat one thought in different words, join them.

Check every sentence handoff: the first sentence should prepare the concept the next one
introduces. End a paragraph with its **result or consequence**, not with a generic claim
that the point "is important".

## 5. Write concrete, natural technical prose

- State the positive proposition directly. Keep "not X but Y" only when the contrast
  prevents a real misunderstanding.
- Replace "it is worth noting that" / "this is very important" with **the consequence that
  follows it**.
- Give the plain meaning before an acronym, project label, stage number, or internal name.
- Prefer explicit subjects and concrete verbs. Explain a mechanism by what it **allows /
  changes / prevents**.
- Review long sentences for stacked clauses — this is a **review signal, not a ban**.
- Remove adjectives the source does not support: "comprehensive", "systematic",
  "significant", "revolutionary", "robust" — unless the code defines or measures them.
- Vary paragraph and sentence rhythm naturally; do not manufacture a "human voice" with
  casual asides, first-person anecdotes, or ornamental metaphors.
- Use "firstly / secondly / finally", "moreover", "therefore", "this means" only to express
  a real sequence or causal relation — not as transition decoration.

## 6. Frame evidence so readers can interpret it

For every key interface or behavior, make clear:

1. what it **is** (interface signature or entry point);
2. **who** calls it (callers);
3. under **which condition** it triggers (trigger condition / lifecycle);
4. its **boundary and failure mode** (when it does not apply, what error it raises).

Use a table for three or more parallel items; the body interprets, the table enumerates.
Mention a figure or table in the prose before it appears. Do not fabricate call chains or
numbers to look technical.

## 7. Open and close sections for the reader

Open each section with the **reader question or its short answer**; give the plain idea
before implementation detail, terminology, boundaries, or exceptions.

Close each section with "what the reader can **now do** / which page to read **next**" —
do not re-list the section's subheadings, do not restate the opening claim, and do not end
on "in summary". When the next section depends on this one's result, write that dependency
as a natural handoff.

The page's final synthesis should:

- state what this page enables the reader to understand or do;
- connect mechanisms across sections;
- separate the code's conclusions from this document's compression;
- name the demonstrated boundary and one concrete follow-up question.

## 8. Revise in separate passes (collapsed to one structured self-check)

After the complete draft exists, the original flow runs seven passes (structure /
argument / source voice / terminology / sentence flow / evidence / rendered reading).
That is unrealistic inside a single agent run, so it is **collapsed into one structured
self-check by the polish agent** (`polish.mode = 'full'`, see `wiki/polish.ts`):

1. **Structure:** prerequisites precede what depends on them; each section answers one question.
2. **Argument:** each paragraph has one main job; evidence is followed by meaning.
3. **Fact boundaries:** code facts and this document's synthesis stay distinguishable.
4. **Terminology:** each term is defined once in reader language, then used consistently.
5. **Sentence flow:** remove oral debris, vague subjects, stacked clauses, mechanical
   contrast, and repeated paragraph templates.
6. **Evidence:** recheck every function name, parameter, line number, and causal statement.
7. **Rendered reading:** read the final written page end to end, not just the diff.

An automated phrase search identifies candidates; it cannot pass the prose gate. Do not
rewrite an accurate sentence merely because it is passive, long, metaphorical, or uses a
question heading. Change it only when meaning, logic, emphasis, or readability improves.

## Final reader-first checklist

- Can a first-time reader state the page's central question after the opening?
- Does each section answer a concrete question before giving details?
- Are technical labels introduced after their plain meaning?
- Can every function name and strong causal claim be traced to the code?
- Are code facts visibly separate from added synthesis?
- Does each paragraph advance the explanation rather than restate it?
- Do transitions follow the logic rather than a fixed template?
- Did density gates add teaching content rather than prose or visual filler?
- Does the conclusion explain value and boundary without replaying the whole page?
