'use server';

import { redirect } from 'next/navigation';
import { authenticate, clearSessionCookie, createUser, setSessionCookie, validateCredentials, type FieldErrors } from '@/lib/auth';
import { db } from '@/lib/db';

export interface AuthState {
  errors?: FieldErrors;
  message?: string;
}

function read(formData: FormData): { email: string; password: string } {
  return {
    email: String(formData.get('email') ?? '').trim(),
    password: String(formData.get('password') ?? ''),
  };
}

export async function register(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const { email, password } = read(formData);
  const result = createUser(db(), email, password);
  if ('errors' in result) return { errors: result.errors };
  await setSessionCookie(result.user.id);
  redirect('/items');
}

export async function login(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const { email, password } = read(formData);
  const errors = validateCredentials(email, password);
  if (Object.keys(errors).length) return { errors };
  const user = authenticate(db(), email, password);
  if (!user) return { message: 'That email and password do not match.' };
  await setSessionCookie(user.id);
  redirect('/items');
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect('/');
}
