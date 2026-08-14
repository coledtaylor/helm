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

**One island per pane, and a pane with sections is still one island.** A header,
a body and a footer that belong to the same subject are separated by
`.island-rule`s inside a single surface, not floated as three islands with 8px
gutters between them: the gutters buy nothing, cost two of them out of the
reading width, and make the header read as a summary card sitting above some
other pane's contents. The pull request tab is the worked example - header, view,
review row - and it was three islands before this rule was written down.

Three elevations, encoded as radius tokens:

- `rounded-island` (10px) - panes on the canvas
- `rounded-raised` (8px) - stat cards, code wells, list boxes *inside* an island (`bg-surface-raised`)
- `rounded-well` (7px) - inputs, filter fields, buttons, row hovers (`bg-surface-sunken` for inputs)
- `rounded-full` - pills and tags

**No stacked shadows.** Elevation is an edge plus the darker canvas behind
it. The one exception is modals: `rounded-xl border-border-strong
shadow-panel` over a dimmed backdrop.

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

Both are asserted for every control the walk can reach by `pnpm
affordance-check`, which puts a real pointer on each one in turn. The failure
that check exists for is not a control someone forgot: Tailwind v4 gates
`hover:` behind `@media (hover: hover)`, and on a machine reporting no fine
pointer that killed **every** hover state in the app at once, silently, with the
tokens resolving and the classes present. `theme.css` overrides the gate.

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
  `bg-surface-raised ring-1 ring-border-strong` at `rounded-[5px]`. For a
  choice of two to four; past that it is a select.

  The chosen segment hovers to `bg-active`, not to `bg-hover` like everything
  else, and this is the one place the ramp is skipped deliberately: the segment
  rests on `surface-raised`, and `hover` sits six points from it across the
  whole channel in dark mode. `active` is one clear step above where the segment
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

  **A select always carries a real fill - never `bg-transparent`.** Its
  dropped-open list is an OS window rather than part of the page, and the only
  things CSS reaches into it are the control's own `background-color` and
  `color`. A transparent control therefore drops the platform's white listbox
  into a dark app, with the page's text colour still applied to the rows - the
  shell picker shipped that way and its options were `#75798c` on white.
  Measured on Electron 43: `color-scheme` on the element and `option` /
  `option:checked` rules change nothing, so the fill is the whole lever. What
  stays platform-drawn is the **highlighted row**, which keeps the Windows
  selection colour; that is the accepted price of a native select, and the
  alternative - a listbox of our own - is refused above for a better reason.
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
- **State chip**: one pill saying what something *is* rather than what it has -
  a pull request's open/draft/merged/closed. A hairline outline in a semantic
  tone at 40% alpha with the tone's own text colour, never a fill. This is the
  one pill that is allowed a coloured border, because it is the only place a
  single word carries the whole status of the thing on screen; everything else
  at that density stays borderless.

  GitHub paints these as solid green, grey, purple and red badges, and Helm
  does not, for the reason the accent never floods: a filled badge is the
  loudest object on the pane and a pull request's state is not the loudest fact
  about it. The mapping `PullRequestPane` uses:

  | state | tone | why |
  | --- | --- | --- |
  | open | `success` | the live one - the state anything can still be done to |
  | draft | `border-strong` / `fg-muted` | not yet a claim about anything, so no tone at all |
  | merged | `accent` (`accent-text`) | the outcome the app treats as the accent moment |
  | closed | `danger` | the one negative outcome, and the only one |

  Draft is checked *after* the closed states: a draft that was closed is
  closed, and GitHub leaves the draft flag set on it.

  **The second user is the config console's live state** (`ConfigLive`), and it
  is the same rule with a different vocabulary: whether a file in a `.claude`
  tree reaches a session. Live is `success`, outranked or partly outranked is
  `warn`, and read-but-empty or not-in-this-resolution take no tone at all -
  neither is a problem, so neither gets a colour.

  It adds one thing the pull request's states do not need: **a state that paints
  nothing**. Helm has no claim to make about most of what sits in a `.claude`
  directory - a `rules/` file is a convention some instruction file may
  reference, and nothing in the resolution can see that reference - so those get
  no chip and no dot rather than a confident grey "not loaded". Same rule as the
  usage figures: paint nothing rather than a wrong number.

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
  about the thing on it is inside it, one click away, on a pane with room to
  say it. `PullRow` states this at its own call site and it is the rule for
  every list here. A row with three glyphs down its right edge is a row whose
  own click target is a guess, and it puts the rare actions in front of the
  common one.

  **The exception is a control that changes which list the row is in**, and it
  is an exception rather than a loophole because such a control is not one of
  the row's actions at all - it is an action on the *list*, and the row is
  simply where the user is pointing when they decide. Two of them exist: a
  profile's pin, and a project's. Both wear the same rules:

  - **Hidden at rest, revealed by `group-hover` on the row** (and by
    `focus-visible`, so it is reachable from the keyboard). A tree of a dozen
    rows still reads as a column of names.
  - **Revealed by opacity, never by mounting.** A control that only exists in
    the DOM under the pointer is one no keyboard reaches and one
    `affordance-check` cannot enumerate - its walk skips `display:none` and
    `visibility:hidden`, so such a control would be measured by nothing and
    reported by nothing, which is the coverage gap AFF-2 exists to name.
  - **Its space is reserved, not borrowed.** The row holds the gutter open
    whether or not the control is showing, so nothing on the row moves when it
    appears and it never floats over the second line's machine data - the half
    somebody is reading at exactly the moment they point at it.
  - It carries **no `title`**. `aside nav button[title]` is how every driver
    and `design-shot` finds "a project row", and a second titled button inside
    the row makes that selector a coin flip. `aria-label` says what it does.
- **Source pills**: a list that draws rows from more than one place carries the
  place on the row, as a hairline `border-strong` pill at the head of the second
  line - the repository on a pull request row is the one so far. This is the one
  outlined pill allowed at row density, and it earns the exception by not being
  one of the row's facts: everything else on that line is *about* the pull
  request, and this says which list it came out of. It appears only where the
  rows have been flattened out of their groups; under a heading that already
  names the source it would be the heading said twice.
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
- **Folder tabs**: the active tab lifts into the pane island below it - same
  fill, hairline border on three sides, `rounded-t-[9px]`, `-mb-px` overlap,
  `z-10`. Inactive tabs are bare text (`fg-muted`). A session tab lifts into
  the terminal ground instead (see below). A strip with no tabs and no
  trailing actions is **not drawn**: its 40px belong to tabs, and holding them
  open on the welcome screen pushes the pane island below the top edge of the
  sidebar island beside it.
- **Pane headers**: a scoped console wears one island strip - mark, title,
  scope switcher, what is being looked at, and a refresh (`PaneHeader`, used by
  the config console and the content viewer). It **measures itself, not the
  window**: these panes are the workspace half of a split, so a `lg:` media
  query is a question about the wrong box, and asking it is how the config
  header came to paint its view switcher 100px past the island's right edge on
  a 1280px screen. Every threshold is a container query on the header's own
  content box.

  As it narrows it drops, in this order: the counts (896), the path (672), then
  the pane's own controls move to a **second row** rather than going (560),
  then the title (384), then the mark (240). The scope switcher and the refresh
  survive every step - a pane you cannot re-point or re-read has nothing left
  to do - and the switcher gives up its width last, stretching to fill the row
  only once the title has gone. The height follows the rows (`min-h-11`), and
  the wrap point is a decision rather than whatever happened to fit: the
  controls take a full line, everything else is hidden before it can wrap.

  What is dropped is what something else on screen already says: the tab above
  the header carries the title, and the scope switcher names the scope the path
  spells out. Nothing that is *only* here is ever dropped.
- **Stat groups**: raised cards, 21px/500 tabular figure over a 10px subtle
  label.
- **Status bar**: plain 10.5px subtle text directly on the canvas, segments
  separated by 1px x 10px `border-strong` slivers. No border, no fill.
- **Section labels**: the 10px/600 caps label style, everywhere a section
  needs a name.
- **Launch disclosure**: a control that starts a process gets a sentence
  beside it naming what will run, in 11px `fg-subtle` with the machine parts
  in mono - the program, the working directory, and the argv Helm supplies
  that the user did not type. `ProjectPane`'s "Runs `claude` with this folder
  as the working directory" is the short case; the pull request pane's review
  row is the long one, and it names the exact opening prompt because there
  the argv is composed from a template the user can get wrong. Written down
  once there were two of them. The sentence is not a tooltip and not a
  confirmation: it is on screen *before* the button is pressed, which is also
  what makes a mistyped placeholder visible rather than invisible.

## 5b. Shell chrome

- **Title bar**: the native bar is hidden on Windows; Helm draws its own
  brand strip (the accent mark alone - no wordmark, since it named the app to
  someone already looking at it - the drag region, the theme toggle) and
  the Window Controls Overlay paints the min/max/close buttons in canvas
  colours (`main/chrome.ts`). The overlay is retinted on every theme change.
- **Split view**: sessions never share the workspace strip. They dock as a
  resizable split on the right with their own folder-tab row; the divider is
  a 3px `border-strong` grip that goes accent on hover, drag-bounded 20-80%.
  Each strip ends in a ⤢/⇱ maximize toggle.
- **Project shell**: a project pane carries a plain shell (PowerShell, cwd at
  the project) as a terminal island below it. It is furniture, not a session:
  no row, no history, no notification. It stays on screen while the session
  split is open - the session has its own column and takes nothing from the
  project's, and dropping the shell took a second terminal away at the moment
  one is most useful.

  **A third of the page is where its height starts, not what it is.** The
  proportion is the default and the argument for it is a row count: about a
  third gives a tall display the 15 rows PSReadLine needs before it will draw
  its ListView, while a small window keeps most of its height for the project
  pane. What that never justified was being the only value, so the gutter
  between the two carries a **drag handle** - the split view's divider recipe
  rotated, a 3px `border-strong` grip that goes accent on hover, in a full-width
  8px row that is the whole target. Dragging moves the shell's top edge,
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
  | session split divider | `mousemove` on `window` | yes - `buttons === 0` ends the drag |
  | project shell handle | `setPointerCapture` | yes - capture, and `hasPointerCapture` gates each move |
  | workspace tab reorder | HTML5 `dragstart`/`drop` | n/a - the platform owns the gesture |
  | session tab reorder | HTML5 `dragstart`/`drop` | n/a |
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
- **Narrow panes**: the config console, the content viewer and the session
  history are all a bounded list beside a detail, and that needs roughly 700px
  before both are readable. Docked next to the session split none of them get
  it, so each collapses to **one at a time**: the list until something is
  picked, then the detail alone with a `‹ Back` row above it (`PaneBack`).
  Clearing the selection is what puts the list back, so the back row and the
  pane's own empty state stay the same thing. At full width both show and
  nothing swaps - a click saved is not worth a layout that moves. The strip
  above them degrades on its own schedule and by its own measurements - see
  **Pane headers** - because the divider is bounded at 20% of the row, which is
  a pane of about 195px on a 1280px screen and 119px on the narrowest window
  the app will open.
- **Sidebar**: four global rows (session history, pull requests, Config,
  Content), then profiles, then **Pinned**, then the harness tree. A harness is a collapsible
  group - caret, name in the caps label style but at `fg`, project count, and a
  running-session count at the right in `accent-text`. Groups are separated by
  an `.island-rule`, never a border. The global rows share one shape - icon,
  name, optional second line - and two of them have a fact worth putting on
  that second line: session history's counts, and how many pull requests are
  open. The pull-request row's second line is also where its **degradation**
  goes, in a short form ("Run gh auth login") rather than the pane's full
  sentence - a 280px rail truncates an instruction into nonsense, and a label
  that sends you to the pane to read it does not. Config and Content stay
  single-line and the group still reads as one list. **Config and Content are
  global, not scoped**: each
  pane owns a scope switcher, so its entry point does not need to carry one.
  They were per-harness links, which made a pane reachable only through a
  harness that happened to be expanded and forced a second unscoped copy to
  stand under an empty tree; a destination that can be hidden by a collapsed
  group is a destination that can be lost.

  A **project pane may still link to both, scoped to itself**, and that is not
  a reversal of the paragraph above. What was wrong with the per-harness links
  was that they were the *only* way in; the sidebar rows are, and stay, the way
  in. What a link from a project adds is the scope - arriving at the pane
  already pointed at the project that was on screen instead of picking it out
  of a switcher. Such a link is a **secondary button** at the far end of the
  pane's action row, carrying the sidebar's own icon for its destination so the
  two read as one object.

  It was a ghost first, on the reasoning that four outlined controls in a row
  read as a toolbar. That was the wrong trade, and the correction is worth
  writing down because the same reasoning will come back: dropped at the end of
  a row of prose, a ghost is two words that happen to react if you find them. A
  ghost works in the title bar, where it sits in a strip of nothing but
  controls. What separates a navigation control from an action here is the
  **gap** - `ml-auto` puts them at the far end - and the accent outline the
  primary button still has to itself. Weight was being asked to carry a
  distinction position already carried.

  The original argument for the outline was that *nothing in this app had a
  pointer cursor*, so a control's shape was its whole claim to being one. That
  premise is gone - every control now takes the pointer (§4, "Affordance") -
  and the conclusion survives it anyway, on the sentence above rather than on
  the cursor. Worth recording, because the cursor was doing more of the
  argument's work than it should have been.
  The **Pinned** section sits inside the same scroller, above the first group,
  and holds the projects somebody lifted out of their harnesses. It is
  deliberately *not* shaped like a harness group: no caret, and its label sits
  at `fg-subtle` where a group header sits at `fg`. **Only projects are
  pinnable.** A pinned harness would be very nearly the collapse state the group
  header already has, and one pin kind means there is no rule to invent for a
  pinned project inside a pinned harness - so nothing in this rail may offer to
  pin one. A harness *root* is a project and does have a star, like any other
  directory a session can start in.

  Pins are flat and cross-harness, which is the whole point of them, so a
  pinned project appears **once** - in the section, never also in its group -
  and the section sorts by name rather than by path, since path order is
  harness order and that is the arrangement being escaped. The filter reaches it
  like every other row.
- **Project rows in the tree**: kind icon, name, `GitChip`, and a pinning star
  in a reserved right gutter under the rules in §5. The icon stays
  because harness / repo / plain folder is the one thing a row's name and branch
  cannot say. Inventory counts do not - what a project contributes to a session
  is answered in full by the project pane, and three numbers in a 280px rail
  only hint at it.

  A pinned row whose folder is no longer there keeps its place and says so, in
  `SessionHistory`'s own words - the **`folder gone`** badge, the same hairline
  outline pill. It is **not a button**: a pin is a deliberate act and an
  unplugged drive is not a decision to un-pin, but a row that offered a launch
  which would fail is worse than a row that says why it cannot. Its star is the
  one thing left to do to it, so that one is shown outright rather than on
  hover - there is nothing else for hover to reveal.

## 6. Foreign-ground islands

Two islands host content Helm does not own: the terminal and the embedded
document/artifact viewer. The rule: **the island's chrome is themed; the
content's ground is its own, fixed in both modes.**

- The terminal keeps `#11121A` (`bg-terminal`) in both modes - load-bearing
  for Spike C's color checks, and the reason a session's *tab* also keeps its
  own fixed text color (`#dde1ea`) when active.
- The **palette** is fixed too, and that is a decision rather than an omission:
  the 24-bit `THEME` in `renderer/terminal.ts` is asserted pixel-for-pixel by
  the fidelity checks, so terminal colours are deliberately not a setting.
  What *is* settable is everything that is not colour - font, size,
  cursor, scrollback - and the settings pane's preview well paints those on
  this same fixed ground, in both themes, so the preview is the pane.
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
- No solid status badges - a state chip is a hairline outline in its tone, not
  GitHub's filled green and purple
- No theming foreign grounds - terminal and embedded documents keep their own
- No raw hex in components; tokens only
