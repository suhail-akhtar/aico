import { browser } from '../shared/browser';
import { t } from '../shared/i18n/i18n';
import { Button } from '../shared/ui/Button';

/** Shown when /config.json is missing or invalid: a clear stop beats a page that half works. */
export function ConfigErrorScreen({ detail }: { detail: string }) {
  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-2xl font-semibold">{t('error.config.title')}</h1>
      <p role="alert" className="mt-2 text-muted">
        {t('error.config.body', { detail })}
      </p>
      <div className="mt-6">
        <Button variant="primary" onClick={() => browser.reload()}>
          {t('error.reload')}
        </Button>
      </div>
    </main>
  );
}
