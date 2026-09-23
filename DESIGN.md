---
name: skillsgist
description: A self-hosted Agent Skills registry drawn as a laboratory reagent catalogue.
colors:
  bench: "#eceae3"
  stock: "#fbfbf9"
  sunk: "#f2f0e9"
  ink: "#14171a"
  ink-soft: "#4a5057"
  legend: "#6f6860"
  rule: "#d8d4cc"
  rule-strong: "#b3ada2"
  catalogue: "#c8352b"
  hazard: "#e8a33d"
  dispense: "#1b1d1f"
  dispense-lift: "#26292e"
  dispense-ink: "#e9e5dc"
typography:
  mark:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 90"
  lead:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.025em"
    fontVariation: "'wdth' 94"
  lead-compact:
    fontSize: "1.4375rem"
  account-name:
    fontFamily: "'Spline Sans Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace"
    fontSize: "1.1875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  account-name-compact:
    fontSize: "1.0625rem"
  name:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 96"
  body:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "0.875rem"
    lineHeight: 1.65
  legend:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "0.65rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.09em"
    fontVariation: "'wdth' 88"
  control:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "0.9375rem"
  measure:
    fontFamily: "'Spline Sans Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace"
    fontSize: "0.75rem"
    lineHeight: 1
    fontFeature: "tabular-nums"
  dispense:
    fontFamily: "'Spline Sans Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace"
    fontSize: "0.8125rem"
    lineHeight: 1.45
  document:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "0.875rem"
    lineHeight: 1.7
  document-h1:
    fontFamily: "Archivo, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
    fontVariation: "'wdth' 96"
  document-h2:
    fontSize: "1rem"
  document-h3:
    fontSize: "0.875rem"
rounded:
  none: "0"
spacing:
  hair: "0.375rem"
  step: "0.5rem"
  cell: "0.6875rem"
  field: "0.75rem"
  band: "1rem"
  gutter: "1.25rem"
  entry: "1.375rem"
  void: "3.5rem"
  form: "26rem"
  sheet: "60rem"
components:
  field-cell:
    backgroundColor: "transparent"
    textColor: "{colors.legend}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0 0.9375rem"
  field-cell-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
  field-cell-page:
    backgroundColor: "transparent"
    textColor: "{colors.legend}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0.75rem 0.9375rem"
  field-cell-danger:
    backgroundColor: "transparent"
    textColor: "{colors.catalogue}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0.75rem 0.9375rem"
  field-cell-danger-hover:
    backgroundColor: "{colors.catalogue}"
    textColor: "{colors.stock}"
  channel-input:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.none}"
    padding: "0.6875rem 1.25rem"
  channel-area:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink}"
    typography: "{typography.dispense}"
    rounded: "{rounded.none}"
    padding: "0.6875rem 1.25rem"
  channel-file:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.dispense}"
    rounded: "{rounded.none}"
    padding: "0.6875rem 1.25rem"
  channel-file-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0.4375rem 0.9375rem"
  channel-submit:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0 1.25rem"
  channel-submit-hover:
    backgroundColor: "{colors.catalogue}"
    textColor: "{colors.stock}"
  choice:
    backgroundColor: "transparent"
    textColor: "{colors.legend}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0.75rem 0.9375rem"
  choice-checked:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
  dispense:
    backgroundColor: "{colors.dispense}"
    textColor: "{colors.dispense-ink}"
    typography: "{typography.dispense}"
    rounded: "{rounded.none}"
    padding: "0.6875rem 1.25rem"
  dispense-hover:
    backgroundColor: "{colors.dispense-lift}"
  label-button:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock}"
    typography: "{typography.legend}"
    rounded: "{rounded.none}"
    padding: "0.5625rem 1.25rem"
  label-button-hover:
    backgroundColor: "{colors.catalogue}"
    textColor: "{colors.stock}"
  label-alert:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.catalogue}"
    rounded: "{rounded.none}"
    padding: "0.625rem 0.875rem"
  notice:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.dispense}"
    rounded: "{rounded.none}"
    padding: "0.75rem 1.25rem"
  entry:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "1.375rem 1.25rem"
  ledger-cell:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    typography: "{typography.dispense}"
    rounded: "{rounded.none}"
    padding: "0.5rem 0"
  class-mark-private:
    backgroundColor: "{colors.hazard}"
    textColor: "{colors.ink}"
    typography: "{typography.legend}"
    size: "22px"
  class-mark-public:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.legend}"
    size: "22px"
  document:
    backgroundColor: "{colors.stock}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.document}"
    rounded: "{rounded.none}"
    width: "72ch"
  document-code:
    backgroundColor: "{colors.sunk}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.none}"
    padding: "0.0625rem 0.25rem"
  document-pre:
    backgroundColor: "{colors.dispense}"
    textColor: "{colors.dispense-ink}"
    rounded: "{rounded.none}"
    padding: "0.6875rem 1.25rem"
---

# Design System: skillsgist

## Overview

**Creative North Star: "The Reagent Catalogue"**

skillsgist is drawn as a sheet of laboratory reagent labeling — Swiss pharmaceutical bottle stock, Merck catalogue pages, GHS class marks. Every skill in the registry is a substance on a shelf: it carries a catalogue name, a hazard class, a lot number, and the single line that dispenses it. The interface is the label, not a page about the label. Nothing is a card. Nothing floats. Nothing casts a shadow. The whole instrument is one sheet of stock, ruled into fields by hairlines, with the values printed where a technician expects to find them.

The personality is precise, unhurried and unsalesy. Density is high but never crowded: information sits in ruled compartments with generous internal padding and a single consistent gutter, so the eye moves along rules instead of hunting across whitespace. The palette is almost entirely warm neutral paper and near-black ink, spent deliberately so that the three saturated signals — catalogue red, hazard amber, and the dark dispense channel — land with the force of a printed stamp. The type is one variable superfamily working its width axis for condensed legends, plus one variable mono that is reserved strictly for measured values. The system refuses the registry index this category always ships: white card, rounded search field, pill badge, dark code block with a copy button.

Two product truths are load-bearing here. First, skillsgist serves server-rendered HTML with **no client-side JavaScript, permanently**; its Content-Security-Policy is `default-src 'self'; script-src 'self'`. Every effect in this system is therefore CSS, every interaction is a form or a link, and both typefaces are self-hosted as woff2 variable subsets under `public/fonts/`. That is a durable rule of the visual system, not a temporary condition. Second, the name is `skillsgist`, lowercase, and it is the only confirmed brand commitment — there is no logo and no other brand asset, so the wordmark plus its red diamond is the whole identity.

**Provenance.** This world was chosen by the user from an Impeccable direction round: seed key `704dfcce`, scope `direction`, mode `operate`. The roll assigned **FRONT PANEL** (a mil-spec instrument faceplate). The dealt challengers were **HyperCard Stack** (scored competitive), **Seven-Segment Panel**, **Festival Lineup Sheet**, **Miura Deployable Sheet** and **Vertical Video Feed** — all declined — with the category-standard registry index offered as the standing exit and refused. The user took **REAGENT LABEL**, which was the IMPECCABLE'S PICK card. The round's own log (`.impeccable/questions/0438e5b8.log`) is empty, so this paragraph is the only durable record that the hand was dealt and what was turned down.

**Key Characteristics:**

- One ruled sheet of label stock, never a deck of cards.
- One density everywhere: every route is flush, bands run edge to edge, hairlines do the separating.
- Zero `border-radius` and zero `box-shadow` anywhere in the stylesheet.
- A two-value rule grammar: ink closes an instrument, hairline divides it.
- Exactly three signal colors, each with exactly one meaning.
- One variable superfamily worked through its width axis; one variable mono for measured values only.
- One authored motion moment: the channel's focus rule wiping left to right.
- Author-supplied markdown is rendered on the system's own tokens, never on a second ramp.
- Browser chrome — selection, caret, focus ring, scrollbar, the file-picker button — is themed as part of the system.
- All motion and all interaction are CSS, forms and links; no client-side JavaScript, ever.

## Colors

Warm neutral paper stock and near-black ink carry almost every surface, so that three saturated signals can each mean exactly one thing.

### Primary

- **Catalogue Red** (`#c8352b`): The instance's own mark and the only saturated ink in the system. It is the diamond beside the wordmark, the caret in every text field and textarea, the focus ring, the hover color of an entry name and of the colophon's discovery URL, the wipe rule under a focused channel, the live legend's focus color, the legend and hover fill of a destructive control cell, the legend and link in a notice row, the link color in an empty state and inside a rendered document, and the hover fill of every ink control. It is never a background for a block of content and never used for decoration.

### Secondary

- **Hazard Amber** (`#e8a33d`): The class signal for `private`, and nothing else. It fills the class-mark diamond on a private entry — including the diamond inside the visibility choice — and tints that entry's right rail. It is also the `::selection` highlight, where it reads as the same marker ink lifting a value off the page.

### Tertiary

- **Dispense Black** (`#1b1d1f`): The fill of the dispense channel — the dark band that carries a command you are meant to copy — and of every `<pre>` block inside a rendered document. Its presence is the promise that the text inside it is literal and complete.
- **Dispense Lift** (`#26292e`): The same channel under the cursor; a one-step lightening that confirms the band is live without moving it.
- **Dispense Ink** (`#e9e5dc`): The warm off-white the dispense channel prints in. Slightly warmer than label stock so the channel reads as inverted paper, not as a terminal.

### Neutral

- **Bench Grey** (`#eceae3`): The bench the sheet lies on. It appears only outside the sheet's vertical rules, never as a content surface.
- **Label Stock** (`#fbfbf9`): The sheet itself, and the surface of every band, entry, control strip and empty state. The near-white everything is printed on.
- **Sunk Stock** (`#f2f0e9`): A recessed fill, used only where you can type or choose a file — every channel, and inline code inside a rendered document. It is the system's only "this accepts input" background.
- **Catalogue Ink** (`#14171a`): Body ink. Entry names, page names, the wordmark, document headings, solid ink cells, a checked choice, and the two closing rules that top and tail the instrument.
- **Specification Ink** (`#4a5057`): Running description text, document body text, ledger values and measured values. Lighter than catalogue ink so a name always outranks its specification.
- **Legend Grey** (`#6f6860`): Field legends, input placeholders, hints and band notes. The quietest ink in the system; it names a field without competing with the field's value.
- **Hairline Rule** (`#d8d4cc`): The divider inside an instrument — between bands, between entries, between masthead cells, between control cells, between choices, between ledger rows, down the left of the entry rail.
- **Channel Rule** (`#b3ada2`): The heavier rule that declares a channel you can type into: a channel's top and bottom edges, the four-sided border of a boxed channel or a boxed choice group, and the divider before a channel's submit cell. Also the scrollbar thumb.

### Named Rules

**The Single Saturated Ink Rule.** Catalogue red is the instance's own mark and the only saturated ink in the system. It appears as a mark, a rule, a caret, a ring, a legend or a hover state — never as a fill behind a block of content, and never on more than a few percent of any screen. Its rarity is what makes it read as a stamp.

**The Hazard-Means-Private Rule.** Hazard amber means `private` and nothing else. It is never a warning color, never a highlight for emphasis, never a second accent. If a new state needs a color, it takes a rule weight or a tonal fill.

**The Dispense Rule.** Dark stock means "this is the line you copy." Dispense Black is the only inverted surface in the system, and everything on it is literal, mono and selectable. Nothing decorative is ever placed on dark stock.

**The Destructive-Is-Not-a-Fourth-Meaning Rule.** A destructive control is the ordinary control cell with its legend in catalogue red, inverting to a red fill on hover — rule-and-ink, the same grammar as every other cell. Destruction does not earn a color of its own; it earns the loudest use of the color the system already has.

## Typography

**Display Font:** Archivo (variable, weight `100`–`900`, width `62%`–`125%`; falls back to Helvetica Neue, then PingFang SC / Hiragino Sans GB / Microsoft YaHei for CJK)
**Body Font:** Archivo — the same superfamily. There is no second sans.
**Label/Mono Font:** Spline Sans Mono (variable, weight `300`–`700`; falls back to ui-monospace, SF Mono, Menlo)

Both families are self-hosted from `public/fonts/` as four woff2 subsets — latin and latin-ext for each — preloaded for Archivo latin and served under `font-display: swap`. Self-hosting is not a preference; the CSP forbids third-party font origins.

**Character:** A grotesque that can be squeezed instead of swapped. Archivo's width axis does the work a second condensed family would normally do, so legends, names and running text are visibly the same voice at different pressures — the discipline of a printed label sheet where one typeface sets the whole bottle. Spline Sans Mono is the instrument readout: strictly reserved for things that were measured.

### Hierarchy

- **Mark** (`700`, `1.0625rem`, width `90%`, `-0.015em`): The `skillsgist` wordmark in the masthead, set beside a 0.5rem catalogue-red square rotated 45°. Lowercase, always.
- **Lead** (`600`, `1.75rem`, width `94%`, `-0.025em`, `1.1`; `1.4375rem` below the breakpoint): The page-name role, and the largest type in the system. A route uses it when the page's subject is a proper name it should announce once — the skill page's own slug. Only one Lead per page.
- **Account name** (`600`, `1.1875rem`, mono, `-0.01em`, `1.2`; `1.0625rem` below the breakpoint): The Name role for an identifier rather than a title — an account's username on the admin register. It sits at the Name step, not the Lead step, because a register is a list and its items take the list-item role; it is mono because a username is a value, and it carries no width axis because the mono has none.
- **Name** (`600`, `1.1875rem`, width `96%`, `-0.02em`, `1.2`): A catalogue entry's name in the index, and the headline of an empty state. Slightly condensed and tightly tracked so a long slug stays on one line.
- **Body** (`0.875rem`, `1.65`): Specification text — the author-supplied description — and empty-state prose. Capped at `66ch` on wide viewports; uncapped below the breakpoint. Set in Specification Ink.
- **Legend** (`600`, `0.65rem`, width `88%`, `0.09em`, `1`, uppercase): Every field legend on the instrument, every button and control-cell label, every choice label, every ledger and definition-list term, and the class-mark word. It is also the page title on routes whose subject is a function rather than a name (`Sign in`, `Accounts`, `Publish a skill`). The most-used role in the system. Legend Grey by default; it inherits white inside an inverted cell, catalogue red inside a notice or a destructive cell, and ink inside a class mark.
- **Control** (`0.9375rem`): Text the visitor types into a single-line channel.
- **Measure** (`0.75rem`, tabular numerals): Mono. Lot, author, date, the signed-in username, the discovery URL, every rail value. Anything that was counted, versioned, addressed or dated.
- **Dispense** (`0.8125rem`, `1.45`): Mono at the channel step. The `npx skills add` line, the SKILL.md textarea, the file-picker's filename, ledger rows, band notes, notice rows and document code. On the dispense channel the line is set `white-space: pre` and `user-select: all` so a single click takes the whole command; it wraps to `pre-wrap` below the breakpoint rather than scrolling on a phone.
- **Document** (`0.875rem`, `1.7`; headings `1.1875rem` / `1rem` / `0.875rem` at `600`, width `96%`, `-0.015em`, `1.25`): The rendered SKILL.md — the one place where content the system did not author is typeset. Body in Specification Ink, headings in Catalogue Ink, code at the Dispense step. See **The Document** under Components.

### Named Rules

**The Width-Before-Weight Rule.** Condensation comes from Archivo's width axis (`font-stretch`, `62%`–`125%`), never from a second condensed family, a `scaleX` transform, or a narrow lookalike. Likewise `font-synthesis-weight: none` is set on `body`: a weight the font does not carry is not drawn. If a role needs to be tighter, move the width axis; if it needs to be heavier, use a real weight.

**The Measured-Value Rule.** Mono is reserved for measurements. A version, an author handle, a date, a URL, a file size, an install command, a username, a SKILL.md source — mono with tabular figures. Prose is never mono; a measurement is never sans.

**The Legend-Names-a-Field Rule.** The uppercase legend is a field label on an instrument, not a decorative eyebrow. Every legend names the field, cell or value directly beneath or beside it. Never stack a legend above a headline purely for texture.

## Layout

The whole application is **one sheet**: a `60rem` column (`--sheet`) centered on the bench, filling at least the viewport height, printed on Label Stock and bounded left and right by a single hairline. The sheet is a flex column — masthead, main, colophon — with main taking the remaining height so the colophon always sits at the bottom of a short page.

**Every route is flush.** There is no padded variant of main and no density switch: bands stack edge to edge and are separated only by hairlines, so the index, the skill page, the publish forms, the account page and the admin roster all read as one continuous instrument running from the masthead's ink rule to the colophon's. The last band inside main drops its bottom rule — including the last band inside a trailing form — so the sheet closes on the colophon instead of double-ruling against it.

Inside the sheet, everything aligns to a single `1.25rem` gutter. Legends, entry names, specification text, band notes, ledger columns, the first cell of a control strip and the colophon all start at that x. Full-bleed elements — the dispense channel, every input channel, the choice group — deliberately break it and run rule-to-rule across the measure, which is how you can tell at a glance that they are channels rather than content. A band that carries one of them (`band--bleed`) zeroes its own inline padding and re-applies the gutter to its head, its note, its body and its form only; if the channel or choice group is the band's last child, the band also drops its bottom padding and bottom rule so the channel closes the band itself.

A catalogue entry is a two-column grid: the content column (`minmax(0, 1fr)`) carries the name and the specification; a fixed `12.5rem` rail sits at a constant x, separated by `1.25rem` and opened by a hairline on its left edge, and carries the class mark above a definition list of measured values. Because the rail's x never moves, the class column scans vertically down the page. The skill page reuses the same grid for its own header, with the slug at the Lead step in place of an entry name.

Page actions are a full-bleed **control strip** of ruled cells closed by a hairline at its bottom — the masthead's grammar, reused inside the page. The first cell drops its left rule and pads to the gutter so the strip starts on the text column; every following cell is opened by a hairline. A strip that sits directly above a channel drops its own bottom rule and lets the channel's edge do the work.

Stacked forms are capped at `26rem` and stack their fields `1.125rem` apart, left-aligned, so a login form and a password form read as one narrow instrument on a wide sheet rather than stretching across it.

The vertical rhythm steps in sixteenths of a rem: `0.375rem` between paired values, `0.5rem` under a band head, `0.6875rem` inside a channel or a compact band, `0.75rem` inside a control cell or a choice, `1rem` above a band's content, `1.375rem` inside an entry block, and `3.5rem` of vertical air for an empty state — one lot of silence in place of a result.

**Responsive.** One breakpoint, at `40rem`. Below it the sheet drops its vertical rules and becomes the full viewport; the masthead wraps so the wordmark takes its own ruled row and the function cells split the width beneath it as equal cells; the control strip's cells wrap onto further rows at an even inline padding with the first cell still on the gutter; the choice group stops being a row of cells and becomes a stack separated by top hairlines; the Lead steps down to its compact size; the entry grid collapses to one column and the rail moves below the specification as a wrapped baseline-aligned row with its left rule removed; the definition list becomes an inline flow of label/value pairs; the ledger tightens its column gap; the stacked form drops its `26rem` cap; the dispense channel wraps instead of scrolling; and the specification's `66ch` cap is lifted.

### Named Rules

**The One Sheet Rule.** Content lives on the sheet. Bench Grey is the surround and is never used as a content surface, a section background, or a way to separate two regions — that is what a rule is for.

**The Constant Gutter Rule.** Text starts at the `1.25rem` gutter, everywhere, on every route. Only a channel — something the visitor copies, types into or chooses from — is permitted to run full-bleed past it.

**The One Density Rule.** There is no roomy variant. A new route composes bands, control strips and channels edge to edge exactly like the ones that exist; if it feels cramped, the answer is fewer bands, not more padding.

## Elevation & Depth

**There is no elevation.** The stylesheet contains zero `box-shadow` declarations and zero `border-radius` declarations. Nothing is lifted, nothing is tinted by a scrim, nothing is blurred behind glass. Depth is declared once, as a rule, exactly the way a printed label sheet declares it.

Two devices do all the work. The first is a **two-value rule grammar**: Catalogue Ink (`#14171a`) closes an instrument — the bottom of the masthead and the top of the colophon are the only ink rules on the page, and they bracket everything between them — while Hairline Rule (`#d8d4cc`) divides the inside: band from band, entry from entry, cell from cell, choice from choice, row from row, content column from rail. A third weight, Channel Rule (`#b3ada2`), is not a divider at all; it exists only to declare the edge of something you can operate. Reading rule weight tells you where you are: ink means boundary, hairline means compartment, channel rule means input.

The second is **tonal fill**. Four surfaces, in order of recession: the dispense channel (`#1b1d1f`) cuts through the sheet, the sunk field (`#f2f0e9`) sits slightly below it, the sheet itself is Label Stock (`#fbfbf9`), and the bench (`#eceae3`) lies outside. Inverting a cell to ink — a hovered control cell, a checked choice, a submit — is a fifth, momentary state of the same device. A surface's meaning is carried by its tone, not by how far it appears to be off the page.

### Shadow Vocabulary

None. The system has no shadow tokens by design.

### Named Rules

**The Flat Rule.** No `box-shadow`, ever — not on hover, not on focus, not on a modal, not as a hairline substitute. A surface that needs to separate from its neighbor takes a rule or a tonal fill.

**The Two-Rule Grammar Rule.** Ink closes an instrument; hairline divides it. Do not introduce a third divider weight, a dashed rule, or a colored rule. The only colored rules in the system are the catalogue-red focus wipe and the hazard-amber rail on a private entry, and both are signals, not structure.

**The Sunk Channel Rule.** Sunk Stock plus a Channel Rule edge means "you can operate this." Never apply that pair to something that is not an input, and never give an input a different treatment.

## Shapes

Every corner in this system is square. `border-radius` is `0` on every element, with no exceptions for buttons, inputs, alerts, channels, choices, the class mark or the sheet — squared corners are what make the page read as printed stock rather than as software chrome.

Form is drawn with rules rather than containers. There are no boxes around content: the masthead's function cells are separated by a left rule each, control cells the same, the entry's rail is opened by a left rule, the bands are stacked and separated by bottom rules, and a channel is bounded above and below rather than enclosed. A cell is a region between two rules, not an outlined shape.

The one licensed four-sided border is **self-closure for an instrument that does not reach the rules**. When a channel or a choice group sits inside a stacked form rather than running the full measure, it takes `1px` of Channel Rule on all four sides so it still declares its own edge; the alert does the same in Catalogue Red. A four-sided border always means "this is a thing you operate or a thing that is shouting at you" — never "this is a container for content."

The one non-rectangular geometry in the system is the **diamond** — a square rotated 45°. It appears as a 0.5rem catalogue-red mark before the wordmark, and as the 22px class mark wherever a class is stated: on every entry, on the skill page header, and inside the visibility choice on the publish form (a `24`-viewBox path, `1.6` stroke width, round joins, ink stroke). Filled with hazard amber it means `private`; drawn open with no fill it means `public`. Same geometry, two states, one glance. Inside a checked choice the stroke inverts to Label Stock while the amber fill stays, so the mark survives the inversion.

Links carry a 1px underline at `0.2em` offset. The focus ring is a 2px catalogue-red outline at 2px offset — square, like everything else; a choice cell draws the same ring inset by `-2px` so the ring lands on the cell's own rules instead of bleeding into its neighbor.

### Named Rules

**The Zero Radius Rule.** No corner is ever rounded. A rounded input, a pill badge, or a rounded button is out of the system, full stop.

**The Diamond Rule.** The rotated square is reserved for identity and class. It marks the instance (red, beside the wordmark) and it marks an entry's class (amber filled for private, open for public), including where that class is being chosen. Do not use it as a bullet, a decoration, or a third meaning.

**The Self-Closing Channel Rule.** A channel that runs rule-to-rule is bounded above and below only. A channel that does not reach the rules closes itself on all four sides in Channel Rule. Nothing else in the system gets a four-sided border except the alert.

## Components

### Buttons

- **Shape:** Square (`0` radius), as everything is.
- **Primary (ink button):** Catalogue Ink fill, Label Stock legend text, `0.5625rem 1.25rem` padding, with a 1px ink border so the silhouette holds when the fill is replaced. The label is always the Legend role — uppercase, condensed, tracked — and it inherits the button's color rather than carrying Legend Grey, which is what keeps `PUBLISH`, `CREATE`, `SAVE` and `SIGN IN` legible on ink.
- **Hover / Focus:** Fill and border both step to Catalogue Red. No lift, no shadow, no scale. Keyboard focus additionally draws the global 2px red ring at 2px offset.
- **Submit cell (channel):** The same ink fill as a flush cell inside a channel, separated from the input by a Channel Rule on its left, padded `1.25rem` on the inline axis only so it fills the channel's full height. Hover steps the fill to Catalogue Red. Its one use is the index search, the page's primary action. A channel whose submit is not the page's primary action takes the quiet variant instead: transparent with a Legend Grey label, inverting to ink on hover or focus, so a control that repeats once per row never outranks the consequence around it.
- **File-picker button:** The browser's own `::file-selector-button`, themed as an ink cell — ink fill and border, Label Stock text at the Legend step, `0.4375rem 0.9375rem` padding, `0.9375rem` of clearance before the filename, hovering to Catalogue Red. The file input is not hidden behind a custom control; it is dressed as one.
- **Field cell (masthead and control strip):** A transparent cell, opened by a hairline on its left, with a Legend-role label in Legend Grey. On hover or keyboard focus the cell inverts — ink fill, stock text — crossfading over `120ms linear`. This is the system's ghost/tertiary button; it is used for navigation, for page actions and for form submits alike, so a link and a form button are visually identical.
- **Destructive cell:** The same cell with its legend in Catalogue Red at rest, inverting to a Catalogue Red fill with stock text on hover or focus. `DELETE` and `DELETE ACCOUNT` are the only controls that carry it: the treatment is reserved for the two irreversible actions, and a reversible one like revoking an API token takes the ordinary cell even though it is disruptive.

### Cards / Containers

There are no cards. Containers are **bands**, **entry blocks** and **control strips**.

- **Band:** A full-measure region closed by a hairline at its bottom, padded `1rem 1.25rem 1.125rem`. The band head is a wrapping, baseline-aligned row with the field legend at the left and a secondary legend at the right, `0.5rem` above the content; a head that is the band's only content drops that clearance. A compact head-only band (`band--head`) tightens to `0.6875rem` of block padding and is how most routes announce themselves. A bleed band zeroes its inline padding and re-applies the gutter to its head, note, body and form; a bleed band whose last child is a channel or a choice group also drops its bottom padding and rule.
- **Band note / band body:** The two prose slots inside a band. The note is Dispense-step Legend Grey at `66ch` for a caveat under a control (it turns Catalogue Red for a now-or-never warning, such as a token shown once); the body is Body-step Specification Ink at `66ch` for a paragraph that is the band's content.
- **Entry block:** Label Stock, `1.375rem 1.25rem`, a bottom hairline that is dropped on the last child so the list closes against the region below it rather than double-ruling. A private entry recolors its rail's left rule to Hazard Amber — the only structural rule in the system permitted to carry a signal color, and it does so because the rail is the class column. A band may host a single entry with no padding of its own (`band--entry`), which is how the skill page opens.
- **Control strip:** A full-bleed flex row of control cells closed by a hairline, wrapping onto further rows when it runs out of measure. The first cell drops its left rule and pads to the gutter. It is the page's action row and carries the destructive cell when there is one.
- **Corner style / shadow / border:** Square, none, and a rule on one side only. Never a four-sided outline around content.

### Inputs / Fields

- **Style:** Sunk Stock fill, Channel Rule edges, square corners, Catalogue Red caret, Legend Grey placeholders. A channel that runs the measure is ruled above and below; a channel inside a stacked form is ruled on all four sides.
- **Single-line channel:** Control-role type, `0.6875rem 1.25rem` padding, flush to the channel's edges with no border of its own, and its browser outline suppressed in favor of the channel's focus wipe.
- **Textarea channel:** The same channel switched to a block, carrying a mono textarea at the Dispense step with `1.6` line height, `tab-size: 2` and vertical-only resize. It is mono because its content is SKILL.md source — a measured value, not prose.
- **File channel:** The same channel carrying a native file input at the Dispense step, with its button themed as an ink cell.
- **Stacked field:** Legend above, a boxed channel `0.4375rem` below it, an optional Legend-Grey hint `0.375rem` under that.
- **Choice group:** A native radio group drawn as a row of ruled cells. Each choice is a label containing a visually hidden radio, an optional class diamond and a Legend-role word with an optional Dispense-step note; the checked cell inverts to ink via `:has()`, taking its legend, its note and its diamond stroke to Label Stock over `120ms linear`. Keyboard focus draws the red ring inset. Used with the class diamond for visibility on the publish form, and without it for role on the admin form, where it takes the boxed border because it sits inside a stacked form. There is no `<select>` anywhere in the system.
- **Focus:** The global focus treatment — a 2px catalogue-red ring at 2px offset. Every channel replaces that ring with its own authored wipe (below).
- **Error:** Handled at the form level by the alert, not by recoloring the field.

### Navigation

The masthead is a single ruled row, minimum `3rem` tall, closed by an ink rule at its bottom. The wordmark sits at the left in the Mark role with its red diamond; function fields are ruled into cells against the right edge and read as Legend-role labels — `PUBLISH`, `USERS`, the signed-in username (mono, Measure role, weight `500`, so an identity reads as a value rather than an action), `SIGN OUT`, or `SIGN IN` when anonymous. Below `40rem` the wordmark takes a full-width row closed by a hairline and the cells divide the width beneath it evenly, with the first cell dropping its left rule.

In-page navigation is the control strip, which is the same cell grammar moved inside the sheet: `DOWNLOAD ZIP`, `EDIT SKILL.MD`, `UPLOAD AN ARCHIVE`, `MAKE PRIVATE`, `DELETE`. There is no breadcrumb, no tab bar and no sidebar.

The colophon mirrors the masthead: an ink rule on top, then a baseline-aligned row of `DISCOVERY` legend, the discovery URL as an underlined mono value that hovers to Catalogue Red, and the schema version as a legend.

### Alerts

Two rows, both red-legended, and no others.

- **Alert:** The form-level failure. Label Stock fill, a 1px Catalogue Red border on all four sides, Catalogue Red text at `0.875rem`, `0.625rem 0.875rem` padding, inset `1rem 1.25rem` from the band above it. It renders nothing at all without a message. There is no success, warning or info variant.
- **Notice:** A full-measure state row closed by a hairline — a Catalogue Red legend naming the condition and a Catalogue Red link out of it, on one row. Its own type rule is there for a longer statement, but the shipped notice needs none: the legend names the state and the link resolves it. Its one current use is the superseded-version banner on an older version of a skill. It is a statement about what you are looking at, not a response to something you did.

### The Dispense Channel (signature)

The dark band that carries a command. Dispense Black fill, Dispense Ink mono type, `0.6875rem 1.25rem`, full-bleed across the measure, `white-space: pre`, `user-select: all` so one click selects the entire command, `tabindex="0"` so a keyboard reaches it, and horizontal overflow rather than a wrap on wide viewports. Hovering lifts the fill one step (`120ms linear`); selecting inside it paints Hazard Amber like the rest of the page. It has no copy button, because there is no JavaScript — the select-all behavior *is* the affordance, and the band's head legend says so.

### The Class Mark (signature)

A 22px diamond plus a Legend-role word, inline and baseline-friendly, `0.5625rem` apart. `private` is the diamond filled Hazard Amber with an ink stroke; `public` is the same diamond with no fill and an ink stroke. The word is set in Catalogue Ink rather than Legend Grey, because the class is a value, not a field name. It is the first thing in an entry's rail, so class scans as a column; it also rides inside the visibility choice, where the checked cell takes its stroke to Label Stock.

### The Channel (signature)

Sunk Stock between two Channel Rules, full-bleed, holding whatever the visitor operates: a text input, a mono textarea, a file picker, optionally with an ink submit cell flush right. On `:focus-within` a 2px Catalogue Red rule wipes left to right across the channel's bottom edge over `420ms` on `cubic-bezier(0.16, 1, 0.3, 1)`, and a band whose channel is focused steps its live legend from Legend Grey to Catalogue Red over `240ms` on the same curve. Under `prefers-reduced-motion: reduce` both transitions are removed and the rule simply appears.

**The One Moment Rule.** This is the only authored motion in the product, and it belongs to the channel, not to a page — it fires on the index search, on every stacked field, on the SKILL.md textarea and on the admin password reset. It stays one authored moment because only one input can hold focus at a time. Nothing else moves: no entrance animations, no row transitions, no hover lift, no skeleton shimmer, no parallax. The `120ms linear` crossfades on a control cell, a choice and the dispense channel are control-state feedback, not motion, and they are intentionally left running under reduced-motion. If a new surface wants an animation, the answer is no.

### The Ledger (signature)

The system's data table: full-width, collapsed borders, mono with tabular numerals at the Dispense step in Specification Ink. Each row is opened by a hairline on top, `0.5rem` of block padding, everything baseline-aligned. Columns after the first are separated by `1.25rem` of padding rather than a rule — `0.75rem` below the breakpoint. A numeric column is right-aligned and never wraps. Links inside a ledger are Specification Ink underlined and hover to Catalogue Red, so a table of downloads does not turn into a wall of red. The current row is promoted to Catalogue Ink rather than bolded or filled. It carries the file manifest and the version history on a skill page.

A header row is available — left-aligned, baseline, `0.5rem` of clearance beneath it and no rule under it, set in the ledger's own mono rather than at the Legend step. Neither shipped ledger uses it: both are headerless, named by the band head above them instead. Keep it that way unless a ledger grows a column whose meaning the band head cannot carry.

### The Document (signature)

The rendered SKILL.md — the body of every `/s/:slug`, and the only place in the product where content the system did not author is typeset. It is set on the system's own tokens in plain CSS, with no utility framework and no second ramp: `72ch` measure, Archivo body at the Document step in Specification Ink, three heading steps in Catalogue Ink at width `96%`, `list-style: square` for unordered lists, inline code on Sunk Stock at the Dispense step, `<pre>` blocks on the dispense channel's dark stock, blockquotes opened by a left hairline, tables ruled underneath each row with ink-colored heads, and an `hr` that is one hairline. Links inside it are Catalogue Red.

**Known condition:** because the document is author content, it can and usually does open with its own `<h1>`, which means `/s/:slug` carries two `h1` elements — the page's Lead and the document's. The markdown pipeline is a security sanitizer whose tests assert that `<h1>` survives, and the rendered `html` is stored per version at publish time, so demoting author headings would neither be the sanitizer's job nor fix anything already published. The condition is recorded, not repaired.

## Do's and Don'ts

### Do:

- **Do** draw structure with rules. Ink (`#14171a`) closes an instrument, Hairline (`#d8d4cc`) divides it, Channel Rule (`#b3ada2`) declares something you operate.
- **Do** keep every corner square (`border-radius: 0`) and every surface flat.
- **Do** compose new routes flush — bands, control strips and channels edge to edge, separated by hairlines, at one density.
- **Do** start text at the `1.25rem` gutter on every route, and let only a channel run full-bleed.
- **Do** set every measured value — version, author, date, size, URL, command, username, SKILL.md source — in Spline Sans Mono with tabular numerals.
- **Do** reach for Archivo's width axis (`62%`–`125%`) when a role needs to be narrower, and keep `font-synthesis-weight: none` so no weight is faked.
- **Do** theme the browser's own surfaces as part of the system: Hazard Amber `::selection`, Catalogue Red `caret-color`, a 2px Catalogue Red `:focus-visible` ring at 2px offset, `accent-color` on form controls, a themed `::file-selector-button`, and a thin Channel-Rule scrollbar.
- **Do** typeset author-supplied markdown on this system's tokens, at the Document steps.
- **Do** self-host any new typeface as a woff2 subset under `public/fonts/`. The CSP allows `'self'` only.
- **Do** write every effect in CSS. Motion, state and interaction must survive with JavaScript disabled, because there is none.
- **Do** give an empty state its own lot of silence — `3.5rem` of vertical padding, a Name-role headline, and one Body-role line that offers the way out.

### Don't:

- **Don't** add a `box-shadow` or a `border-radius` anywhere, for any reason, including hover and focus.
- **Don't** introduce a fourth color meaning. Catalogue Red is the instance's mark, Hazard Amber is `private`, dark stock is what you copy; a new state — including a destructive one — takes a rule weight, an inversion or a tonal fill.
- **Don't** put Hazard Amber on anything that is not `private`, and don't use it as a general warning or highlight color.
- **Don't** build a card: no four-sided outline around content, no elevated panel, no rounded container, no pill badge. A four-sided border is only ever self-closure for a channel, a choice group or the alert.
- **Don't** add a roomier or denser route variant, or pad `main`. There is one density.
- **Don't** use Bench Grey as a content background or as a way to separate two regions on the sheet.
- **Don't** set prose in mono or a measurement in sans.
- **Don't** let rendered markdown bring its own type ramp, its own link color, its own code block or a utility framework's defaults into the sheet.
- **Don't** stack an uppercase legend above a headline as decoration; a legend must name the field it sits on.
- **Don't** put more than one Lead on a page. A page announces one subject; a list of subjects takes the Name role.
- **Don't** animate anything beyond the channel's focus wipe, and don't add a hover lift, an entrance animation or a transition longer than `120ms` to an ordinary control.
- **Don't** add a copy button, a tooltip, a dropdown, a `<select>`, a modal or anything else that needs a script. If it cannot be a form, a link or a CSS state, it is not in this system.
- **Don't** load a font, script, style or image from a third-party origin.
