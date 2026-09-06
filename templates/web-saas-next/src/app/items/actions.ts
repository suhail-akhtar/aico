'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { createItem, deleteItem, parseItemName, toggleItem } from '@/lib/items';

export interface ItemFormState {
  error?: string;
}

/** Every action starts with requireUser(): the acting user comes from the cookie, never the form. */
export async function addItem(_prev: ItemFormState, formData: FormData): Promise<ItemFormState> {
  const user = await requireUser();
  const parsed = parseItemName(formData.get('name'));
  if ('error' in parsed) return { error: parsed.error };
  createItem(db(), user.id, parsed.value);
  revalidatePath('/items');
  return {};
}

export async function toggleItemAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  toggleItem(db(), user.id, Number(formData.get('id')));
  revalidatePath('/items');
}

export async function removeItem(formData: FormData): Promise<void> {
  const user = await requireUser();
  deleteItem(db(), user.id, Number(formData.get('id')));
  revalidatePath('/items');
}
