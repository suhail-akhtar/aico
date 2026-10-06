/**
 * Form values to a request body, validated by the schema generated from the contract.
 *
 * Why: the limits (name 1 to 120, description up to 1000, quantity 0 to
 * 1,000,000) are stated once, in openapi/openapi.json, and arrive here through
 * the generated `zItemInput`. The form adds only what a text box needs on top:
 * trim the strings, turn an empty description into "none", and turn the quantity
 * text into a number. Messages come from the catalogue (translatable), keyed by
 * the field and the kind of failure, never from zod's English text.
 */

import { zItemInput } from '../../api/generated/zod.gen';
import { t } from '../../shared/i18n/i18n';

export interface FormValues {
  name: string;
  description: string;
  quantity: string;
}

export interface ItemBody {
  name: string;
  description: string | null;
  quantity: number;
}

export type FormErrors = Partial<Record<keyof FormValues, string>>;

export function emptyValues(): FormValues {
  return { name: '', description: '', quantity: '0' };
}

function message(field: keyof FormValues, code: string): string {
  if (field === 'name')
    return code === 'too_big' ? t('form.error.nameTooLong') : t('form.error.nameRequired');
  if (field === 'description') return t('form.error.descriptionTooLong');
  return t('form.error.quantityInvalid');
}

export function parseForm(
  values: FormValues,
): { ok: true; body: ItemBody } | { ok: false; errors: FormErrors } {
  const quantityText = values.quantity.trim();
  const candidate = {
    name: values.name.trim(),
    description: values.description.trim() || null,
    // An empty or non-numeric box must fail the integer check, not become 0.
    quantity: quantityText === '' ? Number.NaN : Number(quantityText),
  };
  const result = zItemInput.safeParse(candidate);
  if (result.success) {
    return {
      ok: true,
      body: {
        name: result.data.name,
        description: result.data.description ?? null,
        quantity: result.data.quantity,
      },
    };
  }
  const errors: FormErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (field === 'name' || field === 'description' || field === 'quantity') {
      errors[field] ??= message(field, issue.code);
    }
  }
  return { ok: false, errors };
}
