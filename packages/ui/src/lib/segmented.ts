/**
 * The chosen segment of a segmented control (DESIGN.md 4).
 *
 * A class string rather than a component, because the app's six segmented
 * controls legitimately differ in geometry and in how each says which one is
 * chosen: one is a `radiogroup` of icons at `size-6`, one is words at
 * `px-2.5`, one truncates inside a container query. What must not differ is the
 * tone - and it was already copy-pasted six times, identically, when the chosen
 * segment turned out to be the one shape in the app with no hover state at all.
 *
 * It hovers to `bg-active` rather than `bg-hover`, which is the token every
 * other row and button uses, and that is deliberate. A chosen segment rests on
 * `surface-raised`, not on the surface; in dark mode `hover` and
 * `surface-raised` are six points apart across the whole channel, which
 * `affordance-check` would score as a change and nobody would see. `active` is
 * one clear step above where the segment actually sits, in both themes.
 *
 * There is no matching `SEGMENT_OFF`. An unchosen segment's resting tone is the
 * site's to pick - icons sit at `fg-subtle`, words at `fg-muted` - and every
 * one of them already answers the pointer with `hover:text-fg`.
 */
export const SEGMENT_ON = 'bg-surface-raised text-fg ring-1 ring-border-strong hover:bg-active'
