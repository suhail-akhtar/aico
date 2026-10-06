import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { Item } from '../../api/generated';
import { t } from '../../shared/i18n/i18n';
import { ApiError } from '../../shared/problem';
import { Button } from '../../shared/ui/Button';
import { TextArea, TextField } from '../../shared/ui/TextField';
import { useToast } from '../../shared/ui/Toast';
import { emptyValues, type FormErrors, type FormValues, parseForm } from './form-schema';
import { useCreateItem, useUpdateItem } from './queries';

interface Props {
  /** Present when editing; absent when creating. */
  item?: Item | undefined;
  onDone: () => void;
  onCancel: () => void;
}

function initialValues(item: Item | undefined): FormValues {
  return item
    ? { name: item.name, description: item.description ?? '', quantity: String(item.quantity) }
    : emptyValues();
}

/** Server field errors, keyed by the lower-cased field name, onto the form's own fields. */
function fromServer(fieldErrors: Readonly<Record<string, string>>): FormErrors {
  const out: FormErrors = {};
  for (const field of ['name', 'description', 'quantity'] as const) {
    const message = fieldErrors[field];
    if (message) out[field] = message;
  }
  return out;
}

export function ItemForm({ item, onDone, onCancel }: Props) {
  const toast = useToast();
  const create = useCreateItem();
  const update = useUpdateItem();
  const [values, setValues] = useState<FormValues>(() => initialValues(item));
  const [errors, setErrors] = useState<FormErrors>({});
  const [failure, setFailure] = useState<string | undefined>();
  const formRef = useRef<HTMLFormElement>(null);
  const saving = create.isPending || update.isPending;

  // After a failed submit, move focus to the first field that needs attention.
  useEffect(() => {
    if (Object.keys(errors).length > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [errors]);

  function set<K extends keyof FormValues>(field: K, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure(undefined);
    const parsed = parseForm(values);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors({});
    try {
      if (item) {
        await update.mutateAsync({ path: { id: item.id }, body: parsed.body });
        toast.push('success', t('toast.updated'));
      } else {
        await create.mutateAsync({ body: parsed.body });
        toast.push('success', t('toast.created'));
      }
      onDone();
    } catch (error) {
      if (error instanceof ApiError) {
        const mapped = fromServer(error.fieldErrors);
        setErrors(mapped);
        setFailure(
          Object.keys(mapped).length > 0
            ? t('form.error.summary')
            : error.isNetwork
              ? t('error.network')
              : (error.detail ?? error.title),
        );
      } else {
        setFailure(t('form.error.summary'));
      }
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="mt-4 space-y-4">
      {failure ? (
        <p
          role="alert"
          className="rounded-md border border-danger p-3 text-sm font-medium text-danger"
        >
          {failure}
        </p>
      ) : null}
      <TextField
        label={t('form.name')}
        value={values.name}
        onChange={(event) => set('name', event.target.value)}
        error={errors.name}
        maxLength={200}
        autoComplete="off"
        data-autofocus
        required
      />
      <TextArea
        label={t('form.description')}
        hint={t('form.descriptionHint')}
        value={values.description}
        onChange={(event) => set('description', event.target.value)}
        error={errors.description}
        rows={3}
      />
      <TextField
        label={t('form.quantity')}
        type="number"
        inputMode="numeric"
        min={0}
        max={1000000}
        step={1}
        value={values.quantity}
        onChange={(event) => set('quantity', event.target.value)}
        error={errors.quantity}
      />
      <div className="flex justify-end gap-2 pt-2">
        <Button onClick={onCancel}>{t('form.cancel')}</Button>
        <Button type="submit" variant="primary" loading={saving}>
          {saving ? t('form.saving') : t('form.save')}
        </Button>
      </div>
    </form>
  );
}
