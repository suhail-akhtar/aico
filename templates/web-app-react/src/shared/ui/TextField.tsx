import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';

interface FieldProps {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

const control =
  'mt-1 block w-full rounded-md border bg-surface px-3 py-2 text-base text-fg placeholder:text-muted ' +
  'md:text-sm';

function borderFor(error: string | undefined): string {
  return error ? 'border-danger' : 'border-line';
}

/** Ids tie the label, hint and error to the control so a screen reader reads all three. */
function useFieldIds() {
  const id = useId();
  return { id, hintId: `${id}-hint`, errorId: `${id}-error` };
}

function describedBy(
  ids: { hintId: string; errorId: string },
  hint: string | undefined,
  error: string | undefined,
): string | undefined {
  const parts = [hint ? ids.hintId : undefined, error ? ids.errorId : undefined].filter(Boolean);
  return parts.length ? parts.join(' ') : undefined;
}

function Messages({
  ids,
  hint,
  error,
}: {
  ids: { hintId: string; errorId: string };
  hint?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <>
      {hint ? (
        <p id={ids.hintId} className="mt-1 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.errorId} className="mt-1 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function TextField({
  label,
  error,
  hint,
  className = '',
  ...rest
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const ids = useFieldIds();
  return (
    <div>
      <label htmlFor={ids.id} className="block text-sm font-semibold">
        {label}
      </label>
      <input
        id={ids.id}
        className={`${control} ${borderFor(error)} ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        {...rest}
      />
      <Messages ids={ids} hint={hint} error={error} />
    </div>
  );
}

export function TextArea({
  label,
  error,
  hint,
  className = '',
  ...rest
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ids = useFieldIds();
  return (
    <div>
      <label htmlFor={ids.id} className="block text-sm font-semibold">
        {label}
      </label>
      <textarea
        id={ids.id}
        className={`${control} ${borderFor(error)} ${className}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(ids, hint, error)}
        {...rest}
      />
      <Messages ids={ids} hint={hint} error={error} />
    </div>
  );
}
