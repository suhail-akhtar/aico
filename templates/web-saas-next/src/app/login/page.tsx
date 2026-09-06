import { redirect } from 'next/navigation';
import { AuthForm } from '@/components/AuthForm';
import { login } from '@/app/actions/auth';
import { currentUser } from '@/lib/auth';

export default async function LoginPage() {
  if (await currentUser()) redirect('/items');
  return (
    <AuthForm
      title="Sign in"
      submit="Sign in"
      action={login}
      autoCompletePassword="current-password"
      alternative={{ text: 'New here?', href: '/register', label: 'Create an account' }}
    />
  );
}
