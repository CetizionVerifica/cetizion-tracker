import { Alert, Badge, Card, DataTable, Field, Input, Select, useToast } from './ui.jsx';
import { SettingsPane } from '../pages/SettingsArea.jsx';
import { Button } from './ui/button';
import { api } from '../lib/api.js';
import { ago } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';

/**
 * Claude connector (#249): add the tracker to claude.ai with your own
 * sign-in, and see or end the connections you have made.
 *
 * Every role but the travel desk sees its own connections here. An
 * administrator also chooses who may connect and sees everybody's, so a
 * connection can be ended for somebody who has left or lost a laptop.
 */
const WHO = [
  { value: 'admin,sales', label: 'Administrators and sales' },
  { value: 'admin', label: 'Administrators only' },
  { value: 'sales', label: 'Sales only' },
  { value: 'none', label: 'Nobody (switched off)' },
];

export function ClaudeConnector() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const { data, refetch } = useFetch(() => api.raw(`/oauth/grants${isAdmin ? '?all=1' : ''}`), [isAdmin]);
  const url = data?.connector_url;
  const roles = data?.roles ? (data.roles.length ? data.roles.join(',') : 'none') : 'admin,sales';

  const disconnect = (g) => api.raw(`/oauth/grants/${g.id}`, { method: 'DELETE' })
    .then(() => { toast('Disconnected', 'success'); refetch(); })
    .catch((err) => toast(err.message, 'danger'));
  const setRoles = (value) => api.update('settings', 'mcp_connector_roles', { value })
    .then(() => { toast('Saved', 'success'); refetch(); })
    .catch((err) => toast(err.message, 'danger'));

  return (
    <SettingsPane
      title="Claude connector"
      description="Ask Claude about your clients, deals and collections from claude.ai, the Claude desktop app or your phone. Claude signs in as you and sees what you see here, nothing more."
    >
      <Card title="Connect" hint="Once per person. Claude remembers the connection until you disconnect it.">
        <div className="stack">
          {data?.refused && <Alert tone="warning">{data.refused}</Alert>}
          <Field label="Connector address">
            <div className="flex gap-2">
              <Input readOnly className="mono" value={url || 'Set the tracker\'s public address in Settings first'} onFocus={(e) => e.target.select()} />
              <Button variant="secondary" disabled={!url} onClick={() => navigator.clipboard?.writeText(url).then(() => toast('Copied', 'success'))}>Copy</Button>
            </div>
          </Field>
          <ol className="small muted list-decimal pl-5">
            <li>In claude.ai, open Settings → Connectors and choose Add custom connector.</li>
            <li>Name it Cetizion tracker and paste the address above. Leave the advanced settings empty.</li>
            <li>Choose Connect. Sign in here if asked, then Allow. Tick “add notes and tasks” only if you want Claude to write.</li>
          </ol>
        </div>
      </Card>

      {isAdmin && (
        <Card title="Who may connect" hint="Closing a role ends its existing connections on their next call, not only new ones. The travel desk cannot connect yet.">
          <Field label="Allowed">
            <Select value={roles} placeholder={null} options={WHO} onChange={(e) => setRoles(e.target.value)} />
          </Field>
        </Card>
      )}

      <Card flush title={isAdmin ? 'Connections' : 'Your connections'} hint={isAdmin ? 'Everybody\'s, newest use first.' : undefined}>
        <DataTable rows={data?.data ?? []} empty={<div className="small muted px-[18px] py-3">No connections yet.</div>} columns={[
          ...(isAdmin ? [{ key: 'user_name', header: 'Person', className: 'strong' }] : []),
          { key: 'client_name', header: 'App', render: (g) => <>{g.client_name || 'MCP client'}<div className="small muted">{g.app_host}</div></> },
          { key: 'can_write', header: 'May', render: (g) => (g.can_write ? 'Read and write' : 'Read only') },
          { key: 'created_at', header: 'Connected', className: 'small', render: (g) => ago(g.created_at) },
          { key: 'last_used_at', header: 'Last used', className: 'small', render: (g) => (g.last_used_at ? ago(g.last_used_at) : 'never') },
          { key: 'calls', header: 'Calls', align: 'right' },
          { key: 'state', header: '', render: (g) => (g.revoked_at ? <Badge tone="danger">disconnected</Badge> : <Badge tone="success">connected</Badge>) },
          { key: 'act', header: '', align: 'right', render: (g) => !g.revoked_at && <button type="button" className="btn btn--sm btn--ghost" onClick={() => disconnect(g)}>Disconnect</button> },
        ]} />
      </Card>
    </SettingsPane>
  );
}
