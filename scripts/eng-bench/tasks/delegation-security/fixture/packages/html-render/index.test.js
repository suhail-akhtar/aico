import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderComment } from './index.js';

test('renders a plain comment', () => {
  const html = renderComment({ author: 'Ana', body: 'Looks good', createdAt: '2024-05-01T10:00:00Z' });
  assert.equal(html, '<article class="comment"><span class="author">Ana</span><time datetime="2024-05-01T10:00:00Z">2024-05-01</time><p>Looks good</p></article>');
});

test('links the author when a url is given', () => {
  const html = renderComment({ author: 'Bo', body: 'ok', createdAt: '2024-05-01T10:00:00Z', url: 'https://example.com/u/bo' });
  assert.match(html, /<a class="author" href="https:\/\/example.com\/u\/bo">Bo<\/a>/);
});
