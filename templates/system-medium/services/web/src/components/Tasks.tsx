import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, type Page, type Task, type TaskStatus } from '../api';
import { Attachments } from './Attachments';
import { errorMessage } from './errors';

type Filter = TaskStatus | '';

/** The caller's tasks: create, find, complete, delete and attach files. */
export function Tasks({ attachmentsEnabled }: { attachmentsEnabled: boolean }) {
  const [result, setResult] = useState<Page<Task> | null>(null);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<Filter>('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignee, setAssignee] = useState('');
  const [saving, setSaving] = useState(false);
  const [openFiles, setOpenFiles] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listTasks({ page, size: 10, status, q: search })
      .then((next) => {
        setResult(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [page, status, search]);

  useEffect(load, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.createTask({
        title,
        description: description || null,
        assigneeEmail: assignee || null,
      });
      setTitle('');
      setDescription('');
      setAssignee('');
      setPage(0);
      setError(null);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <section aria-labelledby="tasks-heading">
      <h1 id="tasks-heading">My tasks</h1>

      <form onSubmit={create} className="card" aria-label="New task">
        <h2>New task</h2>
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            required
          />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={2}
          />
        </label>
        <label>
          Assign to (email, optional)
          <input
            type="email"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            maxLength={254}
            placeholder="bob@example.com"
          />
        </label>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving...' : 'Add task'}
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="filters">
        <label>
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as Filter);
              setPage(0);
            }}
          >
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="DONE">Done</option>
          </select>
        </label>
        <label>
          Search
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            maxLength={100}
          />
        </label>
      </div>

      {result === null ? (
        <p aria-busy="true">Loading tasks...</p>
      ) : result.items.length === 0 ? (
        <p className="muted">No tasks yet. Add one above.</p>
      ) : (
        <ul className="tasks">
          {result.items.map((task) => (
            <li key={task.id} className={task.status === 'DONE' ? 'done' : undefined}>
              <div className="row">
                <div>
                  <strong>{task.title}</strong>
                  {task.status === 'DONE' && <span className="badge">done</span>}
                  {task.description && <p className="muted">{task.description}</p>}
                  {task.assigneeEmail && <p className="muted">Assigned to {task.assigneeEmail}</p>}
                </div>
                <div className="actions">
                  {task.status === 'OPEN' && (
                    <button type="button" onClick={() => act(() => api.completeTask(task.id))}>
                      Complete
                    </button>
                  )}
                  {attachmentsEnabled && (
                    <button
                      type="button"
                      aria-expanded={openFiles === task.id}
                      onClick={() => setOpenFiles(openFiles === task.id ? null : task.id)}
                    >
                      Files
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger"
                    aria-label={`Delete ${task.title}`}
                    onClick={() => act(() => api.deleteTask(task.id))}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {attachmentsEnabled && openFiles === task.id && <Attachments taskId={task.id} />}
            </li>
          ))}
        </ul>
      )}

      {result !== null && result.totalPages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {result.page + 1} of {result.totalPages}
          </span>
          <button
            type="button"
            disabled={page + 1 >= result.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}
