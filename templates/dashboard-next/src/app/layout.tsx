import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '__APP_TITLE__',
  description: '__APP_DESCRIPTION__',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
            <span className="font-bold">__APP_TITLE__</span>
            <span className="text-sm text-ink-muted">__APP_DESCRIPTION__</span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
