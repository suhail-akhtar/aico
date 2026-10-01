const state = { tickets: [], selectedId: null };

async function api(method, route, body) {
  const res = await fetch(route, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function renderList() {
  const list = document.getElementById('tickets');
  list.replaceChildren(...state.tickets.map((t) => el('li', {
    class: `ticket${t.id === state.selectedId ? ' selected' : ''}`,
    'data-testid': 'ticket-row',
    'data-id': String(t.id),
    tabindex: '0',
    onclick: () => select(t.id),
    onkeydown: (e) => { if (e.key === 'Enter') select(t.id); },
  },
  el('span', { class: 'title' }, t.title),
  el('span', { class: `badge ${t.priority}` }, t.priority),
  el('span', { class: `status ${t.status}` }, t.status))));
}

async function renderDetail() {
  const detail = document.getElementById('detail');
  if (state.selectedId == null) {
    detail.replaceChildren(el('p', { class: 'muted' }, 'Select a ticket.'));
    return;
  }
  const t = await api('GET', `/api/tickets/${state.selectedId}`);
  const status = el('select', { 'data-testid': 'ticket-status', onchange: async (e) => {
    await api('PATCH', `/api/tickets/${t.id}`, { status: e.target.value });
    await refresh();
  } }, ...['open', 'pending', 'closed'].map((s) => {
    const o = el('option', { value: s }, s);
    if (s === t.status) o.selected = true;
    return o;
  }));
  detail.replaceChildren(
    el('h2', { 'data-testid': 'ticket-title' }, t.title),
    el('p', { class: 'meta' }, `#${t.id} · ${t.priority} priority · opened ${new Date(t.created_at).toLocaleString()}`),
    el('label', { class: 'field' }, 'Status ', status),
    el('p', { class: 'description' }, t.description || 'No description.'),
  );
}

async function refresh() {
  state.tickets = await api('GET', '/api/tickets');
  renderList();
  await renderDetail();
}

async function select(id) {
  state.selectedId = id;
  renderList();
  await renderDetail();
}

document.getElementById('new-ticket').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const created = await api('POST', '/api/tickets', { title: form.title.value, priority: form.priority.value });
  form.reset();
  state.selectedId = created.id;
  await refresh();
});

refresh().catch((err) => console.error(err));
