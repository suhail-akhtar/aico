import { type ChangeEvent, useCallback, useEffect, useState } from 'react';
import { type Attachment, api } from '../api';
import { errorMessage } from './errors';

/** Files on one task. The browser downloads through the API (it checks the owner every time). */
export function Attachments({ taskId }: { taskId: string }) {
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listAttachments(taskId)
      .then((next) => {
        setFiles(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [taskId]);

  useEffect(load, [load]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await api.uploadAttachment(taskId, file);
      load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      input.value = '';
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteAttachment(taskId, id);
      load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="files">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {files?.length === 0 && <p className="muted">No files.</p>}
      <ul>
        {files?.map((file) => (
          <li key={file.id}>
            <a href={api.attachmentUrl(taskId, file.id)}>{file.fileName}</a>{' '}
            <span className="muted">({Math.ceil(file.sizeBytes / 1024)} KB)</span>{' '}
            <button
              type="button"
              aria-label={`Remove ${file.fileName}`}
              onClick={() => remove(file.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <label>
        Add a file (png, jpeg, gif, webp, pdf or text; up to 5 MB)
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain"
          onChange={upload}
          disabled={busy}
        />
      </label>
    </div>
  );
}
