'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import type { AuthState } from '@/app/actions/auth';

interface Props {
  title: string;
  submit: string;
  action: (prev: AuthState, formData: FormData) => Promise<AuthState>;
  alternative: { text: string; href: string; label: string };
  autoCompletePassword: 'current-password' | 'new-password';
}

/** One form for sign-in and sign-up: field-level messages beside the field, a form-level one above the button. */
export function AuthForm({ title, submit, action, alternative, autoCompletePassword }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const errors = state.errors ?? {};
  return (
    <div className="card mx-auto mt-6 max-w-sm">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{title}</h1>
      <form action={formAction} className="space-y-4" noValidate>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" className="input" autoComplete="email" required aria-invalid={Boolean(errors.email)} />
          {errors.email && <p className="field-error" role="alert">{errors.email}</p>}
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" className="input" autoComplete={autoCompletePassword} required minLength={8} aria-invalid={Boolean(errors.password)} />
          {errors.password && <p className="field-error" role="alert">{errors.password}</p>}
        </div>
        {state.message && <p className="field-error" role="alert">{state.message}</p>}
        <button className="btn w-full" type="submit" disabled={pending}>{pending ? 'One moment…' : submit}</button>
      </form>
      <p className="mt-4 text-sm text-ink-muted">
        {alternative.text} <Link href={alternative.href} className="text-brand">{alternative.label}</Link>
      </p>
    </div>
  );
}
