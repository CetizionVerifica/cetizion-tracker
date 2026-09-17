import { useEffect, useState } from 'react';
import { Modal, Field, Input, Select, Textarea, Combo, Alert } from './ui.jsx';
import { api, ApiError } from '../lib/api.js';
import { useDocumentUploads } from '../lib/hooks.js';
import { fileSize } from '../lib/format.js';
import { useToast } from './ui.jsx';

/**
 * Every create/edit dialog in the app is this component with a different
 * field list, so all forms validate, report and save identically.
 *
 * A field: { name, label, type, required, options, hint, span, help }
 * type: text | number | money | percent | date | select | combo | textarea | email | document
 *
 * A document field also takes { owner, maxBytes }: owner is the kind of
 * record the file belongs to (quotations, purchase-orders).
 *
 * A field with { auto: 'enquiry' } is a reference number the server assigns
 * when the record is created: shown read-only, never sent.
 */
export function RecordForm({
  title,
  subtitle,
  resource,
  fields,
  record,
  onClose,
  onSaved,
  intro,
  submitLabel,
}) {
  const toast = useToast();
  const isEdit = Boolean(record?.id);

  const [values, setValues] = useState(() => {
    const initial = {};
    for (const field of fields) {
      const raw = record?.[field.name];
      if (field.type === 'percent') {
        initial[field.name] = raw === null || raw === undefined ? '' : String(Number(raw) * 100);
      } else if (typeof raw === 'boolean') {
        initial[field.name] = raw ? 'true' : 'false';
      } else {
        initial[field.name] = raw ?? field.default ?? '';
      }
    }
    return initial;
  });

  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Files chosen in document fields, and what each became once uploaded.
  const [picked, setPicked] = useState({});
  const uploadDocument = useDocumentUploads();
  // On a new record, the next number in each assigned series, shown as a guide.
  const [previews, setPreviews] = useState({});

  useEffect(() => {
    if (isEdit) return;
    for (const field of fields) {
      if (!field.auto) continue;
      api.raw(`/lookups/next-id/${field.auto}`)
        .then((r) => setPreviews((p) => ({ ...p, [field.name]: r.data.next })))
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  /** Returns false when the file is refused, so the input can be cleared. */
  const pickFile = (field, file) => {
    if (file && field.maxBytes && file.size > field.maxBytes) {
      setPicked((p) => ({ ...p, [field.name]: null }));
      setErrors((e) => ({
        ...e,
        [field.name]: `This file is ${fileSize(file.size)} — the limit is ${fileSize(field.maxBytes)}`,
      }));
      return false;
    }
    setPicked((p) => ({ ...p, [field.name]: file }));
    setErrors((e) => (e[field.name] ? { ...e, [field.name]: undefined } : e));
    return true;
  };

  // A chosen file is uploaded first and the record saved with its id.
  async function attachDocuments(payload) {
    for (const field of fields) {
      if (field.type !== 'document') continue;

      const file = picked[field.name];
      if (file) {
        try {
          payload[field.name] = await uploadDocument(file, field.owner);
        } catch (err) {
          throw new ApiError(err.message, { fields: { [field.name]: err.message } });
        }
      }

      if (field.required && !payload[field.name]) {
        throw new ApiError('Attach a document to save', {
          fields: { [field.name]: 'Attach a document to save' },
        });
      }
    }
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    setErrors({});

    const payload = {};
    for (const field of fields) {
      // On edit: reference-number fields are immutable — never send them.
      // On create: include them so the user's explicit value (or blank for auto) reaches the server.
      if (field.auto && isEdit) continue;
      let value = values[field.name];
      if (field.type === 'percent' && value !== '') value = Number(value) / 100;
      if (field.type === 'boolean') value = value === 'true';
      payload[field.name] = value;
    }

    try {
      await attachDocuments(payload);
      const saved = isEdit
        ? await api.update(resource, record.id, payload)
        : await api.create(resource, payload);
      const assigned = fields.find((field) => field.auto && saved?.data?.[field.name]);
      toast(isEdit ? 'Changes saved' : assigned ? `Created ${saved.data[assigned.name]}` : 'Created', 'success');
      onSaved?.(saved?.data);
      onClose();
    } catch (err) {
      if (err.fields) {
        setErrors(err.fields);
        setFormError('Some fields need attention.');
      } else {
        setFormError(err.message);
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="record-form" className="btn btn--primary" disabled={busy}>
            {busy ? 'Saving…' : submitLabel || (isEdit ? 'Save changes' : 'Create')}
          </button>
        </>
      }
    >
      <form id="record-form" onSubmit={submit} className="stack">
        {intro && <Alert>{intro}</Alert>}
        {formError && <Alert tone="danger">{formError}</Alert>}

        <div className="form-grid">
          {fields.map((field) => (
            <div key={field.name} className={field.span === 'all' ? 'span-all' : field.span === 2 ? 'span-2' : ''}>
              <FormField
                field={field}
                value={values[field.name]}
                error={errors[field.name]}
                onChange={(v) => set(field.name, v)}
                record={record}
                file={picked[field.name]}
                onFile={(file) => pickFile(field, file)}
                preview={previews[field.name]}
                isEdit={isEdit}
              />
            </div>
          ))}
        </div>
      </form>
    </Modal>
  );
}

function FormField({ field, value, error, onChange, record, file, onFile, preview, isEdit }) {
  if (field.auto) {
    if (isEdit) {
      // Edit mode: the reference number is immutable — show it as read-only.
      return (
        <Field
          label={field.label}
          hint="Assigned on create — cannot be changed"
          error={error}
        >
          <Input
            type="text"
            className="input mono"
            value={value ?? ''}
            disabled
            readOnly
          />
        </Field>
      );
    }
    // Create mode: the field is editable so the user can enter a historical number.
    // Leaving it blank triggers auto-assignment on the server; the preview shows what
    // the next auto-number would be, as a guide.
    return (
      <Field
        label={field.label}
        hint={
          preview
            ? `Leave blank to assign ${preview} automatically, or enter a historical number`
            : 'Leave blank to assign the next number automatically, or enter a historical number'
        }
        error={error}
      >
        <Input
          type="text"
          className="input mono"
          value={value ?? ''}
          placeholder={preview ?? 'Assigned on save'}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
    );
  }

  const common = {
    value: value ?? '',
    error,
    onChange: (e) => onChange(e.target.value),
    disabled: field.disabled,
    placeholder: field.placeholder,
  };

  let hint = field.hint;
  let control;
  switch (field.type) {
    case 'select':
      control = <Select options={field.options} placeholder={field.required ? 'Select…' : '—'} {...common} />;
      break;
    case 'boolean':
      control = (
        <Select
          options={[{ value: 'true', label: field.trueLabel || 'Yes' }, { value: 'false', label: field.falseLabel || 'No' }]}
          placeholder={null}
          {...common}
        />
      );
      break;
    case 'combo':
      control = <Combo options={field.options} {...common} />;
      break;
    case 'textarea':
      control = <Textarea rows={field.rows || 3} {...common} />;
      break;
    case 'date':
      control = <Input type="date" {...common} />;
      break;
    case 'number':
    case 'money':
    case 'percent':
      control = <Input type="number" step={field.step || (field.type === 'money' ? '0.01' : field.type === 'percent' ? '0.01' : '1')} min={field.min ?? 0} {...common} />;
      break;
    case 'email':
      control = <Input type="email" {...common} />;
      break;
    case 'document':
      hint ??= `Any file type${field.maxBytes ? `, up to ${fileSize(field.maxBytes)}` : ''}`;
      control = (
        <DocumentInput
          current={value ? { id: value, name: record?.document_name } : null}
          file={file}
          onFile={onFile}
          error={error}
          disabled={field.disabled}
        />
      );
      break;
    default:
      control = <Input type="text" {...common} />;
  }

  return (
    <Field label={field.label} required={field.required} hint={hint} error={error}>
      {control}
    </Field>
  );
}

/** A file picker that also shows, and links to, the document already attached. */
function DocumentInput({ current, file, onFile, error, disabled }) {
  return (
    <>
      <input
        type="file"
        className={`input ${error ? 'has-error' : ''}`}
        disabled={disabled}
        onChange={(e) => {
          if (!onFile(e.target.files?.[0] || null)) e.target.value = '';
        }}
      />
      {file ? (
        <span className="field__hint">
          {file.name} · {fileSize(file.size)}
          {current && ' · replaces the current document'}
        </span>
      ) : current ? (
        <span className="field__hint">
          Current:{' '}
          <a href={api.documentUrl(current.id)} target="_blank" rel="noopener noreferrer">
            {current.name || 'view document'}
          </a>
        </span>
      ) : null}
    </>
  );
}
