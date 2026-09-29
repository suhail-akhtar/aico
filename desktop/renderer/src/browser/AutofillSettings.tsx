/**
 * Settings → Browser → Autofill: the details the browser (and, when you ask,
 * AICO) fills into forms — your name, email, phone, company, and addresses —
 * kept on this computer only, encrypted with the system keychain when it is
 * available. Passwords and payment details are deliberately not part of it.
 *
 * @module desktop/renderer/browser/AutofillSettings
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast } from '@/state/desk';
import { Row } from '@/settings/fields';
import { call } from './ipc';
import { useAutofillStatus } from './BrowserExtras';

interface Address {
  id: string; label: string; name?: string; company?: string; line1: string; line2?: string;
  city: string; region?: string; postalCode: string; country: string; phone?: string;
}
interface Profile {
  fullName: string; givenName: string; familyName: string; email: string; phone: string; company: string; jobTitle: string;
  addresses: Address[]; defaultAddress?: string; shippingAddress?: string; deliveryNotes: string; updatedAt: number;
}

const blankAddress = (n: number): Address => ({ id: `a${Date.now().toString(36)}${n}`, label: n === 0 ? 'Home' : `Address ${n + 1}`, line1: '', city: '', postalCode: '', country: '' });

function Field({ label, value, onChange, type = 'text', placeholder, auto, wide }: {
  label: string; value: string | undefined; onChange: (v: string) => void; type?: string; placeholder?: string; auto?: string; wide?: boolean;
}): React.ReactElement {
  return (
    <label className={cls('flex min-w-0 flex-col gap-1 text-[12px] text-aico-muted', wide && 'col-span-2')}>
      {label}
      <input className="input h-8" type={type} value={value ?? ''} placeholder={placeholder} autoComplete={auto ?? 'off'} onChange={e => onChange(e.target.value)} />
    </label>
  );
}

export function AutofillSettings(): React.ReactElement {
  const [p, setP] = useState<Profile | null>(null);
  const [encrypted, setEncrypted] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void call<Profile>('browser:autofill:get').then(x => { if (x) setP(x); }).catch(() => {});
    void call<{ encrypted: boolean }>('browser:autofill:status').then(s => { if (s) setEncrypted(s.encrypted); }).catch(() => {});
  }, []);

  if (!p) return <div className="set-group px-4 py-3 text-[12.5px] text-aico-muted">Autofill is not available in this version.</div>;

  const edit = (patch: Partial<Profile>): void => { setP({ ...p, ...patch }); setDirty(true); };
  const editAddr = (id: string, patch: Partial<Address>): void => edit({ addresses: p.addresses.map(a => (a.id === id ? { ...a, ...patch } : a)) });
  const save = async (): Promise<void> => {
    try {
      const next = await call<Profile>('browser:autofill:set', p);
      if (next) { setP(next); setDirty(false); useAutofillStatus.getState().refresh(); toast.success('Autofill details saved'); }
    } catch (err) { toast.error('Could not save', (err as Error).message); }
  };

  return (
    <div>
      <h3 className="set-heading">Autofill</h3>
      <p className="-mt-1 mb-2 text-[12px] leading-relaxed text-aico-muted">
        Filled into forms when you press the <Icon name="key" size={11} className="inline" /> key by the address bar, or when you ask AICO to “fill this with my profile”.
        Kept on this computer only{encrypted ? ', encrypted with your system keychain' : ' (your system offers no keychain, so it is stored unencrypted)'}.
        Passwords, card numbers, CVVs and one-time codes are never stored or filled.
      </p>
      <div className="set-group px-4 py-3">
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <Field label="Full name" value={p.fullName} onChange={v => edit({ fullName: v })} wide />
          <Field label="First name" value={p.givenName} onChange={v => edit({ givenName: v })} placeholder="From the full name if empty" />
          <Field label="Last name" value={p.familyName} onChange={v => edit({ familyName: v })} placeholder="From the full name if empty" />
          <Field label="Email" type="email" value={p.email} onChange={v => edit({ email: v })} />
          <Field label="Phone" type="tel" value={p.phone} onChange={v => edit({ phone: v })} />
          <Field label="Company" value={p.company} onChange={v => edit({ company: v })} />
          <Field label="Job title" value={p.jobTitle} onChange={v => edit({ jobTitle: v })} />
        </div>
      </div>

      <div className="mb-1 mt-4 flex items-center">
        <div className="flex-1 text-[13px] font-medium">Addresses</div>
        <button className="btn-ghost btn-sm" onClick={() => { const a = blankAddress(p.addresses.length); edit({ addresses: [...p.addresses, a], defaultAddress: p.defaultAddress ?? a.id }); setOpen(a.id); }}>
          <Icon name="plus" size={13} />Add address
        </button>
      </div>
      <div className="set-group">
        {p.addresses.length === 0 && <div className="px-4 py-3 text-[12.5px] text-aico-muted">No addresses yet.</div>}
        {p.addresses.map(a => (
          <div key={a.id} className="border-b border-aico-border-subtle last:border-b-0">
            <button className="flex w-full items-center gap-2 px-4 py-2.5 text-left" onClick={() => setOpen(open === a.id ? null : a.id)}>
              <Icon name="home" size={14} className="text-aico-secondary" />
              <span className="text-[13px] font-medium">{a.label || 'Address'}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-aico-muted">{[a.line1, a.city, a.postalCode, a.country].filter(Boolean).join(', ')}</span>
              {p.defaultAddress === a.id && <span className="chip h-5 py-0 text-[10.5px]">Default</span>}
              {p.shippingAddress === a.id && <span className="chip h-5 py-0 text-[10.5px]">Shipping</span>}
              <Icon name={open === a.id ? 'chevron-up' : 'chevron-down'} size={13} className="text-aico-muted" />
            </button>
            {open === a.id && (
              <div className="px-4 pb-3">
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  <Field label="Label" value={a.label} onChange={v => editAddr(a.id, { label: v })} placeholder="Home, Work…" />
                  <Field label="Recipient (if not you)" value={a.name} onChange={v => editAddr(a.id, { name: v })} />
                  <Field label="Address line 1" value={a.line1} onChange={v => editAddr(a.id, { line1: v })} wide />
                  <Field label="Address line 2" value={a.line2} onChange={v => editAddr(a.id, { line2: v })} placeholder="Apartment, suite, unit…" wide />
                  <Field label="City" value={a.city} onChange={v => editAddr(a.id, { city: v })} />
                  <Field label="State / region" value={a.region} onChange={v => editAddr(a.id, { region: v })} />
                  <Field label="Postcode" value={a.postalCode} onChange={v => editAddr(a.id, { postalCode: v })} />
                  <Field label="Country" value={a.country} onChange={v => editAddr(a.id, { country: v })} placeholder="United Kingdom, US…" />
                  <Field label="Phone for this address" type="tel" value={a.phone} onChange={v => editAddr(a.id, { phone: v })} />
                  <Field label="Company" value={a.company} onChange={v => editAddr(a.id, { company: v })} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button className="btn-outline btn-sm" disabled={p.defaultAddress === a.id} onClick={() => edit({ defaultAddress: a.id })}>Make default</button>
                  <button className="btn-outline btn-sm" onClick={() => edit({ shippingAddress: p.shippingAddress === a.id ? undefined : a.id })}>
                    {p.shippingAddress === a.id ? 'Stop using for shipping' : 'Use for shipping'}
                  </button>
                  <span className="flex-1" />
                  <button className="btn-ghost btn-sm text-aico-danger" onClick={() => {
                    const addresses = p.addresses.filter(x => x.id !== a.id);
                    edit({ addresses, defaultAddress: p.defaultAddress === a.id ? addresses[0]?.id : p.defaultAddress, shippingAddress: p.shippingAddress === a.id ? undefined : p.shippingAddress });
                  }}><Icon name="trash" size={13} />Remove</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="set-group mt-3">
        <Row title="Delivery instructions" desc="Filled into “delivery instructions” boxes at checkout." stack>
          <input className="input" value={p.deliveryNotes} onChange={e => edit({ deliveryNotes: e.target.value })} placeholder="e.g. Leave with the neighbour at no. 12" />
        </Row>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {dirty && <button className="btn-ghost btn-sm" onClick={() => void call<Profile>('browser:autofill:get').then(x => { if (x) { setP(x); setDirty(false); } })}>Discard</button>}
        <button className="btn-primary btn-sm" disabled={!dirty} onClick={() => void save()}>Save autofill details</button>
      </div>
    </div>
  );
}
