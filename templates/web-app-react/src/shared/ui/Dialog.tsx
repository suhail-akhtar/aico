import { type ReactNode, useEffect, useId, useRef } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

/**
 * A modal built on the native <dialog>: the browser traps focus, makes the rest
 * of the page inert, closes on Escape and returns focus to the opener, none of
 * which a hand-rolled overlay gets right by default. Content mounts only while
 * open, so a form starts clean every time.
 *
 * `onClose` means "the user dismissed it" (Escape, a backdrop click, or a form
 * calling it); it is not called when the `open` prop itself turns false.
 */
export function Dialog({ open, onClose, title, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  const titleId = useId();

  useEffect(() => {
    openRef.current = open;
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Say where focus starts rather than rely on "first focusable": a destructive confirmation
      // marks Cancel, a form marks its first field.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click is a convenience; Escape and the Cancel button are the keyboard paths.
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={() => {
        if (openRef.current) onClose();
      }}
      // A click on the backdrop lands on the <dialog> element itself, never on its content.
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-fg shadow-xl"
    >
      {open ? (
        <div className="p-5 sm:p-6">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
