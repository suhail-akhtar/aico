import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { z } from 'zod';
import { loginHref, safeReturnTo } from '../auth/auth';
import { browser } from '../shared/browser';
import { t } from '../shared/i18n/i18n';
import { ButtonLink } from '../shared/ui/Button';
import { Spinner } from '../shared/ui/Feedback';

export const Route = createFileRoute('/login')({
  validateSearch: z.object({ returnTo: z.string().optional() }),
  component: Login,
});

/**
 * The bridge from "a protected page needs a session" to the gateway's sign-in.
 * It leaves the SPA with a full-page navigation (the identity provider renders
 * its own pages); the link is the fallback when scripts are slow or blocked.
 */
function Login() {
  const { config } = Route.useRouteContext();
  const { returnTo } = Route.useSearch();
  const href = loginHref(config, safeReturnTo(returnTo));

  useEffect(() => {
    browser.replace(href);
  }, [href]);

  return (
    <section className="py-16 text-center">
      <h1 className="sr-only">{t('app.signIn')}</h1>
      <Spinner label={t('login.redirecting')} />
      <p className="mt-6">
        <ButtonLink href={href}>{t('login.continue')}</ButtonLink>
      </p>
    </section>
  );
}
