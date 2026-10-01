/**
 * One comment as an HTML fragment for the ticket page.
 * comment = { author: string, body: string, createdAt: ISO string, url?: string }
 */
export function renderComment(comment) {
  const when = new Date(comment.createdAt).toISOString().slice(0, 10);
  const author = comment.url
    ? `<a class="author" href="${comment.url}">${comment.author}</a>`
    : `<span class="author">${comment.author}</span>`;
  return `<article class="comment">${author}<time datetime="${comment.createdAt}">${when}</time><p>${comment.body}</p></article>`;
}
