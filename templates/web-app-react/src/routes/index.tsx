import { createFileRoute, redirect } from '@tanstack/react-router';
import { loginHref, sessionQuery } from '../auth/auth';
import { t } from '../shared/i18n/i18n';
import { ButtonLink } from '../shared/ui/Button';

export const Route = createFileRoute('/')({
  // Someone who is already signed in has no use for the landing page.
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(sessionQuery);
    if (user) throw redirect({ to: '/items' });
  },
  component: Landing,
});

function Landing() {
  const { config } = Route.useRouteContext();
  return (
    <section className="mx-auto max-w-2xl py-8 text-center sm:py-16">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{t('landing.title')}</h1>
      <p className="mt-4 text-lg text-muted">{t('landing.body')}</p>
      <p className="mt-8">
        <ButtonLink href={loginHref(config, '/items')}>{t('landing.cta')}</ButtonLink>
      </p>
    </section>
  );
}
