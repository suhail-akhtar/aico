/**
 * One shape for every control on the composer's toolbar.
 *
 * There are seven of them and they lived in five files, each having invented its
 * own pill: `rounded-lg px-2.5 py-1 text-[13px]` here, `rounded-md px-2 py-1
 * text-[12px]` there, `rounded-full px-2.5 py-1 text-[12px]` for the model. Side
 * by side that reads as a row assembled from spare parts — which is exactly what
 * it was — and no single file was wrong enough to notice on its own.
 *
 * ## The height is fixed, and that is the point
 *
 * `h-7` rather than vertical padding. Padding makes a control's height depend on
 * its text, so the moment one label wraps — `Think: auto (high)` did, at a
 * perfectly ordinary window width — that control becomes two lines tall and every
 * neighbour is centred against it. The row looked broken and the cause was one
 * label being eighteen characters long.
 *
 * `whitespace-nowrap` and `shrink-0` are the other half of the same fix: a flex
 * item that is allowed to shrink resolves an over-subscribed row by wrapping its
 * own text, silently, before anything else gives. Refusing both means an
 * over-subscribed row wraps *as a row*, which is a thing a reader can understand.
 *
 * Anything that can be long — a model id, an agent name — must still carry its
 * own `max-w-*` and `truncate`. Nowrap without a bound just moves the overflow.
 *
 * @module components/toolbar
 */

/**
 * The base every toolbar control shares.
 *
 * Deliberately not a component. These are five different buttons with five
 * different popovers, refs and disabled rules; wrapping them in a common
 * `<ToolbarButton>` would mean threading all of that through one signature. A
 * string they each spread is the smaller commitment, and it is the part that
 * actually has to agree.
 */
export const TOOLBAR_CONTROL = 'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap '
  + 'rounded-lg px-2.5 text-[13px] leading-none transition-colors disabled:opacity-40';

/**
 * Lit when the control is doing something other than the default.
 *
 * The rule across the whole toolbar: quiet while a setting is at its default,
 * accented the moment it is not. A row where every control is tinted says
 * nothing; one tinted control says "this turn is different from the last".
 */
export function toolbarTone(active: boolean): string {
  return active
    ? 'bg-aico-accent-soft text-aico-accent'
    : 'text-aico-muted hover:bg-aico-hover hover:text-aico-secondary';
}

/**
 * A muted caption inside a control, for the ones that show a name and a value.
 *
 * `Think` and `Approve` are captions; `auto` and `high` are the answer. Drawing
 * them at one weight makes the reader parse the whole string to find the part
 * that changed, which is the part they are scanning for.
 */
export const TOOLBAR_CAPTION = 'text-aico-muted/70';
