import { useState } from 'react';
import { Modal, Alert, useToast } from './ui.jsx';

/**
 * The shell every workflow dialog in the app shares.
 *
 * It lived inside `actions.jsx` while that file held every dialog. The
 * vendor payment dialogs (#214) are their own file, and two copies of the
 * submit-and-surface-field-errors plumbing is exactly the drift this
 * extraction avoids.
 */

/** Shared plumbing: submit, surface field errors, toast, close. */
export function useAction({ onDone, successMessage }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await fn();
      toast(typeof successMessage === 'function' ? successMessage(result?.data) : successMessage, 'success');
      onDone?.(result?.data);
      return true;
    } catch (err) {
      if (err.fields) setFieldErrors(err.fields);
      setError(err.message);
      setBusy(false);
      return false;
    }
  };

  return { busy, error, fieldErrors, run, setFieldErrors };
}

export function ActionModal({ title, subtitle, onClose, onSubmit, busy, error, submitLabel, submitDisabled = false, children, size = 'sm' }) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      size={size}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="action-form" className="btn btn--primary" disabled={busy || submitDisabled}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <form id="action-form" onSubmit={onSubmit} className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        {children}
      </form>
    </Modal>
  );
}
