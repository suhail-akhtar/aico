import { useEffect, useState } from 'react';
import { type AuditLine, api, type Page, type Task } from '../api';
import { errorMessage } from './errors';

/** Administrators only: every task, and the audit trail. The API enforces the role, not this page. */
export function Admin() {
  const [tasks, setTasks] = useState<Page<Task> | null>(null);
  const [audit, setAudit] = useState<Page<AuditLine> | null>(null);
  const [auditPage, setAuditPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminTasks(0)
      .then(setTasks)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    api
      .audit(auditPage)
      .then(setAudit)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [auditPage]);

  return (
    <section aria-labelledby="admin-heading">
      <h1 id="admin-heading">Administration</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <h2>Recent tasks (all users)</h2>
      {tasks === null ? (
        <p aria-busy="true">Loading...</p>
      ) : (
        <table>
          <caption className="sr-only">Tasks of every user</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">Assignee</th>
            </tr>
          </thead>
          <tbody>
            {tasks.items.map((task) => (
              <tr key={task.id}>
                <td>{task.title}</td>
                <td>{task.status}</td>
                <td>{task.assigneeEmail ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Audit trail</h2>
      {audit === null ? (
        <p aria-busy="true">Loading...</p>
      ) : (
        <>
          <table>
            <caption className="sr-only">Audit trail, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {audit.items.map((line) => (
                <tr key={line.id}>
                  <td>{new Date(line.occurredAt).toLocaleString()}</td>
                  <td>{line.actorLabel}</td>
                  <td>{line.action}</td>
                  <td>{JSON.stringify(line.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav className="pager" aria-label="Audit pages">
            <button
              type="button"
              disabled={auditPage === 0}
              onClick={() => setAuditPage(auditPage - 1)}
            >
              Newer
            </button>
            <span>
              Page {audit.page + 1} of {Math.max(audit.totalPages, 1)}
            </span>
            <button
              type="button"
              disabled={auditPage + 1 >= audit.totalPages}
              onClick={() => setAuditPage(auditPage + 1)}
            >
              Older
            </button>
          </nav>
        </>
      )}
    </section>
  );
}
