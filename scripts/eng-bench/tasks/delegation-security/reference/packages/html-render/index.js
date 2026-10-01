// Reference fix (grader self-test only).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => /^\s*https?:\/\//i.test(String(u)) ? String(u).trim() : null;

export function renderComment(comment) {
  const when = new Date(comment.createdAt).toISOString().slice(0, 10);
  const url = comment.url ? safeUrl(comment.url) : null;
  const author = url
    ? `<a class="author" href="${esc(url)}">${esc(comment.author)}</a>`
    : `<span class="author">${esc(comment.author)}</span>`;
  return `<article class="comment">${author}<time datetime="${esc(comment.createdAt)}">${when}</time><p>${esc(comment.body)}</p></article>`;
}
