/**
 * The selected row of a list (DESIGN.md 4, "It changes appearance under the
 * pointer").
 *
 * A class string rather than a component, for the same reason `SEGMENT_ON` is
 * one: the app's selectable rows legitimately differ in geometry and in what
 * else marks them - the sidebar's project rows carry an accent edge and a pin
 * star, the config console's carry a scope chip, session history's carry a
 * status pill. What must not differ is the tone.
 *
 * **The hover half is why this exists.** Every one of those sites was written
 * as `selected ? 'bg-accent-soft' : 'hover:bg-hover'` - the ternary puts the
 * hover recipe in the *unselected* branch only, so the moment a row is selected
 * it stops answering the pointer entirely. Five sites, all identical, and it is
 * the same shape `SEGMENT_ON` was created for: the note there says the chosen
 * segment "turned out to be the one shape in the app with no hover state at
 * all", and this is the second one. `affordance-check` found it as a single
 * dead hover on one sidebar row, because that is the only one of the five its
 * walk reaches in the selected state.
 *
 * The hover cannot be `bg-hover`. A selected row is not resting on the surface
 * any more, it is resting on `accent-soft`, and `hover` is a grey step - laid
 * on top it would make the row read as *less* selected under the pointer than
 * beside it. `accent-soft-hover` is more of what the row already is; the sizing
 * against the step known to read is in `theme.css` beside the token.
 *
 * There is no matching `ROW_OFF`, by the same rule `SEGMENT_OFF` does not
 * exist: an unselected row's resting tone belongs to the site, and every one of
 * them already answers with `hover:bg-hover`.
 */
export const ROW_SELECTED = 'bg-accent-soft hover:bg-accent-soft-hover'

/**
 * `ROW_SELECTED` for a row whose hover is driven by a `group` on its wrapper.
 *
 * The sidebar's project row is one: its pin star sits outside the button, and a
 * row that went flat while the pointer was on its own star would read as two
 * controls rather than one. The tint has to follow the group, so the variant
 * has to as well - a plain `hover:` here would leave the row dead exactly while
 * someone is reaching for the star.
 */
export const ROW_SELECTED_GROUP = 'bg-accent-soft group-hover:bg-accent-soft-hover'
