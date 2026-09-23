---
version: 1
slug: "src-views-skills-tsx"
primary_target: "src/views/skills.tsx"
related_targets: ["src/views/layout.tsx","src/app.css"]
---

Scope: the skillsgist index route (`/`), its shell, and the shared view primitives it renders through — `src/views/skills.tsx` (`IndexPage`), `src/views/layout.tsx`, `src/app.css`. Visitor mode: **Operate**.

Audience: the operator who self-hosts this instance (publishes, administers) and the consumer who holds an install key and only ever copies one line. Both are first-class; a single person is usually both.

Job on this page: find a skill by name, description, or body text, read its class and lot at a glance, and leave with either the whole-catalogue order line or one entry's label page.

Constraints that bind every decision here: server-rendered HTML with **no client-side JavaScript, permanently** — forms and links only, motion is CSS or it does not exist. CSP is `default-src 'self'`, so fonts are self-hosted from `public/`. Descriptions are author-supplied and run from one line to fifteen, in English or CJK; the layout is sized for the long one. No logo, no brand asset, no install counts, no popularity data — PRODUCT.md forbids inventing them.

Unresolved: upload ceilings may or may not be permanent; no accessibility standard has been set for the product, so this surface holds itself to WCAG AA contrast and visible keyboard focus as a floor.

## Direction contract

THESIS: The registry is a reagent catalogue. Every skill is a substance carrying a catalogue name, a hazard class, a lot, and the one line that dispenses it. It refuses the registry index this category always ships and that is on screen today: white card, rounded search field, pill badge, dark code block with a copy button.

OWN-WORLD: Label stock `#FBFBF9` under ink `#14171A`. Hairline rules `#D8D4CC` draw every field boundary — nothing is a card, nothing casts a shadow, elevation is declared once as a rule. Catalogue red `#C8352B` is the instance's own mark and the only saturated ink. Hazard amber `#E8A33D` appears only as the filled class diamond for `private`; `public` is the same diamond drawn open. Archivo Narrow sets uppercase field legends at 11px/0.08em; Archivo sets names and specification text; Spline Sans Mono sets every measured value — version, author, size, and the dispense line. Tabular numerals wherever a number is a quantity.

STORY: The visitor understands this catalogue is theirs, not a public registry's; believes any entry is one copyable line from installed; and leaves having either taken the whole-catalogue order line at the masthead or searched, scanned the class column, and opened one label.

FIRST VIEWPORT: One hairline-ruled instrument box spans the measure. Row one: the instance name in ink at the left, function fields (PUBLISH / USERS / ADMIN / SIGN OUT) ruled into cells against the right edge. Row two, the order line: legend `ORDER · ENTIRE CATALOGUE` on the left shoulder, the `npx skills add` command in mono on dark stock across the full measure, selectable whole in one click. Row three, the search field: legend `SEARCH · NAME / DESCRIPTION / BODY` over a full-width ruled field with SEARCH as a solid ink cell at its right edge. Below the box, entries as ruled label blocks — catalogue name large at the left, class diamond and lot in a right rail at a constant x, specification paragraph beneath both, one hairline between entries and nothing around them.

FORM: Reagent Label — Swiss pharmaceutical and laboratory reagent labeling (Sigma-Aldrich bottle stock, Merck catalogue pages, GHS class marks). Candidate 1 of 7 on the grounded list, taken by the user over the roll's assignment as IMPECCABLE'S PICK; the honest risk it was presented with stands — the technical catalogue page is where a careful run in this category most often lands, so the execution has to be exact where it cannot be surprising. Seed key `704dfcce`. Build path: code-led — no image generation was available in the session.

SIGNATURE INTERACTION AND MOTION GRAMMAR: one authored moment, the search field's focus rule. On `:focus-within` a 2px catalogue-red rule wipes left to right across the field's hairline on an exponential ease-out, and the field legend steps from rule gray to catalogue red. Nothing else on the page moves — no row transitions, no entrance animations, no hover lift. Under `prefers-reduced-motion: reduce` the rule appears without the wipe. The page's other designed browser surfaces are static by nature: `::selection` in hazard amber, a catalogue-red caret, a red focus ring, themed scrollbar, and tabular figures.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
