# Helm design system - "Nocturne Islands" (v1)

Every surface in Helm follows this system. It was chosen from three explored
directions (direction 1a, "Nocturne Islands") and specified in the design
package the redesign was built from; this file is the in-repo authority. If a
change cannot be expressed in these tokens and rules, the change is wrong or
this file needs a deliberate amendment - not a one-off exception.

The tokens live in `packages/ui/src/styles/theme.css` and are exposed to
Tailwind via `@theme inline`, so components only ever use the semantic
utilities (`bg-surface`, `text-fg-muted`, `rounded-island`, ...). No raw hex
values in components, with one deliberate exception noted under
"Foreign-ground islands".

## 1. Color

Same eleven roles in both modes, so every component maps 1:1. Dark is the
design's home; light is a first-class equivalent, not an afterthought.

| Role            | Utility          | Dark                    | Light                  |
| --------------- | ---------------- | ----------------------- | ---------------------- |
| canvas          | `bg`             | `#12131F`               | `#ECEEF4`              |
| island          | `surface`        | `#1A1C2B`               | `#FFFFFF`              |
| raised          | `surface-raised` | `#202233`               | `#F4F5FA`              |
| sunken          | `surface-sunken` | `#0D0E17`               | `#E2E5EE`              |
| hover           | `hover`          | `#242639`               | `#E6E8F1`              |
| active          | `active`         | `#2B2D44`               | `#DDE0EC`              |
| border          | `border`         | `rgba(233,233,237,.08)` | `rgba(22,24,38,.10)`   |
| border-strong   | `border-strong`  | `rgba(233,233,237,.16)` | `rgba(22,24,38,.20)`   |
| fg              | `fg`             | `#E9E9ED`               | `#1D1F2E`              |
| muted           | `fg-muted`       | `#9397AB`               | `#595D6C`              |
| subtle          | `fg-subtle`      | `#75798C`               | `#75798C`              |
| accent          | `accent`         | `#9184D9`               | `#6F61C4` (accent-600) |
| accent-soft     | `accent-soft`    | 14% alpha accent        | 10% alpha accent       |
| accent-text     | `accent-text`    | `#D2CEFD`               | `#5A4DA8`              |
| ok / warn / bad | `success` etc.   | `#8FBF7F` `#D9B36C` `#D97C76` | `#2F7A43` `#9A6B12` `#C03B38` |

Accent usage is the defining rule: **the accent never floods.** It appears as
2px marks, outlines, checkbox fills and text (`accent-text`); area fills come
only from `accent-soft`. `accent-fg` is the color of a glyph punched out of a
solid accent fill (the canvas color in dark, white in light) and is only for
checkboxes.

## 2. Type

Inter for the interface; Cascadia Mono / ui-monospace for machine data. Base
size 13px. Numerals are tabular wherever a number can change.

- **title** 20-21 / 500 / tracking -1%
- **heading** 15-17 / 500
- **body** 13 / 400 / lh 1.5
- **meta** 11 / 400 / muted
- **label** 10 / 600 / uppercase / tracking .07em / subtle
- **mono** 11-11.5 for paths, branches, hashes, costs, sizes
- **stat** 21-22 / 500 / tabular

No text heavier than 500 except the ≤11px caps labels (600). Hierarchy is
size and space, not boldness.

Mono is not decoration: if a value is machine data (a path, a branch, a hash,
a size, a duration, a command), it is mono. If it is a name or a sentence, it
is Inter.

## 3. Island anatomy

Everything floats. The window paints the sunken canvas; every pane is an
island - a surface with a 1px hairline edge - separated by 8px gutters
(`gap-2` / `p-2` in the shell). Nothing sits bare on the canvas except the
status bar and the tab strip.

Three elevations, encoded as radius tokens:

- `rounded-island` (10px) - panes on the canvas
- `rounded-raised` (8px) - stat cards, code wells, list boxes *inside* an island (`bg-surface-raised`)
- `rounded-well` (7px) - inputs, filter fields, buttons, row hovers (`bg-surface-sunken` for inputs)
- `rounded-full` - pills and tags

**No stacked shadows.** Elevation is an edge plus the darker canvas behind
it. The one exception is modals: `rounded-xl border-border-strong
shadow-panel` over a dimmed backdrop.

Dividers inside an island fade to transparent at their ends - use the
`.island-rule` class, not `border-b`.

## 4. Controls

- **Primary button**: outlined in the accent, never solid-filled.
  `rounded-well border border-accent text-accent-text hover:bg-accent-soft`.
  Disabled keeps the outline at reduced opacity; it never swaps to a grey fill.
- **Secondary button**: `rounded-well border border-border-strong text-fg hover:bg-hover`.
- **Ghost button**: no border, `text-fg-muted hover:bg-hover hover:text-fg`.
- **Danger button**: outlined `border-danger/45 text-danger`.
- **Input / filter**: sunken well - `rounded-well border-border bg-surface-sunken`,
  focus swaps the border to the accent. Focus ring elsewhere is 2px accent at
  2px offset (global `:focus-visible`).
- **Segmented control**: a sunken well (`rounded-well border-border
  bg-surface-sunken p-0.5`) whose chosen segment lifts to
  `bg-surface-raised ring-1 ring-border-strong` at `rounded-[5px]`.
- **Checkbox**: solid accent with an `accent-fg` check; unchecked is a 1.5px
  `fg-subtle` outline.
- **Tags / badges**: pills - hairline `border-strong` outline for neutral
  ones, `bg-accent-soft text-accent-text` for scope/kind badges. No borders on
  chips at row density; tone carries them (see `Chip`).

## 5. Patterns

- **List rows**: two lines - name above, machine data below, counts pinned
  right. Selection is `bg-accent-soft` plus a 2px accent bar down the left
  edge (absolutely positioned, `rounded-full`), never a solid fill. Hover is
  `bg-hover`. Row radius is `rounded-well`.
- **Folder tabs**: the active tab lifts into the pane island below it - same
  fill, hairline border on three sides, `rounded-t-[9px]`, `-mb-px` overlap,
  `z-10`. Inactive tabs are bare text (`fg-muted`). A session tab lifts into
  the terminal ground instead (see below).
- **Stat groups**: raised cards, 21px/500 tabular figure over a 10px subtle
  label.
- **Status bar**: plain 10.5px subtle text directly on the canvas, segments
  separated by 1px x 10px `border-strong` slivers. No border, no fill.
- **Section labels**: the 10px/600 caps label style, everywhere a section
  needs a name.

## 5b. Shell chrome

- **Title bar**: the native bar is hidden on Windows; Helm draws its own
  brand strip (accent square + "Helm", the drag region, the theme toggle) and
  the Window Controls Overlay paints the min/max/close buttons in canvas
  colours (`main/chrome.ts`). The overlay is retinted on every theme change.
- **Split view**: sessions never share the workspace strip. They dock as a
  resizable split on the right with their own folder-tab row; the divider is
  a 3px `border-strong` grip that goes accent on hover, drag-bounded 20-80%.
  Each strip ends in a ⤢/⇱ maximize toggle.
- **Project shell**: a project pane carries a plain shell (PowerShell, cwd at
  the project) as a terminal island below it - roughly a third of the pane,
  hidden while the session split is open. It is furniture, not a session: no
  row, no history, no notification.

## 6. Foreign-ground islands

Two islands host content Helm does not own: the terminal and the embedded
document/artifact viewer. The rule: **the island's chrome is themed; the
content's ground is its own, fixed in both modes.**

- The terminal keeps `#11121A` (`bg-terminal`) in both modes - load-bearing
  for Spike C's color checks, and the reason a session's *tab* also keeps its
  own fixed text color (`#dde1ea`) when active.
- A rendered document or artifact paints whatever ground it declares; never
  invert it, never theme it.
- The hairline edge and the island radius are what make a foreign surface
  belong; the sandbox strip marks the seam.

## 7. Do / Don't

Do:

- One island per pane; nothing bare on the canvas
- Accent as 2px marks, outlines and text - selection tint is accent-soft
- Mono for machine data: paths, branches, hashes, costs, sizes
- Two-line rows: name above, chips below, counts pinned right
- Fade long dividers to transparent at their ends (`.island-rule`)
- Tabular numerals everywhere a number can change

Don't:

- No solid accent fills - not on buttons, not on selections (checkboxes are
  the one exception)
- No stacked shadows; elevation is edge + ambient darkness (modals excepted)
- No pure black or white; every value from the ramps
- No text weight past 500 (600 only on ≤11px caps labels)
- No borders on chips at row density - tone carries them
- No theming foreign grounds - terminal and embedded documents keep their own
- No raw hex in components; tokens only
