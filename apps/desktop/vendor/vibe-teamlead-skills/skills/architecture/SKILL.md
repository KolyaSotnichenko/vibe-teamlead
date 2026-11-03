---
name: architecture
description: Use when designing or documenting a system's architecture — C4 diagrams (context, container, component), sequence, ER and deployment diagrams, architecture.md and Architecture Decision Records. Produces professional draw.io and Mermaid diagrams and checks every draw.io diagram visually with render_diagram before finishing.
---

# Architecture documentation, done professionally

You are producing the architecture a senior engineer would be proud to hand to a team: accurate to the code and the spec, readable at a glance, consistent across diagrams.

## What to produce

Inside the spec directory, under `architecture/`:

```
architecture/
├── architecture.md          # the narrative; links every diagram and ADR
├── adr/
│   └── 0001-<decision>.md   # one file per significant decision (MADR)
└── diagrams/
    ├── context.drawio       # C4 level 1
    ├── containers.drawio    # C4 level 2
    ├── components-<container>.drawio   # C4 level 3, only where it helps
    ├── <flow>.mmd           # sequence diagrams (Mermaid)
    ├── data-model.mmd       # ER diagram (Mermaid), when data changes
    └── deployment.drawio    # only when the task changes how it runs
```

Scale to the task. A small change touching one module needs a short `architecture.md`, one component or sequence diagram and maybe one ADR — not the whole set. Never draw a diagram that says nothing new.

## Diagram types and their jobs

| Diagram | Format | Shows | Leave out |
|---|---|---|---|
| Context (C4 L1) | draw.io | The system as one box, its users and the external systems it talks to | Internal structure, technology details |
| Containers (C4 L2) | draw.io | Deployable/runnable units (apps, services, databases, queues) and how they talk (protocol on every edge) | Classes, functions |
| Components (C4 L3) | draw.io | Major building blocks inside ONE container and their responsibilities | Other containers' internals |
| Sequence | Mermaid `sequenceDiagram` | One important flow end-to-end, including the failure path | Every edge case |
| ER / data model | Mermaid `erDiagram` | Entities, keys, cardinalities that this task adds or changes | Unchanged tables |
| Deployment | draw.io | Where containers run (cloud services, regions, networks) | Application logic |

Mark what this task **adds or changes**: new elements get a dashed 2px border and the word "new" in their description; everything else is context.

## draw.io conventions (house style)

Write native draw.io XML (`<mxfile><diagram><mxGraphModel><root>…`). The draw.io desktop CLI is NOT available here: do not use Mermaid→draw.io conversion, `--layout` or CLI export from the drawio skill. Lay elements out yourself and verify with `render_diagram`.

- **Grid:** coordinates and sizes on a 10px grid; flow **left → right** (users on the left, external systems on the right) or top → bottom for layered views. Keep 60–80px gaps between boxes, 40px padding inside boundaries.
- **Sizes:** people 120×80, containers/components 200×100, databases 160×100 (cylinder shape `shape=cylinder3;boundedLbl=1;size=12;`), external systems 200×100.
- **Text:** `fontFamily=Helvetica;fontSize=12;` for box text, 11 for edge labels, 14 bold for titles. Box label = three lines: **Name** (bold), `[Type: technology]`, one-sentence responsibility — use `html=1` with `<b>`, `<br>`. Keep each line under ~32 characters; widen the box instead of letting text overflow.
- **Palette (neutral, print-safe):** in-scope elements `fillColor=#FFFFFF;strokeColor=#1C1D19;`, the system/container being described `fillColor=#1C1D19;fontColor=#FFFFFF;strokeColor=#1C1D19;`, external systems `fillColor=#E8EAE3;strokeColor=#565951;fontColor=#1C1D19;`, people `shape=umlActor` or a box with `fillColor=#DFE1D9;`. No gradients, no shadows (`shadow=0`), `rounded=0`. One accent only for "new/changed": `dashed=1;strokeWidth=2;`.
- **Boundaries:** system/container boundaries as a container cell (`swimlane;startSize=24;fillColor=none;dashed=1;strokeColor=#565951;fontStyle=1;`) with the children's `parent` set to the boundary id.
- **Edges:** `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#1C1D19;` Every edge has a label: a verb phrase + protocol, e.g. `Reads/writes orders [SQL/TCP]`, `Sends events [HTTPS/JSON]`. Always set `source` and `target`. Avoid crossings: reorder boxes rather than accept them. No more than ~15 boxes per diagram — split otherwise.
- **Title and legend:** a title text cell at the top-left (`Containers — <System name>`), and a small legend bottom-right explaining the box styles used.
- **IDs:** readable and unique (`api`, `db-orders`, `e-api-db`); root cells `0` and `1` (`parent="0"`) as usual.
- **Icons:** only when they add recognition (cloud services). Look up exact styles with the drawio skill's `find-shapes.js` script (`node <skill-dir>/scripts/find-shapes.js "aws4 lambda"`); never guess `mxgraph.*` names.

## Mermaid conventions

- Start every file with a front-matter title, e.g. `---\ntitle: Checkout — happy path and payment failure\n---`.
- `sequenceDiagram`: use `autonumber`, `participant` aliases with readable names, `alt/else` for failure paths, `Note over` for important invariants. Keep it under ~25 messages.
- `erDiagram`: entity names in PascalCase, attributes with types and `PK`/`FK`/`UK` markers, cardinality on every relation with a verb label.
- No theme or colour directives — the app renders Mermaid in its own theme.

## Review loop (mandatory for every .drawio file)

1. Write the `.drawio` file.
2. Call `mcp__auto-claude__render_diagram` with its path. It saves `<name>.png` next to the file and returns the image.
3. Look at the image critically, like a reviewer:
   - any overlapping boxes, labels over lines, or text cut off or overflowing?
   - edges crossing, bending needlessly, or attached to the wrong side?
   - unlabeled edges, inconsistent sizes, misaligned rows/columns?
   - does it answer the diagram's one question at a glance?
4. Fix the XML and render again. Stop when clean (normally 1–3 passes). If `render_diagram` is unavailable, re-check the XML coordinates by hand for overlaps and say so in `architecture.md`.

## architecture.md

Sections, in order (skip what doesn't apply):
1. **Summary** — what is being built and the shape of the solution in 3–5 sentences.
2. **Context** — link `diagrams/context.png`; users and external systems.
3. **Containers** — link `diagrams/containers.png`; a table: container, technology, responsibility, owner of data.
4. **Key flows** — one subsection per sequence diagram, with the `.mmd` embedded as a ```mermaid block.
5. **Data** — ER diagram block and migration notes.
6. **Cross-cutting concerns** — security (authn/z, secrets, input validation), performance and scaling assumptions, observability (logs/metrics/traces), failure handling.
7. **Decisions** — bullet list linking each ADR with one line each.
8. **Constraints for the planner** — concrete rules the implementation must follow (module boundaries, interfaces, naming, where new code lives). The planner reads this section.
9. **Acceptance criteria mapping** — which components realize which `AC-n` from the spec.

Write for engineers: precise names that match the code (check with CodeGraph / Grep), no marketing words, no speculation presented as fact.

## ADRs (MADR)

`adr/NNNN-kebab-title.md`:

```
# NNNN. <Decision as a short imperative or noun phrase>

- Status: accepted
- Date: <YYYY-MM-DD>
- Deciders: architect agent (Vibe Teamlead)

## Context and problem statement
## Considered options
1. <Option> — <one line>
## Decision outcome
Chosen option: "<option>", because <justification tied to requirements/constraints>.
### Consequences
- Good: …
- Bad: …
## Links
- Spec: AC-n …
```

Write an ADR only for decisions that are costly to reverse or that a future engineer would question (data store, sync vs async, auth approach, new dependency, module boundary). Match existing ADRs in the repository (`docs/adr`, `adr/`) if the project already has them.
