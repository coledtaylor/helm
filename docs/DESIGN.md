# Helm design system - "Nocturne Islands" (v2)

Every surface in Helm follows this system. It was chosen from three explored
directions (direction 1a, "Nocturne Islands") and specified in the design
package the redesign was built from; this file is the in-repo authority. If a
change cannot be expressed in these tokens and rules, the change is wrong or
this file needs a deliberate amendment - not a one-off exception.

**v2** made the palette a theme and the shape a setting. What did not change
is every rule about how the tokens are *used*: islands on a canvas, the accent
never floods, no shadows outside modals, no text past 500, mono for machine
data.

The shell around them was rebuilt in the same overhaul: a rail of
destinations, a sidebar that is projects with their sessions nested, and
panes split any way across the rest, each an island with its own strip of
one-line tabs (§5b).

Components only ever use the semantic utilities (`bg-surface`,
`text-fg-muted`, `rounded-island`, `gap-gutter`, ...), exposed to Tailwind via
`@theme inline` in `packages/ui/src/styles/theme.css`. No raw hex values in
components, with one deliberate exception noted under "Foreign-ground islands".
A theme's colour drawn *as data* - the Appearance pane's swatches - is not a
raw hex: it is a value core parsed and re-spelled, set as an inline style.

## 1. Themes

A theme is nineteen colour roles and nothing else. Same roles in every theme,
so every component maps 1:1 whichever is on screen. Themes are **data**, not
CSS: the three built-ins are `BUILTIN_THEMES` in `core/theme/themes.ts`, a
user's are JSON files, and the renderer paints the one on screen onto `<html>`
as `--helm-*` custom properties before React's first frame. `theme.css`
declares no palette at all; a second copy of the default there would be the
copy that drifts.

| Role            | Token / utility     | Nocturne (dark)        | Graphite (dark)        | Daylight (light)       |
| --------------- | ------------------- | ---------------------- | ---------------------- | ---------------------- |
| canvas          | `bg`                | `#12131F`              | `#25282E`              | `#E6E8EE`              |
| island          | `surface`           | `#1A1C2B`              | `#1C1F24`              | `#FFFFFF`              |
| raised          | `surface-raised`    | `#202233`              | `#2A2E35`              | `#F4F5F8`              |
| sunken          | `surface-sunken`    | `#0D0E17`              | `#16181C`              | `#EEF0F4`              |
| hover           | `hover`             | `#242639`              | `#272A30`              | `#ECEEF3`              |
| active          | `active`            | `#2B2D44`              | `#30343C`              | `#E3E5EE`              |
| border          | `border`            | `rgb(233 233 237/.08)` | `rgb(255 255 255/.08)` | `rgb(22 24 38/.10)`    |
| border-strong   | `border-strong`     | `rgb(233 233 237/.16)` | `rgb(255 255 255/.15)` | `rgb(22 24 38/.18)`    |
| fg              | `fg`                | `#E9E9ED`              | `#E3E5E9`              | `#1D1F2E`              |
| muted           | `fg-muted`          | `#9397AB`              | `#A0A6B0`              | `#555A69`              |
| subtle          | `fg-subtle`         | `#75798C`              | `#767C87`              | `#6F7383`              |
| accent          | `accent`            | `#9184D9`              | `#6CA6F5`              | `#6F61C4`              |
| accent-fg       | `accent-fg`         | `#12131F`              | `#16181C`              | `#FFFFFF`              |
| accent-soft     | `accent-soft`       | 14% accent             | 15% accent             | 10% accent             |
| accent-soft-hover | `accent-soft-hover` | 26% accent           | 27% accent             | 20% accent             |
| accent-text     | `accent-text`       | `#D2CEFD`              | `#BBD7FF`              | `#5A4DA8`              |
| ok / warn / bad | `success` etc.      | `#8FBF7F` `#D9B36C` `#D97C76` | `#85C28B` `#E3B262` `#E57A7C` | `#2F7A43` `#9A6B12` `#C03B38` |

The values are the source's; this table is for reading, and
`core/theme/theme.test.ts` is what holds every built-in to its floors - body and
muted text at 4.5:1 on every ground they sit on, the accent at 3:1 as a mark
and 4.5:1 as `accent-text`.

- **Nocturne** is v1's dark ramp exactly, so the default look did not move.
- **Graphite** inverts the elevation: the canvas is *lighter* than the
  islands, so a pane reads as a recess in a frame. A component that assumes
  "islands are lighter than the canvas" is wrong in Graphite and nowhere else,
  which is why a UI change is looked at in Graphite too.
- **Daylight** has a lighter canvas and well than v1's light ramp, because 6px
  of canvas between white islands reads as a seam where 8px read as a gutter.

Accent usage is the defining rule: **the accent never floods.** It appears as
2px marks, outlines, checkbox fills and text (`accent-text`); area fills come
only from `accent-soft`. `accent-fg` is the colour of a glyph punched out of a
solid accent fill and is only for checkboxes.

**Two slots and a switch.** The setting is not one theme. `themeDark` and
`themeLight` each name a theme, and `theme` (`system` / `dark` / `light`) says
which slot is on screen - whichever Windows is in, or one always. That is what
lets "Follow Windows" mean something with more than one theme of a kind, and it
is why the title bar's three-way toggle needs no change. `.dark` on `<html>`
says the *theme on screen* is dark; it is not a statement about Windows.

**A chosen accent is a hue, not a value.** `accentColor` overrides the theme's
accent, and `deriveAccent` fits it to the theme: the nearest value that holds
3:1 for marks and 4.5:1 for `accent-text` against that theme's island, with the
tints at the theme's own alphas. One swatch is therefore a different hex on
Nocturne and on Daylight, by design.

**User themes** are `*.json` in `~/.config/helm/themes` (beside the exe for a
portable build), watched while the app runs - a save repaints the window. A
file names its `kind` (or `extends` a built-in) and only the colours it
changes; the rest come from the built-in it extends. Grounds and text must be
opaque - `bg` and `fg-muted` are also the colours Windows paints the title-bar
buttons with, which takes no alpha - and only the two borders and two accent
tints may be translucent. A wrong value falls back by itself and is named in
the Appearance pane; a file that cannot be read as a theme is skipped and named
there too. A slot naming a theme that is gone shows the built-in of its kind.

**Native chrome follows the theme.** The window's own background (what Chromium
shows before the first paint) and the Window Controls Overlay are repainted
from the same resolved theme on every change (`main/chrome.ts`).

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

Everything floats. The window paints the sunken canvas; the sidebar and every
pane are islands - a surface with a 1px hairline edge - separated by gutters of
canvas (`gap-gutter` / `pr-gutter` in the shell). Nothing sits bare on the
canvas except the rail down the left edge and the status bar along the bottom,
and both are deliberately chrome rather than content: icons and a caption line.

**One island per pane, and a pane with sections is still one island.** A header,
a body and a footer that belong to the same subject are separated by
`.island-rule`s inside a single surface, not floated as three islands with
gutters between them: the gutters buy nothing, cost two of them out of the
reading width, and make the header read as a summary card sitting above some
other pane's contents.

**A page draws no island at all.** The pane it sits in is already one - its
hairline, its surface, its tab strip - so every page (history, config, content,
settings, a project, the browser) is drawn on the pane's own surface, edge to
edge. Its bar is a row under the tab strip with a hairline below it; a list
beside its detail is split by a hairline on the list's right edge; a long page
such as Settings or a project is sections under `.island-rule`s, each with its
caps label, not a card per section. Cards stay for what is a thing in itself - a
theme to pick, a stat - never as the way a page groups its own parts.
`lib/page.ts` holds the bar and the list edge. The one page that is still an
island is the welcome page, because it stands in for a pane when there is none.

### Shape

Three settings, all custom properties on `<html>` that `applyShape` writes, so
every gutter, corner and dense row in the app moves with them and nothing has
to be told:

- **Gap** (`paneGap`, 2-12px, default **6**) - `--helm-gap`, the
  `gutter` spacing token. A divider handle *is* the gutter it sits in (its row
  is `h-gutter` / `w-gutter`) and keeps an 8px hit target through a `::before`
  whatever the gap is.
- **Corner radius** (`cornerRadius`, 0-8px, default **3**) - `--helm-radius`.
  It is one knob, not five, because the relation is fixed:

  - `rounded-island` = radius - panes on the canvas
  - `rounded-raised` = radius - cards, code wells, list rows, segments and tabs
    *inside* an island (`bg-surface-raised` for cards)
  - `rounded-well` = radius + 1 - inputs, filter fields, buttons and popups,
    so a control reads as a separate thing from the panel it sits in
  - Tailwind's own `rounded`, `rounded-sm` to `rounded-xl` are folded onto
    radius + 1, and `rounded-xs` onto radius - 1, so a `rounded-md` written
    tomorrow follows the setting instead of escaping it
  - `rounded-full` - pills, tags and swatches

  A literal radius (`rounded-[5px]`) is a corner the setting cannot reach and
  is not used.

  The window's own corner is Windows 11's to draw, and DWM offers square, 4px
  and 8px and nothing between. Helm asks for 4px (`main/corners.ts`), which is
  the default `rounded-well`, and it does not follow the setting. The window's
  1px edge is the theme's `border` composited over `bg` (`main/chrome.ts`), so
  it is a hairline like every other rather than the OS accent colour.
- **Density** (`comfortable` / `compact`) - `--helm-row-y` (a list row's
  vertical padding, `py-row`: 6px / 3px), `--helm-line` (one line of the
  sidebar tree, `h-line`: 26px / 22px) and `--helm-strip` (a pane's tab strip,
  `h-strip`: 36px / 32px). Text size and controls' own padding never change
  with it; density is how tightly the repeated things pack, not a zoom.

**No stacked shadows.** Elevation is an edge plus the canvas behind it - which
in Graphite is a lighter frame rather than a darker one, and the rule holds
either way. The one exception is modals: `rounded-xl border-border-strong
shadow-panel` over a dimmed backdrop.

**`Overlay` is the one owner of that treatment.** The scrim, the centring, the
z-index, the island and its shadow, and Escape-to-dismiss all live in
`packages/ui/src/components/Overlay.tsx`, and every dialog routes through it -
a call site says how wide its island is, and a palette says `align="top"`,
and nothing else. This is the only
place in `packages/ui` or the renderer allowed to write `fixed inset-0`;
**`no-raw-overlay`** in `eslint.config.js` refuses it everywhere else, and
exempts that one file by name.

It is a rule the linter holds because it is a rule that gets forgotten. The
four dialogs each had their own copy of the backdrop, so nothing in the app
knew a dialog was open - and the integrated browser pane is a
`WebContentsView`, a native view that paints above all renderer DOM and has to
get out of the way while one is. `Overlay` records that in `lib/overlay.ts`,
which anything can subscribe to (`useOverlayOpen`, `subscribeOverlay`); the
alternative was a fifth dialog, written a year from now, that nobody
remembered to tell.

A toast is not a modal. The launch toast has no scrim and does not acquire one
to satisfy this mechanism.

**Helm draws its own dialogs, including the ones the main process asks for.**
A `dialog.showMessageBox` is a Win32 window - system typeface, system ground,
a blue circled "i" - and nothing in this document can reach it. Where main owns
the question but the user owns the answer, main pushes the question to the
renderer and waits (`session:confirm`). The native box stays as the fallback
for when there is no window to ask, because a Helm that cannot be quit is worse
than an unbranded dialog. A destructive confirmation focuses **Cancel**, and
its accepting button carries `border-danger/50 text-danger` with a
`bg-danger/10` hover - never a solid fill, same rule the accent follows. The
**Cancel** button takes its focus ring on plain `:focus` rather than the global
`:focus-visible`: focus is placed there by script when the dialog opens,
Chromium does not count that as visible focus, and a default action nothing
marks is a default action nobody can see.

Dividers inside an island fade to transparent at their ends - use the
`.island-rule` class, not `border-b`.

## 4. Controls

**Affordance.** Two things are true of every control here, and neither is a
call site's to remember:

- It takes the **pointer cursor**. `body { cursor: default }` still holds - over
  prose, over a pane, over the canvas, this is desktop chrome and the arrow is
  the resting state - but the controls are lifted out of it by a `:where(...)`
  rule in `theme.css` keyed on what a thing *is*: a button, a link, a select, a
  summary, a checkbox and its label. Disabled ones keep the arrow. This reverses
  the older rule, which was that nothing had a pointer at all.
- It **changes appearance under the pointer**. Which property is the recipe's
  business - a fill for a row or a button, a border for a field, a text tone for
  a ghost - but *something* must move, and something visible: `bg-hover` on top
  of `surface-raised` is a measurable change nobody can see, which is why the
  chosen segment below hovers to `active` instead.

Tailwind v4 gates `hover:` behind `@media (hover: hover)`, and on a machine
reporting no fine pointer that killed **every** hover state in the app at once,
silently, with the tokens resolving and the classes present. `theme.css`
overrides the gate; keep it.

- **Primary button**: outlined in the accent, never solid-filled.
  `rounded-well border border-accent text-accent-text hover:bg-accent-soft`.
  Disabled keeps the outline at reduced opacity; it never swaps to a grey fill.
- **Secondary button**: `rounded-well border border-border-strong text-fg hover:bg-hover`.
- **Ghost button**: no border, `text-fg-muted hover:bg-hover hover:text-fg`.
- **Danger button**: outlined `border-danger/45 text-danger`.
- **Input / filter**: sunken well - `rounded-well border-border bg-surface-sunken`,
  hover strengthens the hairline to `border-border-strong`, focus swaps it to
  the accent. That border *is* the focus indicator, so a field takes **no**
  offset ring - the two together read as two rings around one input. Set
  globally in `theme.css`, not per component. Focus ring everywhere else is 2px
  accent at 2px offset (global `:focus-visible`); checkboxes and radios keep it,
  having no border to move.

  The hover is on the **border and never the fill**, and that is not a
  preference. A select's dropped-open list is an OS window that reads the
  control's own `background-color`; a fill that changes under the pointer is a
  fill the platform can catch mid-change and paint the listbox with.
- **Segmented control**: a sunken well (`rounded-well border-border
  bg-surface-sunken p-0.5`) whose chosen segment lifts to
  `bg-surface-raised ring-1 ring-border-strong` at `rounded-raised`. For a
  choice of two to four; past that it is a select.

  The chosen segment hovers to `bg-active`, not to `bg-hover` like everything
  else, and this is the one place the ramp is skipped deliberately: the segment
  rests on `surface-raised`, and `hover` sits six points from it across the
  whole channel in Nocturne. `active` is one clear step above where the segment
  actually is. The class lives in `ui/src/lib/segmented.ts` as `SEGMENT_ON`,
  because the string was copy-pasted at nine call sites and the tone is the part
  that must not drift; the *unchosen* tone stays per-site, since icons sit at
  `fg-subtle` and words at `fg-muted`.
- **Select**: a native `<select>` in the input's sunken-well shape, with
  `appearance-none` and the app's own `CaretIcon` rotated 90°. Native and not
  a listbox of our own so that a driver can set it through
  `HTMLSelectElement.prototype.value`, which a div cannot be. **The platform
  arrow is always replaced**: Chromium draws a heavy chevron in its own colour
  that reads as a control borrowed from another program, which is most obvious
  on a foreign-ground island where nothing else is system-drawn.

  **Its open list is the menu recipe, drawn by CSS.** Every select is
  `appearance: base-select` (`theme.css`, unlayered so it outranks
  `appearance-none`), which hands the dropped-open list to the page while
  keeping the keyboard, type-ahead and the form value native. Before it, the
  list was an OS window that only the control's own fill reached: Chromium
  painted it white with the page's light text on the rows, and the highlighted
  row in the Windows selection colour. Now it is `surface-raised` behind a
  `border-strong` edge, rows `hover` under the pointer and `accent-soft` for the
  chosen one, no tick. The list is DOM in the top layer, so it no longer paints
  over a browser tab's native view - which is fine for a select inside a pane,
  whose list opens in that pane, and is why the Files view's project picker,
  whose list crosses the sidebar's edge, is a `Menu` instead (below).
- **Menu** (`Menu.tsx`): a list that drops from a control or opens at the
  pointer - the Files view's project picker, the rail's right-click, a pane's
  `+`. The popup recipe: `surface-raised`, a `border-strong` edge,
  `rounded-well`, no shadow,
  4px of padding; rows 28px, 12px text, `hover` under the pointer or the keys,
  a tick column only where something is ticked. Arrows, Home and End,
  type-ahead, Enter, Escape; focus moves in once it is placed and goes back to
  the control that opened it. **It is an overlay while open** (`lib/overlay.ts`),
  so a browser tab's native view stands down for it as it does for a dialog -
  leaving a still of the page where it was, so the menu opens over the page
  rather than over a hole - and it is portalled to the body and kept 8px inside the window, so neither
  the sidebar's clip nor the window's edge cuts it off.
- **Stepper**: a segmented-control shell holding − and + buttons either side of
  a tabular mono readout. For a small bounded integer someone nudges while
  watching the result - a terminal's point size, not a scrollback of 25,000.
  It cannot produce a value out of range, so the control and the validator
  never have to disagree.
- **Checkbox**: solid accent with an `accent-fg` check; unchecked is a 1.5px
  `fg-subtle` outline.
- **Tags / badges**: pills - hairline `border-strong` outline for neutral
  ones, `bg-accent-soft text-accent-text` for scope/kind badges. No borders on
  chips at row density; tone carries them (see `Chip`).
- **State chip**: one pill saying what something *is* rather than what it has.
  A hairline outline in a semantic tone at 40% alpha with the tone's own text
  colour, never a fill. This is the one pill that is allowed a coloured border,
  because it is the only place a single word carries the whole status of the
  thing on screen; everything else at that density stays borderless. It is
  never a solid badge, for the reason the accent never floods: a filled badge is
  the loudest object on the pane and a state is not the loudest fact about the
  thing it describes.

  **The user is the config console's live state** (`ConfigLive`): whether a
  file in a `.claude` tree reaches a session. Live is `success`, outranked or
  partly outranked is `warn`, and read-but-empty or not-in-this-resolution take
  no tone at all - neither is a problem, so neither gets a colour.

  It also has **a state that paints nothing**. Helm has no claim to make about
  most of what sits in a `.claude` directory - a `rules/` file is a convention
  some instruction file may reference, and nothing in the resolution can see
  that reference - so those get no chip and no dot rather than a confident grey
  "not loaded". Same rule as the usage figures: paint nothing rather than a
  wrong number.

## 5. Patterns

- **List rows**: two lines - name above, machine data below, counts pinned
  right. Selection is `bg-accent-soft` plus a 2px accent bar down the left
  edge (absolutely positioned, `rounded-full`), never a solid fill. Hover is
  `bg-hover`. Row radius is `rounded-well`.

  **A state dot may take the head of the row, in place of a kind icon.** The
  config console's rows carry a 6px dot where every other list carries an icon,
  because the group heading two rows up already says `Skills` - the icon was the
  one fact on the row written twice, and whether the thing is reaching a session
  was written nowhere. The dot's slot is held open even when there is nothing to
  say, so the names stay in one column. Where a row's name is something typed at
  a prompt (`spec:plan`, `settings.local.json`) that name is **mono**, by §2's
  rule: it is machine data, not a title.

  **A third line is allowed only for what the row contains**, and there is one:
  a skill's bundled resources, listed under it as `└ prompts.md · score.py`.
  Everything else that wanted a third line has been a fact *about* the row,
  which belongs on the pane it opens.

  **A row carries no buttons: the row itself is the action.** Everything else
  about the thing on it is inside it, one click away, on a pane with room to say
  it. It is the rule for every list here. A row with three glyphs down its right
  edge is a row whose own click target is a guess, and it puts the rare actions
  in front of the common one.

  **The exception is a control that changes which list the row is in**, and it
  is an exception rather than a loophole because such a control is not one of
  the row's actions at all - it is an action on the *list*, and the row is
  simply where the user is pointing when they decide. Two of them exist: a
  profile's pin, and a project's. Both wear the same rules:

  - **Hidden at rest, revealed by `group-hover` on the row** (and by
    `focus-visible`, so it is reachable from the keyboard). A tree of a dozen
    rows still reads as a column of names.
  - **Revealed by opacity, never by mounting.** A control that only exists in
    the DOM under the pointer is one no keyboard reaches.
  - **Nothing on the row moves when it appears.** In a two-line list the row
    holds a gutter open for it. In the sidebar tree, where a project is one
    line, the controls take the place of the branch at the right end while the
    pointer is on the row - a swap in one slot rather than a push - and the
    name never shifts.
  - It carries **no `title`**; the row's own tooltip is the only one.
    `aria-label` says what it does.

  **The tree's project rows carry one more: a terminal, start a session here**, under
  the same three rules and beside the star. It is the exception the overhaul
  was for rather than a crack in the rule: the tree is sessions first, starting
  one is the commonest thing anybody does in it, and making it a page and a
  button away - the project's page, then "Start session here" - put the common
  action behind the rare one. The row's own click still opens the page.
- **Source pills**: a list that draws rows from more than one place carries the
  place on the row, as a hairline `border-strong` pill at the head of the second
  line. This is the one outlined pill allowed at row density, and it earns the
  exception by not being one of the row's facts: everything else on that line is
  *about* the thing on the row, and this says which list it came out of. It
  appears only where the rows have been flattened out of their groups; under a
  heading that already names the source it would be the heading said twice.
- **Diff rows**: two line-number gutters, a sign column, then the line. The left
  gutter is where a line was and the right is where it is, so an added line has
  no left number and a removed one has no right. The row carries the tone as an
  8% tint (`bg-success/[.08]`, `bg-danger/[.08]`) and the sign carries it as
  text; context rows have no tint at all and sit at `fg-muted`, so the eye counts
  the tinted ones. Gutters and signs are `select-none` - a copied diff has to
  come out as code. Hunk headers sit on `bg-surface-sunken` with the text
  starting at the line column, which is what makes them read as a break in the
  file rather than as another line of it. Lines **wrap**; a horizontal scrollbar
  per file turns reading a diff into operating one.
- **Pane tabs**: one-line pills in a strip *inside* the pane's island, above a
  hairline. A pill is `rounded-raised`, `h-strip` less 10px, 12.5px text, a
  state dot or a kind icon, the title, and a close button that shows on the
  front tab (at 60%) and on hover. The front tab of the **focused** pane is
  filled `active`; the front tab of every other pane is filled `hover`; the
  rest are bare `fg-muted` text that takes `hover` under the pointer. So with
  several panes on screen, which one the keyboard means is visible without
  reading.

  They were folder tabs once - the active one lifting into the pane below it,
  borders on three sides and a 1px overlap - and that only works while the
  strip sits *on the canvas* above one pane. With panes side by side, each an
  island, the strip is a row of its pane, and a tab that joined it would join
  nothing.
  It is also what made every tab one line: a folder tab carried what its pane
  did not show on a second line, and the **crumb row** below now says it with
  the pane's whole width.

  One word may follow the title, muted (`badge`): the session that opened a
  browser tab, because a tab Claude opened and one you opened are otherwise
  identical in the strip - or "shared", for a page of yours a session may
  drive. The page itself says which session can drive it in a 30px
  `accent-soft` note above it, `accent-text`, with a secondary "Stop sharing"
  when the user shared it. A strip with no tabs and no actions is **not drawn**.
- **The crumb row**: under a session's tab, 26px of mono `fg-subtle` naming
  where it is - project `›` branch `·` profile - and, at the right in Inter,
  what it is doing and for how long, in its state's tone ("Working · 4m" in
  `accent-text`, "Needs you · 2m" in `warn`). It is the branch's home now that
  tabs are one line: two sessions on one project are told apart here, with the
  room to say the branch in full. A page's tab has no crumb - the page's own
  header names what it is about.
- **The session tab's state dot.** A session tab carries a 6px dot in place of
  a kind icon, and it says two different kinds of thing: what Helm knows about
  the process, and what the session says about itself. Claude Code publishes its
  own status for every live session, and putting it on the tab is the difference
  between a strip of six tabs and a strip that says which one is waiting on you.

  | state | tone | what it is |
  | --- | --- | --- |
  | `busy` | `accent`, filled | the model is working |
  | `waiting` | `warn`, filled | blocked on you - a permission prompt, a dialog |
  | `shell` | `success`, **ring** | handed back, a background task still running |
  | `idle` | `success`, filled | handed back, nothing running |
  | `running` | `success`, filled | alive, and not saying anything |
  | `ended` | `fg-subtle` | exited cleanly |
  | `failed` | `danger` | exited with a code |

  Four decisions in that table are deliberate and each would be easy to undo by
  accident.

  **`waiting` takes `warn`, and it is the reason the whole thing exists.**
  Nothing else on a tab was using the system's attention tone, and this is the
  one state a person needs to be pulled back to. It outranks nothing and is
  outranked by nothing - a session either is blocked on you or is not.

  **`busy` takes the accent, and a 6px dot is a mark rather than a flood.** It
  is the tone for the thing the app is currently about. §1's rule bounds the
  accent to "2px marks, outlines, checkbox fills and text", and a dot the size
  of a checkbox's tick is on the near side of that line - it is also exactly the
  area every other state on this tab already fills solid.

  **`shell` is a ring, not a fifth colour.** "Done" and "done but something is
  still running" are two answers to one question - can I close this tab - so
  they read as one tone in two weights rather than as two unrelated states.
  Outline-versus-fill is already this system's way of saying "not the whole
  thing" (§4, the unchecked checkbox). What it must never do is read as more
  urgent than `waiting`, which is what a third colour would have done.

  **`running` and `idle` paint identically, on purpose.** `running` is the state
  for a session that is alive and is saying nothing - the first second of every
  session, a status this build does not recognise, a registry that could not be
  read. All three are "Helm has nothing to add", and the honest paint for that
  is what the tab painted before any of this existed. A renamed status in a
  future CLI therefore degrades to the old behaviour rather than to a guess -
  the same rule as the usage figures and the config console's live state: paint
  nothing rather than a wrong answer.

  The session's own sentence for *why* it is waiting goes in the tab's hover
  hint and never on the tab. It is the CLI's string, carried verbatim, and a
  pill is already spoken for by a title.

  **The dot is painted in three places** - the tab, the sidebar tree's session
  rows and the sessions pane's rows - so the tones live in
  `ui/src/lib/sessionstate.ts` rather than in any one of them. Same rule
  `ROW_SELECTED` and `SEGMENT_ON` follow: the surfaces legitimately differ in
  geometry, and what must not differ is the tone.

  **`waiting` is said at the scale of the window too.** A pane holding a session
  that is waiting on you takes a `warn/45` edge instead of its hairline, the
  rail's Sessions icon wears a 7px `warn` badge, and the status bar's "needs
  you" is a button that brings the next one forward. Each answers the question
  one level further out than the dot: which pane, whether anything at all, and
  how many.
- **The sessions pane.** Every live Claude Code session on the machine down the
  left, what one of them is holding on the right - the narrow-pane shape §5's
  "Narrow panes" already governs, collapsing to one at a time beside another
  pane. It is reached from the line at the foot of the sidebar's tree, which
  says how many sessions are on the machine and how many are not Helm's.

  Three things about it are decisions rather than layout.

  **The list is machine-wide and the detail is Helm's own**, and the pane says
  so with a *heading* rather than a badge. Everything under "Elsewhere on this
  machine" has a different set of knowable facts - no branch, no argv, no
  process tree, no ports, because Helm did not spawn it - and a heading is how a
  list states that once instead of on every row. The degradation needs no
  special case: it is simply what is knowable.

  **Machine data is mono and the sentences are not.** A process name, a pid, a
  port, a path and an argv are all mono at 10.5-11.5px (§2). What a session is
  *called* is a name and is Inter, and the sentences about what Helm could and
  could not see are prose.

  **A tree that could not be read says "Unknown", never nothing.** This is the
  usage figures' rule at a third surface - paint nothing rather than a wrong
  number - and here it has an edge the others do not: the wrong answer is not a
  wrong figure but a *reassuring* one. "This session is holding nothing" and
  "Helm failed to look" render identically as an empty list, and only one of
  them means it is safe to start another agent. So the pane carries a separate
  unknown for the tree and for the ports, because the two queries fail
  independently.

  It also **measures itself, not the window** - the pane-header rule below,
  which is about the box a pane occupies rather than about headers. Measured in
  `sessions-pane-dark.png`: docked beside another pane at the window's
  `minWidth` this pane is 171px, where a `sm:` media query is still true, so the
  fact grid painted "Working directory" and "Branch" side by side in 87px each
  and the path came out as `C:\Users…`. The grid, the strip's age stamp and the
  row's chips are all container queries now, and the row's path keeps a floor of
  8rem so the chips wrap to a line of their own rather than starving the fact
  the row is about.
- **The launch warning.** A folder that already has a live session in it says so
  on the launch row, in `warn`, naming the sessions and saying which of them are
  not Helm's.

  It is a **sentence beside the button, not a dialog in front of it**, and that
  is the launch-disclosure rule (below) rather than a softer version of a
  confirmation. Sharing a working tree is sometimes exactly what somebody means
  to do; a confirmation shown every time is one people learn to dismiss without
  reading, where a warning that is simply true on screen cannot be clicked
  through by habit. `warn` and not `danger`, because nothing has gone wrong -
  this is the attention tone doing what it does on the `waiting` dot.
- **Page bars**: a page's own controls sit in one row directly under the tab
  strip, as tall as the strip, with a hairline below - scope switcher, what is
  being looked at, counts, the page's controls and a refresh (`PaneHeader` for
  the config console, `PAGE_BAR` for history and the
  sessions pane). **No mark and no title**: the tab directly
  above already says "Config", and a second one a row down is what made the
  header read as a card on top of somebody else's pane. It **measures itself,
  not the window**: any of these may be one of two panes, so a `lg:` media
  query is a question about the wrong box, and asking it is how the config
  header came to paint its view switcher 100px past its right edge on a 1280px
  screen. Every threshold is a container query on the bar's own content box.

  As it narrows it drops, in this order: the counts (896), the path (672), then
  the page's own controls move to a **second row** rather than going (560),
  and below 384 the scope switcher stretches to take the row. The switcher and
  the refresh survive every step - a page you cannot re-point or re-read has
  nothing left to do. The wrap point is a decision rather than whatever
  happened to fit: the controls take a full line, everything else is hidden
  before it can wrap.

  What is dropped is what something else on screen already says: the scope
  switcher names the scope the path spells out. Nothing that is *only* here is
  ever dropped.
- **Empty states** (`EmptyState`): the destination's icon in a 36px well, a
  title saying what is empty in 13px/500, one sentence in `fg-subtle`, and the
  way on as a button where there is one. In a detail region it centres; at the
  top of a list it sits where the eye already is. One sentence, not two
  paragraphs: an empty pane is read once and skipped every time after, so it
  says what would fill it and stops. A filter that matched nothing is not an
  empty state - "No match." on its own line is the whole of it.
- **Stat groups**: raised cards, 21px/500 tabular figure over a 10px subtle
  label.
- **Status bar**: plain 11px subtle text directly on the canvas, 26px tall. No
  border and no fill; gaps separate within a group, and a 10px `border-strong`
  hairline separates the groups. On the left, which Helm this is and which
  `claude` it runs: "Helm 1.2.0", then a build that is not an ordinary install
  (a hairline chip: `dev`, `dev · live`, `portable`) and a newer release (an
  offer in `accent` text), a hairline, "claude 2.1.288" - or "claude CLI not
  found" in `warn`. The two versions lead because they are what the bar is read
  for when something is off. After another hairline come your sessions, each
  count with its dot ("2 working", "1 needs you" in `warn`, "2 idle" with the
  idle ring), or "No sessions running". On the right, the plan's usage. The scan
  time is in Settings: it is a fact about Helm nobody acts on.
- **Section labels**: the 10px/600 caps label style, everywhere a section
  needs a name.
- **Launch disclosure**: a control that starts a process gets a sentence
  beside it naming what will run, in 11px `fg-subtle` with the machine parts
  in mono - the program, the working directory, and the argv Helm supplies
  that the user did not type. `ProjectPane`'s "Runs `claude` with this folder
  as the working directory" is the short case. The sentence is not a tooltip
  and not a confirmation: it is on screen *before* the button is pressed, which
  is also what makes a wrong flag visible rather than invisible.

  The launcher's sentence is the long one, and the one that changes as you move:
  it describes the highlighted row, so arrowing to a conversation turns "Runs"
  into "Reopens", and picking a profile names what it composes and every flag
  it adds.
- **The new-session launcher** (Ctrl+N, or the sidebar's `+`): a palette, not a
  page. It is an `Overlay` with `align="top"`, so the field stays put while
  the list under it grows and shrinks, on `surface-raised` with its footer and
  key strip on `surface`. Four decisions in it:

  - **Six folders, then "keep typing".** A launcher is typed into, and a list
    that never scrolls keeps the field, the folders and the footer in one
    glance. With nothing typed it is ordered by when each folder was last
    worked in, with the one in front first.
  - **A folder's conversations sit under it**, indented to its name, and only
    under the highlighted one. A section of its own at the foot of the list
    could be reached only by arrowing through every other folder, each of which
    would take the section over on the way.
  - **A click highlights; it never starts.** Enter, a double click, or the key
    strip's Start does. That is the launch-disclosure rule: the sentence for
    the row has to be on screen before the session runs.
  - **The profile follows the folder until it is chosen**, and the permission
    mode follows the profile until it is. A folder starts with the profile most
    about it: among those naming it as their root or an overlay, the one
    composing the fewest folders.

  Its key strip is buttons that look like hints - the key in mono, the word
  beside it - because the strip is the only place a pointer could start a
  session from.
- **A pane's `+`** (after the last tab of every strip): a new tab in that pane,
  the way a browser's new-tab button works. It is a `Menu` first - Session,
  Profile session, Browser tab - and each choice replaces it in the same place
  under the `+` rather than opening beside it, so there is one popup at a time
  and Escape always means "none of this". Whatever it opens lands in the pane
  whose `+` was pressed, focused or not (`placeIn`), and takes its front.

  - **Session** is the launcher as a popover (`NewSessionPopover`): 340px, the
    popup recipe (`surface-raised`, `border-strong`, `rounded-well`, no shadow),
    hanging from the `+`. It is built for the pointer as Ctrl+N's palette is
    for the keys. Folder and Profile are selects, the folder opening on the one
    the pane is about, or else the one worked in last. Under them are the
    launch sentence and the already-running warning, then **Resume…** (the
    folder's conversations, as a menu) and **Start session**. After a faded
    rule comes **Recent**: the three folders worked in last, each with the
    profile it would start with. The permission mode is the profile's;
    choosing one is what Ctrl+N is for.

    Recent's rows and Resume's are the exception to "a click never starts", and
    they earn it by saying what they run before they run it. A Recent row names
    its folder and its profile, and its hover text is the whole launch sentence.
    A conversation in Resume is reopened in the folder, with the profile, that
    the sentence above it already describes.
  - **Profile session** is the profiles as a menu, pinned first, each with the
    folder it runs in. One click starts it there.
  - **Browser tab** opens an empty page with the caret in its address bar.
- **The restore offer** (after Helm stops without shutting down): a page in a
  tab, not a dialog, opened in front of the focused pane. It is the first thing
  a start after a crash has to say, and somebody may want to look at the rest
  of the window before answering; closing its tab is "not now". One list on
  `surface-raised`, a row per session the crash took - its tab's name, its
  folder and branch in mono, its profile, when it was last spoken to - all
  ticked. A session that cannot come back is still listed, unticked and greyed
  with the reason in place of its folder: one missing from the list would read
  as Helm having forgotten it. The disclosure is one line under the list
  (`claude --resume`, in its own folder and profile, in the tab it had), and the
  primary button counts what it will do.

- **A file tab** (from the Files view or Ctrl+P): read-only, and drawn on the
  pane itself - no well inside the island - because it is read beside the
  session changing it, and VS Code is one click away to change it. A single
  click opens a **preview** tab, its name in italic, which the next single
  click replaces in place; a double click (on the row or the tab) keeps it, as
  Ctrl+P does. With a session in front of the focused pane the file opens in
  the **other** pane, opening one if there is only one, so the two sit side by
  side. The tab's name is mono 11.5px. The strip ends with **Open in VS Code**
  as a secondary button - disabled and saying why where VS Code is not
  installed - then Explorer and copy-path icons, then the pane's own controls.
  The crumb is the path inside the project in mono, the folders giving way
  before the name, and at the right how the file stands against the last
  commit in `accent-text` beside a 2px accent bar ("2 lines changed since the
  last commit", short form "2 changed" below 520px of crumb). The lines that
  differ are marked the way a selected row is: a 2px accent edge where the
  gutter meets the code, `accent-soft` behind the line, the number in
  `accent-text`; a removal is a short accent tick across the line boundary. A
  24px status line at the foot: caret position, language, line endings, Wrap
  (`filesWrap`, so it holds for the next file), and "Read only". A file that is
  gone, binary or past the size ceiling is a centred notice with VS Code and
  Explorer as the way on, never an empty pane.

  **A note or an HTML artifact opens rendered.** The crumb ends in a small
  segmented switch - **Preview**, **Source**, and for markdown **Edit** - held
  per file. Preview is the note as a page (frontmatter as chips in a row above
  it, only when there is some) or the artifact in its sandboxed frame; Source
  is the plain file view above, git marks and all; Edit is the editor beside a
  live preview, with Save and Revert in the status line - the one place the
  Files view writes, through the snapshotted `content:write`. Entering Edit
  keeps a preview tab. A tab with a draft not on disk shows a dot where its
  close button sits, and the draft outlives the tab going behind another - or
  closing: opening the file again brings it back, marked unsaved. HTML has no
  Edit: an artifact is generated, and its editor is whatever generated it.
- **Ctrl+P** is the launcher's palette shape: field across the top, rows of
  34px - page icon, the file name, its folder in mono `fg-subtle` - with the
  letters that matched in `accent-text`, the files opened lately before
  anything is typed, and a key strip at the foot saying how many files were
  searched and where the list came from. A **Names / Text** switch sits at the
  field's right; **Ctrl+Shift+F** opens it on Text, which searches what the
  files say: each file's name once, then its matching lines as 28px rows - the
  line number in mono, the line with the match in `accent-text` at 500. A row
  opens the file on that line, the words selected in source and marked in a
  rendered note. The last answer stays on screen while the next is asked.

## 5b. Shell chrome

- **The frame**, left to right: the **rail** on the canvas, 2px, the
  **sidebar** island (256px), a gutter, then the **panes**, and a gutter
  to the window's edge. The title strip above it all, the status bar below.
- **Title bar**: the native bar is hidden on Windows; Helm draws its own 36px
  strip - the accent mark alone, centred over the rail at the rail's icon size
  so the two read as one column, and the drag region - and the Window Controls
  Overlay paints the
  min/max/close buttons in the theme's `bg` and `fg-muted` (`main/chrome.ts`),
  retinted on every theme change. Nothing else lives in it: the theme toggle
  went to Appearance, and Settings to the rail.
- **The rail**: 48px of 40px icon buttons on the canvas, `rounded-well`, each
  a 20px glyph (`RAIL_ICON`) drawn with a stroke thinned to keep the 1.6px line
  of the rest of the chrome - bigger, not bolder. Ordered by how often each is
  reached for rather than by feature - Sessions,
  Profiles and session history, a hairline, then Files, the browser and
  Config, and Settings pinned to the foot. The order is a fact
  about how Helm is used, so it is fixed rather than learned: a rail that
  reordered itself would move under muscle memory.

  **A right-click lists every destination with a tick** (a `Menu`), as VS
  Code's activity bar does; unticking one takes it off the rail
  (`railHidden`), and a group left empty takes its hairline with it. Settings
  is listed ticked and disabled: it is where the rest come back from, and the
  setting's validator refuses it outright. Hiding is not disabling - Ctrl+P,
  Ctrl+N and every other way in still work.

  An item is one of two kinds and says "here" differently. A **view** swaps
  what the sidebar shows - Sessions, Profiles, Files, Settings - and is current
  with `hover` fill and the 2px accent edge a selected sidebar row wears, in the
  rail's own margin; pressed again, it puts the sidebar away. A **page** opens
  a tab in the focused pane and is current, with the fill alone, while that tab
  is in front.

  **The rail starts a piece of work; a tab carries it on.** Clicking a tab
  brings back the view it belongs to, opened if the sidebar was put away and
  pointed at the tab's own row: a session's or a project page's tab brings
  Sessions with its row unfolded and scrolled to, a file's tab brings Files on
  its project with every folder down to it open, and Settings' tab brings its
  sections. A tab with its list inside it - History, Config -
  or none at all (Browser) leaves the sidebar alone. Only a click on a tab does
  this: focus moving between two panes does not, or a session beside a file
  would flip the sidebar on every click across. A maximized pane keeps the
  window, and the view still switches for when it is given back.

  **Settings is a view with a page.** The sidebar lists its sections (General,
  Appearance, Terminal, Sessions, Workspace, Files, Browser, Archive,
  Updates) as sidebar rows, and the pane shows the one picked - a 17px title,
  then its groups. A section that is one group is that group: the title is
  the page's and its hint is the line under it, with no caps heading of its
  own. Opening Settings from anywhere opens both.
  The rail sits outside the sidebar's `aside` on purpose: it is a column of
  titled buttons, and inside the `aside` every "first project row" selector
  would land on it.
- **Panes**: islands split any way across the window, as VS Code splits its
  editors - side by side, one above the other, and either inside the other -
  each a tab strip, a crumb row for a session's or a file's tab, and its body.
  Any tab may sit in any pane - a session beside a session, a session beside
  the project page it came from, history under both - which is what a pane is
  for. There is no count of them; a pane is not split below 200 by 140px, and
  that is what stops it. A pane is named by its place in reading order, left to
  right and top to bottom: "First pane", "Second pane". A new tab opens in the **focused**
  pane, the one last pressed anywhere inside (taken in capture, so a terminal,
  a list or the strip all count). A session's terminal fills the body edge to
  edge on its own ground, and a page is drawn on the pane's own surface (§3,
  "A page draws no island at all").

  A strip with more tabs than fit scrolls sideways under the wheel, and its
  only sign of that is a 4px thumb along its foot with no arrow buttons -
  Windows' `thin` scrollbar took 10px of a 36px strip and painted arrows into
  the first and last tab.

  **A tab is split off by dragging it onto a pane.** Over a pane, below its
  strip, the pane is read in VS Code's thirds: within a third of a side is that
  side, the nearest at a corner, and the middle is the rest. A side opens a new
  pane there taking half of this one; the middle moves the tab in, as dropping
  it on the strip does. The **preview** is the part of the pane the tab would
  take - drawn over the whole pane, strip included, `accent-soft` inside a 1px
  accent edge at the island's corner, sliding between zones in 100ms - and it
  is drawn only where the drop would do something: not the middle of the
  tab's own pane, not a side of a pane whose only tab it is, and not a side of
  a pane too small to halve, where the pointer means the middle instead. A
  browser page is a native view over all of this, so it is off the screen for
  the length of the drag, with a still of itself in its place.

  Every divider is the gutter it sits in, with a 3px `border-strong` grip that
  goes accent on hover - upright between panes side by side, on its side
  between panes stacked. Dragging one moves only the two panes either side of
  it, neither below its minimum; double-clicking shares its split evenly. The
  shares are part of the saved layout, written once when the drag ends.
  A **`+`** follows the last tab (§5, "A pane's `+`"). The tabs scroll in a box
  that grows to fit them and no wider, and the `+` sits after that box rather
  than inside it, so it stays in view when the strip scrolls.
  Each strip ends in the pane's own controls: **split** (send the front tab to
  a pane of its own on the right, or to the pane beside this one; Ctrl+\\),
  **maximize** (this pane takes the window, sidebar and all; again to give it
  back; a tab dropped at its side gives the window back too, so the new pane
  can be seen), and, while there is more than one pane, **close**, which hands
  its tabs to the pane that takes its room rather than closing them - a layout
  button that ended sessions would be a destructive control in disguise.
- **Project shell**: a project page carries a plain shell (PowerShell, cwd at
  the project) as a terminal island below it. It is furniture, not a session:
  no row, no history, no notification. Each page owns its shell and its
  handle, so two projects' pages in two panes are two shells.

  **A third of the page is where its height starts, not what it is.** The
  proportion is the default and the argument for it is a row count: about a
  third gives a tall display the 15 rows PSReadLine needs before it will draw
  its ListView, while a small window keeps most of its height for the project
  pane. What that never justified was being the only value, so the gutter
  between the two carries a **drag handle** - the split view's divider recipe
  rotated, a 3px `border-strong` grip that goes accent on hover, in a full-width
  row as tall as the gutter with an 8px target. Dragging moves the shell's top edge,
  double-clicking returns it to the default.

  It is bounded at both ends and the two bounds are different in kind. The
  ceiling is **half the column**, so the project pane is never the smaller part
  of the page it names. The floor is **180px**, a pixel figure rather than a
  percentage because "still enough rows to be a terminal" is not something a
  percentage can say - the same 12% is a working shell on one monitor and four
  lines on another. Where a window is short enough that the two disagree, the
  floor wins. There is no pixel *ceiling*: a fixed one is what made a tall
  monitor useless, the extra height going to a project pane with nothing more
  to say.

  The height is **one setting for every project** (`projectShellHeightPct`),
  because the question it answers - how much terminal do I want - is about the
  person and their monitor, not the repository. Per-project heights would also
  mean the page's proportions moved as you moved between projects.
- **Every drag surface, and what a move must carry.** A gesture that tracks the
  pointer over time is only a drag while a button is held, and a handler that
  does not check `buttons` will follow a pointer that is merely passing over it.
  That is not hypothetical: the session divider did exactly that, and because it
  did, no drag in Helm had ever been exercised by a check - the drivers were
  sending `sendInputEvent` moves with no `leftbuttondown`, Chromium was
  delivering them as `buttons: 0`, and the divider was answering them. The
  arrangement looked correct from both ends for as long as it existed. The
  complete list:

  | surface | how it tracks | requires the button |
  |---|---|---|
  | pane dividers | `mousemove` on `window` | yes - `buttons === 0` ends the drag, and writes where it ended |
  | project shell handle | `setPointerCapture` | yes - capture, and `hasPointerCapture` gates each move |
  | tab reorder, and a tab onto another pane or a pane's side | HTML5 `dragstart`/`drop` | n/a - the platform owns the gesture; the drag ends at the window's `drop`, because the tab's own `dragend` is lost when its strip goes with it |
  | profile list reorder | HTML5 `dragstart`/`drop` | n/a |
  | terminal text selection | xterm's own handlers | n/a - not Helm's code |

  The pointer-capture form is the better one and the divider is the older one;
  capture also fixes the case a `buttons` check only mitigates, which is a
  release *outside the window* that delivers no `mouseup` at all. A new handle
  takes capture. The HTML5 rows are a different event family that
  `sendInputEvent` cannot produce at all, which is worth knowing before writing
  a check for one.

  A driver drives these with **`drag()`** (`main/bridge.ts`), which holds the
  button, and counts what was delivered with `tracePointer` - so "the app
  ignored it" and "it never arrived" stop being the same red line. `SESS-15`
  and `S-21` both assert `buttons: 1` for exactly that reason.
- **Narrow panes**: the config console and the session
  history are both a bounded list beside a detail, and that needs roughly 700px
  before both are readable. In one of two panes none of them get it, so each
  collapses to **one at a time**: the list until something is
  picked, then the detail alone with a `‹ Back` row above it (`PaneBack`).
  Clearing the selection is what puts the list back, so the back row and the
  pane's own empty state stay the same thing. At full width both show and
  nothing swaps - a click saved is not worth a layout that moves. The strip
  above them degrades on its own schedule and by its own measurements - see
  **Page bars** - because the divider is bounded at 20% of the row, which is
  a pane of about 195px on a 1280px screen and 119px on the narrowest window
  the app will open.
- **Sidebar**: one island, 256px, showing the view the rail chose. A 38px
  header names it in 12.5px/500 and carries its few actions as 26px icon
  buttons; the view fills the rest. Three views so far:

  **Sessions** is the tree, and the window is sessions first because the day
  is. A filter field ("Filter projects and sessions") over **Pinned**, then the
  harness groups, then **Elsewhere**. Every project is one line; a project with
  sessions in it opens out to show them beneath it, and folds to one line with
  the most pressing session's dot beside its name. A filter matches a project
  by its name, its path or the name of anything running in it, and opens every
  group it matched. The header's actions are rescan, new harness and add a
  folder; the foot of the island is one line naming how many sessions are on
  this machine and how many are not Helm's, which opens the sessions pane.

  **Files** is one project's tree. The header carries the project beside its
  title - a 22px outlined pill naming it, over the platform's own list - and
  Explorer and VS Code for the whole project as its actions. The project
  follows the pane in front (a session's folder, a file's project) until the
  pill picks another. Under the header, a **Go to file** field that is a
  button: it opens Ctrl+P. Rows are 24px - caret for a folder, the page icon
  for a file, the name - and git's short letter at the right in mono 10.5px
  (`M` in `warn`, `U` and `A` in `success`, `D` and `!` in `danger`, `R` in
  `accent-text`); a folder holding a change wears a 5px `warn` dot there
  instead. Under the pointer or the keyboard, the letter's slot shows the row's
  hand-offs - VS Code, Explorer, copy the path - as 20px icon buttons. The file
  in front of the focused pane wears the selected-row recipe. Ignored folders
  are listed greyed and never opened; `.git` is not listed. A project git could
  not be asked about says so on the island's foot in `warn`, and one outside any
  repository says it has no changes to mark - neither is drawn as clean.

  **Profiles** is the profile list, with Import and New in the header. It is
  only mounted while it is the view.

  A harness group's header is a caret, the name in the caps label style but at
  `fg`, the project count, the template it was built from in mono where the
  manifest names one, and a running-session count at the right in
  `accent-text`. Groups are separated by an `.island-rule`, never a border.

  **Pinned** sits above the first group and holds the projects somebody lifted
  out of their harnesses. It folds away like a group - the same caret in the
  same column, its projects indented as a group's are - and is otherwise
  deliberately *not* shaped like one: its label is the 10px caption with a pin
  before it, at `fg-subtle` where a group header sits at `fg`.
  **Only projects are pinnable** - a pinned harness would be very nearly the
  collapse state the group already has. Pins are flat and cross-harness, so a
  pinned project appears **once**, in the section and never also in its group,
  and the section sorts by name, since path order is harness order and that is
  the arrangement being escaped.

  **Elsewhere** holds Helm's sessions whose folder is no project the scan
  found, so every session Helm hosts has a row somewhere.

  **Config, Content and the rest are destinations on the rail, not rows here.**
  Each of those panes owns a scope switcher, so its way in carries none. They
  were per-harness links once, which made a pane reachable only through a
  harness that happened to be expanded; a destination a collapsed group can
  hide is a destination that can be lost. A **project page may still link to
  both, scoped to itself**: what a link from a project adds is the scope, and it
  is a **secondary button** at the far end of the page's action row carrying
  the rail's icon for its destination, so the two read as one object.
- **Project rows in the tree**: one line - caret (only where there are sessions
  to show), kind icon, name, and the branch in mono `fg-subtle` at the right,
  where it gives way first. Under the pointer the branch's slot shows a terminal button
  (start a session here, no page in between) and the star, by the rules in §5.
  The row's own click opens the project's page. The icon stays because harness
  / repo / plain folder is the one thing a name and a branch cannot say; the
  rest of what git knows is on the page.

  A pinned row whose folder is no longer there keeps its place and says so, in
  `SessionHistory`'s own words - the **`folder gone`** badge, the hairline
  outline pill. It is **not a button**: a pin is a deliberate act and an
  unplugged drive is not a decision to un-pin, but a row that offered a launch
  which would fail is worse than a row that says why it cannot. Its star is the
  one thing left to do to it, so that one is shown outright.
- **Session rows in the tree**: indented under their project to start beneath
  its name - the state dot, the session's name, and one short word at the right
  in 11px: "needs you" in `warn`, how long it has been working ("4m"), "idle",
  "ended". The session in front of the focused pane wears the selected-row
  recipe with its accent edge, the ones in front of the other panes the
  `hover` fill - the same split the panes' tab strips make - so the tree and the
  panes agree about what you are looking at. Pressing one brings its tab
  forward wherever it is.

  A session somebody started outside Helm is listed under its folder too, its
  dot dimmed and its word "outside Helm", because it holds a working tree
  exactly as hard as one of Helm's does - the reason the listing is
  machine-wide. It has no tab, so it opens the sessions pane on itself.

## 5c. Plugin surfaces

A plugin draws inside places Helm already has and never brings chrome of its
own. **Helm draws the frame, the plugin draws the page**: the rail icon, the
panel's header, the tab, the status bar item, the palette row and every error
state are Helm's components, and the plugin's page fills the body of one of
them. That is what keeps a plugin looking like part of the window rather than
a website inside it.

- **The rail**: a plugin with a rail icon gets a group of its own under a
  hairline, after Helm's destinations and above Settings. Its icon is a mask,
  so it takes the rail's colours, at the rail's 20px, and it hides from the
  rail's menu like any other item. It is a **view**: it opens the plugin's
  panel in the sidebar.
- **The rail badge** is a count, never an alert: a 15px pill at the icon's top
  right, an `accent` hairline on `bg` with the number in 9.5px/500
  `accent-text` tabular numerals, "99+" past 99, and absent at zero. The count
  is part of the button's accessible name ("Sample, 2"). Never filled - the
  accent does not flood for a plugin either.
- **A panel** is the sidebar island with the plugin's page as its body. The
  38px header is Helm's: the panel's title and up to five actions as the
  standard 26px icon buttons. An action's glyph is named in the manifest from
  Helm's own set (refresh, plus, search, list, settings, external, pin, edit,
  trash, link, eye), so a plugin cannot draw a header that looks unlike every
  other one.
- **A tab** is a tab like any other: one line, the plugin's icon, the title the
  page sets. The page fills the pane's body edge to edge, as a page does.
- **A status bar item** is one plugin's single line of caption, in one of five
  tones (`neutral` in `fg-subtle`, `accent` in `accent-text`, `success`,
  `warn`, `danger`), at most 220px and truncated past it, before Helm's own
  items with a divider after the last. Pressing it opens the plugin's panel.
- **Ctrl+Shift+P** runs a plugin's commands, drawn as Quick Open is so the two
  read as one family: a 560px raised palette, the field across the top with the
  command glyph in `accent`, 34px rows of icon, title and - right, in
  `fg-subtle` - the plugin it belongs to, the chosen row with the selected-row
  tint and 2px bar, and a key strip at the foot.
- **A failure says so in the plugin's own place**, never as a toast or a
  dialog. The surface becomes an `EmptyState` on `surface`: the warn glyph,
  "*Plugin* stopped" (its process ended) or "*Plugin* did not load" (it never
  answered), Helm's sentence under it, and **Reload** and **Plugin settings**.
  Every surface of one plugin shares a process, so a crash shows on all of
  them at once. The rest of the window is untouched.
- **Settings > Plugins** lists every folder added: name, version in mono, the
  folder in mono `fg-subtle`, and a state chip in outline - "Not loaded" in
  `danger`, "Off" neutral. Each plugin is a page of its own in Settings'
  sidebar: what went wrong first as a verdict (an unsupported `apiVersion` is
  said by name there), then its settings form drawn from the manifest's
  schema with Settings' own rows, the secrets it uses, the hosts it may reach
  and the programs and service it runs - all three in mono, because the user
  is being told exactly what this plugin can do - memory and CPU, its log
  (Helm's own notes in `fg-subtle`, the plugin's lines in `fg`), and turn off,
  reload and remove. **Settings > Secrets** lists every secret by key, with its
  hosts and plugins, and never its value.
- **The secret dialog** is a modal (`Overlay`): the key glyph, "*Plugin* needs
  *key*", a password field, the hosts the value may go to and the plugins that
  may use it, with the asking plugin and its hosts ticked, then Save. It is the
  only way a value gets in, and the value never comes back out to any page.

**The primitives.** Every plugin page gets `/__helm/helm.css`, linked before
its own styles. The theme arrives as CSS variables on `<html>` - the nineteen
roles as `--helm-<role>` (`--helm-surface`, `--helm-fg-muted`,
`--helm-accent-soft`, ...), `--helm-radius`, `data-density` and `data-theme`
for light and dark - and is rewritten in place when the theme changes, so a
page never reloads for it. The classes are Helm's controls by another name:

| class | is |
|---|---|
| `.helm-button` | the 28px secondary button; `data-variant="primary"` is the accent outline with `accent-text`, never a fill; `ghost`, `danger` |
| `.helm-icon-button` | a 24px icon button; `aria-pressed="true"` for a toggle that is on |
| `.helm-input`, `.helm-select`, `.helm-textarea` | the field well; `aria-invalid="true"` for a field in error |
| `.helm-list`, `.helm-row` | a list and its rows at the density's height; `aria-selected` or `aria-current` is the selected row's `accent-soft` and 2px bar |
| `.helm-chip`, `.helm-state`, `.helm-dot` | a chip carried by its tone alone, a state in a hairline outline of its tone, a 6px status dot; `data-tone` picks the tone |
| `.helm-tag` | a label pill in outline; `data-tone="accent"` is `accent-soft` behind `accent-text` |
| `.helm-bar`, `.helm-rule` | a page's bar of controls over a hairline, a divider that fades at its ends |
| `.helm-caps`, `.helm-meta`, `.helm-mono` | the caps label, secondary text, machine data |
| `.helm-empty` | the empty state, with `-icon`, `-title`, `-text` and `-actions` |

They live in the CSS layer `helm`, ordered `theme, base, helm, components,
utilities`, so a plugin's own unlayered CSS beats them and a Tailwind page's
utilities do too. A plugin may style itself however it likes; the primitives
are how it looks like Helm without trying, and every rule in this file -
no solid accent fills, no shadows, no weight past 500, mono for machine data -
is already in them.

**Keys.** A Helm shortcut pressed inside a plugin page is forwarded to Helm if
the page did not handle it: Ctrl, Alt or Meta with a key, except the editing
keys (copy, paste, select all, undo) and AltGr. Ctrl+N and Ctrl+Shift+P work
with focus anywhere.

## 6. Foreign-ground islands

Two islands host content Helm does not own: the terminal and the embedded
document/artifact viewer. The rule: **the island's chrome is themed; the
content's ground is its own, fixed in every theme.** A plugin page is not
foreign ground: it is drawn in the theme's tokens and follows them live (§5c).

- The terminal keeps `#11121A` (`bg-terminal`) in every theme - load-bearing
  for Spike C's color checks. It fills a pane's body edge to edge under the
  themed strip and crumb, so the seam between the two is the pane's own
  hairline rather than a tab lifting into the terminal.
- The **palette** is fixed too, and that is a decision rather than an omission:
  the 24-bit `THEME` in `renderer/terminal.ts` is asserted pixel-for-pixel by
  the fidelity checks, so terminal colours are deliberately not a setting.
  What *is* settable is everything that is not colour - font, size,
  cursor, scrollback - and the settings pane's preview well paints those on
  this same fixed ground, in every theme, so the preview is the pane. A
  theme cannot carry terminal colours for the same reason.
- A **shell pane's header** is themed chrome on that fixed ground: the caps
  label, the running executable in mono at `#9397ab`, and a select in the
  standard shape. Foreign ground governs the content, not the furniture
  around it.
- A rendered document or artifact paints whatever ground it declares; never
  invert it, never theme it.
- The hairline edge and the island radius are what make a foreign surface
  belong; the sandbox strip marks the seam.

## 7. Do / Don't

Do:

- One island per pane; nothing bare on the canvas but the rail and the status bar
- Accent as 2px marks, outlines and text - selection tint is accent-soft
- Mono for machine data: paths, branches, hashes, costs, sizes
- Two-line rows in a pane's list: name above, chips below, counts pinned right
- One line per project and per session in the sidebar tree, so a session sits
  right under the project it runs in
- One line per tab; what told tabs apart on a second line is on the crumb row
- Fade long dividers to transparent at their ends (`.island-rule`)
- Tabular numerals everywhere a number can change

Don't:

- No solid accent fills - not on buttons, not on selections (checkboxes are
  the one exception)
- No stacked shadows; elevation is edge + ambient darkness (modals excepted)
- No hand-written backdrop - a modal is `Overlay`, and `no-raw-overlay` says so
- No pure black or white; every value from the ramps
- No text weight past 500 (600 only on ≤11px caps labels)
- No borders on chips at row density - tone carries them
- No solid status badges - a state chip is a hairline outline in its tone, not
  a filled badge
- No theming foreign grounds - terminal and embedded documents keep their own
- No raw hex in components; tokens only
- No literal radius or gutter (`rounded-[5px]`, `gap-2` between islands) -
  the shape settings cannot reach a number written at the call site
