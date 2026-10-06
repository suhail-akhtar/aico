/**
 * The two full-page navigations the app performs, behind an object a test can spy on.
 *
 * Why: `window.location.replace` and `.reload` cannot be replaced in jsdom (the
 * properties are unforgeable), so any code that calls them directly cannot be
 * tested. Everything that leaves the SPA (to the gateway's sign-in, a reload
 * after an error) goes through here.
 */
export const browser = {
  replace(url: string): void {
    window.location.replace(url);
  },
  reload(): void {
    window.location.reload();
  },
};
