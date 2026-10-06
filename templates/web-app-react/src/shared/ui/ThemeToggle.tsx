import { useState } from 'react';
import { t } from '../i18n/i18n';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'theme';

export function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

/** `system` removes the override so `prefers-color-scheme` decides; the choice is remembered when storage allows. */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage is blocked: the choice applies to this page view only.
  }
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="sr-only">{t('app.theme.label')}</span>
      <select
        value={choice}
        onChange={(event) => {
          const next = event.target.value as ThemeChoice;
          setChoice(next);
          applyTheme(next);
        }}
        className="min-h-10 rounded-md border border-line bg-surface px-2 text-fg"
      >
        <option value="system">{t('app.theme.system')}</option>
        <option value="light">{t('app.theme.light')}</option>
        <option value="dark">{t('app.theme.dark')}</option>
      </select>
    </label>
  );
}
