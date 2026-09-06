import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { register } from '@/app/actions/auth';
import { currentUser } from '@/lib/auth';

export default async function RegisterPage() {
  if (await currentUser()) redirect('/items');
  return (
    <AuthForm
      title="Create an account"
      submit="Create account"
      action={register}
      autoCompletePassword="new-password"
      alternative={{ text: 'Already have one?', href: '/login', label: 'Sign in' }}
    />
  );
}
