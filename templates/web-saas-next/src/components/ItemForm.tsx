'use client';

import { useActionState, useEffect, useRef } from 'react';
import { addItem } from '@/app/items/actions';

/** Add an item. The error shows beside the field; the field clears on success. */
export function ItemForm() {
  const [state, formAction, pending] = useActionState(addItem, {});
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!pending && !state.error && input.current) input.current.value = '';
  }, [pending, state]);
  return (
    <form action={formAction} className="flex items-start gap-2" noValidate>
      <div className="flex-1">
        <label className="sr-only" htmlFor="name">New item</label>
        <input ref={input} id="name" name="name" className="input" placeholder="What needs doing?" autoComplete="off" aria-invalid={Boolean(state.error)} />
        {state.error && <p className="field-error" role="alert">{state.error}</p>}
      </div>
      <button className="btn" type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add'}</button>
    </form>
  );
}
