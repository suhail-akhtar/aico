# Patterns — the six shapes every product screen is made of

Tailwind sketches for the Next.js template's tokens (`brand`, `ink`, `ink-muted`,
`surface`, `surface-alt`, `line`, `danger`). Copy the shape, keep the tokens.

## App shell (signed in)

```tsx
<div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
  <aside className="hidden md:flex flex-col border-r border-line bg-surface-alt px-3 py-4">
    <Link href="/" className="px-2 text-base font-semibold">Studio</Link>
    <nav className="mt-6 flex flex-col gap-1 text-sm">
      {links.map(l => (
        <Link key={l.href} href={l.href} aria-current={active === l.href ? 'page' : undefined}
          className="rounded-lg px-2 py-1.5 text-ink-muted hover:bg-surface hover:text-ink aria-[current=page]:bg-surface aria-[current=page]:text-ink aria-[current=page]:font-medium">
          {l.label}
        </Link>
      ))}
    </nav>
    <div className="mt-auto px-2 text-xs text-ink-muted">{user.email}</div>
  </aside>
  <div className="flex min-w-0 flex-col">
    <header className="flex items-center gap-3 border-b border-line px-4 py-2 md:hidden">
      <button aria-label="Menu" className="btn btn-ghost btn-sm">☰</button>
      <span className="font-semibold">Studio</span>
    </header>
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">{children}</main>
  </div>
</div>
```

## Page header

```tsx
<div className="mb-6 flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
    <p className="mt-1 text-sm text-ink-muted">12 open · 3 overdue · €4,210.00 outstanding</p>
  </div>
  <Link href="/invoices/new" className="btn">New invoice</Link>
</div>
```

## Stat tile (a dashboard is three to five of these, then a table)

```tsx
<div className="card">
  <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">Outstanding</div>
  <div className="mt-2 text-3xl font-semibold tabular-nums">€4,210.00</div>
  <div className="mt-1 text-sm text-ink-muted">across 12 invoices</div>
</div>
```

## Table

```tsx
<div className="card overflow-x-auto p-0">
  <table className="w-full text-sm">
    <thead className="bg-surface-alt text-left text-xs uppercase tracking-wide text-ink-muted">
      <tr>
        <th className="px-4 py-2 font-medium">Invoice</th>
        <th className="px-4 py-2 font-medium">Customer</th>
        <th className="px-4 py-2 font-medium">Due</th>
        <th className="px-4 py-2 font-medium text-right">Total</th>
        <th className="px-4 py-2 font-medium">Status</th>
        <th className="px-4 py-2"><span className="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody className="divide-y divide-line">
      {rows.map(r => (
        <tr key={r.id} className="hover:bg-surface-alt">
          <td className="px-4 py-3 font-medium"><Link href={`/invoices/${r.id}`}>{r.number}</Link></td>
          <td className="px-4 py-3">{r.customer}</td>
          <td className="px-4 py-3 text-ink-muted">{formatDate(r.due)}</td>
          <td className="px-4 py-3 text-right tabular-nums">{money(r.total)}</td>
          <td className="px-4 py-3"><StatusPill status={r.status} /></td>
          <td className="px-4 py-3 text-right"><Link href={`/invoices/${r.id}/edit`} className="text-brand">Edit</Link></td>
        </tr>
      ))}
    </tbody>
  </table>
</div>
```

## Status pill (colour plus a word, always)

```tsx
const TONE = {
  draft: 'bg-surface-alt text-ink-muted',
  sent: 'bg-brand/10 text-brand',
  paid: 'bg-success/10 text-success',
  overdue: 'bg-danger/10 text-danger',
} as const;
export function StatusPill({ status }: { status: keyof typeof TONE }) {
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${TONE[status]}`}>{status}</span>;
}
```

## Empty state (says what the list is for, offers the first action)

```tsx
<div className="card flex flex-col items-center py-12 text-center">
  <h2 className="text-lg font-semibold">No invoices yet</h2>
  <p className="mt-1 max-w-sm text-sm text-ink-muted">Invoices you send to customers appear here with their status and what is still owed.</p>
  <Link href="/invoices/new" className="btn mt-4">Create the first invoice</Link>
</div>
```

## Form (labels above, errors beside, the verb on the button)

```tsx
<form action={create} className="card max-w-xl space-y-4">
  <div>
    <label className="label" htmlFor="customer">Customer</label>
    <select id="customer" name="customerId" className="input" required>…</select>
    {errors.customerId && <p className="field-error" role="alert">{errors.customerId}</p>}
  </div>
  <div className="grid grid-cols-2 gap-4">…</div>
  <div className="flex justify-end gap-2">
    <Link href="/invoices" className="btn btn-ghost">Cancel</Link>
    <button className="btn" type="submit">Create invoice</button>
  </div>
</form>
```

## The 390px rule

Wrap tables in `overflow-x-auto`, or render the same rows as stacked cards under
`md`. The sidebar becomes a menu button. Nothing sets a fixed pixel width on a
container. Check it with `VerifyApp` at `{ width: 390 }` — do not guess.
