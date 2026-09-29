/**
 * ```draft — a piece of writing to be used somewhere else: an email, a post,
 * a message, a report.
 *
 * The body is Markdown, rendered. The point of the block is what happens next,
 * so the actions are the ones that move it out: copy (rich and plain, so it
 * pastes formatted into a mail client and clean into a plain box), edit in
 * place, open an email in the mail app, download.
 *
 * Edits live in the view only; the transcript keeps what the model wrote.
 *
 * @module shared/ui/rich/Draft
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Arriving, copyText, downloadText, Icon, openMailto, useParsed, type RichIcon } from './common';
import { keepLineBreaks, mailtoLink, markdownToPlain, parseDraft, platformLimit, type DraftKind, type DraftSpec } from './specs';

const KIND: Record<DraftKind, { label: string; icon: RichIcon }> = {
  email: { label: 'Email', icon: 'mail' },
  post: { label: 'Post', icon: 'globe' },
  message: { label: 'Message', icon: 'edit' },
  report: { label: 'Report', icon: 'news' },
  script: { label: 'Script', icon: 'play' },
  document: { label: 'Document', icon: 'news' },
};

export function Draft({ source, streaming = false, language = 'draft' }: { source: string; streaming?: boolean; language?: string }): React.ReactElement {
  const parse = useCallback((s: string) => parseDraft(s, language.toLowerCase()), [language]);
  const { spec, waiting } = useParsed(source, streaming, parse);
  if (waiting || !spec) return <Arriving what="Draft" />;
  return <DraftView key={source} spec={spec} />;
}

const mdLink = ({ href, children }: { href?: string; children?: React.ReactNode }): React.ReactElement => (
  <a href={href} {...(/^https?:/i.test(href ?? '') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>
);

function DraftView({ spec }: { spec: DraftSpec }): React.ReactElement {
  const [body, setBody] = useState(spec.body);
  const [subject, setSubject] = useState(spec.subject ?? '');
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const rendered = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const kind = KIND[spec.kind];
  const isEmail = spec.kind === 'email';
  const limit = platformLimit(spec.platform);
  const plain = markdownToPlain(body);
  const words = plain.split(/\s+/).filter(Boolean).length;

  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(640, el.scrollHeight + 2)}px`;
  }, [editing, body]);

  const copy = async (): Promise<void> => {
    const html = rendered.current?.innerHTML;
    const head = isEmail && subject ? `Subject: ${subject}\n\n` : '';
    const ok = await copyText(head + plain, html ? (isEmail && subject ? `<p><b>Subject:</b> ${escapeHtml(subject)}</p>` : '') + html : undefined);
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1300); }
  };

  const fileBase = (spec.title ?? subject ?? kind.label).replace(/[^\w\- ]+/g, '').trim().slice(0, 60).replace(/\s+/g, '-').toLowerCase() || 'draft';
  const header = isEmail
    ? [spec.to && `To: ${spec.to}`, spec.cc && `Cc: ${spec.cc}`, subject && `Subject: ${subject}`].filter(Boolean).join('\n')
    : spec.title ? `# ${spec.title}` : '';

  return (
    <div className="aw aw-draft">
      <div className="aw-draft-bar">
        <span className="aw-kind"><Icon name={kind.icon} size={12} /> {kind.label}</span>
        {spec.platform && <span className="aw-chip is-static">{spec.platform}</span>}
        <span className="aw-grow" />
        <button type="button" className="aw-btn" onClick={() => { void copy(); }} title="Copy — formatted and plain text">
          <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className={`aw-btn${editing ? ' is-on' : ''}`} onClick={() => setEditing(v => !v)}>
          <Icon name={editing ? 'check' : 'edit'} size={12} /> {editing ? 'Done' : 'Edit'}
        </button>
        {isEmail && (
          <button type="button" className="aw-btn" onClick={() => openMailto(mailtoLink({ to: spec.to, cc: spec.cc, subject, body }))} title="Open in your mail app">
            <Icon name="mail" size={12} /> <span className="aw-hide-narrow">Open in mail app</span><span className="aw-show-narrow">Mail</span>
          </button>
        )}
        <details className="aw-menu">
          <summary className="aw-btn" aria-label="Download"><Icon name="download" size={12} /></summary>
          <div className="aw-menu-list">
            <button type="button" onClick={(e) => { downloadText(`${fileBase}.md`, (header ? header + '\n\n' : '') + body, 'text/markdown'); closeMenu(e); }}>Markdown (.md)</button>
            <button type="button" onClick={(e) => { downloadText(`${fileBase}.txt`, (header ? markdownToPlain(header) + '\n\n' : '') + plain); closeMenu(e); }}>Plain text (.txt)</button>
          </div>
        </details>
      </div>

      {isEmail && (
        <div className="aw-mail-head">
          {spec.to && <div className="aw-mail-row"><span>To</span><b>{spec.to}</b></div>}
          {spec.cc && <div className="aw-mail-row"><span>Cc</span><b>{spec.cc}</b></div>}
          <div className="aw-mail-row">
            <span>Subject</span>
            {editing
              ? <input className="aw-input" value={subject} onChange={e => setSubject(e.target.value)} aria-label="Subject" />
              : <b>{subject || <i className="aw-muted">(no subject)</i>}</b>}
          </div>
        </div>
      )}
      {!isEmail && spec.title && <div className="aw-draft-title">{spec.title}</div>}

      {editing ? (
        <textarea
          ref={textarea}
          className="aw-draft-edit"
          value={body}
          onChange={e => setBody(e.target.value)}
          spellCheck
          aria-label="Draft text (Markdown)"
        />
      ) : (
        <div className="aw-draft-body" ref={rendered}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: mdLink }}>{keepLineBreaks(body)}</ReactMarkdown>
        </div>
      )}

      <div className="aw-draft-foot">
        <span>{words.toLocaleString()} {words === 1 ? 'word' : 'words'}</span>
        <span className="aw-dot">·</span>
        <span className={limit && plain.length > limit ? 'aw-closed' : undefined}>
          {plain.length.toLocaleString()}{limit ? ` / ${limit.toLocaleString()}` : ''} characters
        </span>
        {body !== spec.body || subject !== (spec.subject ?? '') ? (
          <>
            <span className="aw-dot">·</span>
            <span>edited here</span>
            <button type="button" className="aw-link-btn" onClick={() => { setBody(spec.body); setSubject(spec.subject ?? ''); }}>undo edits</button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function closeMenu(e: React.MouseEvent): void {
  (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
