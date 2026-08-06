import { useState } from 'react';
import { Modal, Field, Input, Select, Textarea, Combo, Alert } from './ui.jsx';
import { api } from '../lib/api.js';
import { useToast } from './ui.jsx';

/**
 * Every create/edit dialog in the app is this component with a different
 * field list, so all forms validate, report and save identically.
 *
 * A field: { name, label, type, required, options, hint, span, help }
 * type: text | number | money | percent | date | select | combo | textarea | email
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

  const set = (name, value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => (e[name] ? { ...e, [name]: undefined } : e));
  };

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    setErrors({});

    const payload = {};
    for (const field of fields) {
      let value = values[field.name];
      if (field.type === 'percent' && value !== '') value = Number(value) / 100;
      if (field.type === 'boolean') value = value === 'true';
      payload[field.name] = value;
    }

    try {
      const saved = isEdit
        ? await api.update(resource, record.id, payload)
        : await api.create(resource, payload);
      toast(isEdit ? 'Changes saved' : 'Created', 'success');
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
              />
            </div>
          ))}
        </div>
      </form>
    </Modal>
  );
}

function FormField({ field, value, error, onChange }) {
  const common = {
    value: value ?? '',
    error,
    onChange: (e) => onChange(e.target.value),
    disabled: field.disabled,
    placeholder: field.placeholder,
  };

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
    default:
      control = <Input type="text" {...common} />;
  }

  return (
    <Field label={field.label} required={field.required} hint={field.hint} error={error}>
      {control}
    </Field>
  );
}
