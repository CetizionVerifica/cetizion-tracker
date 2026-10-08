import { Archive, Check, ChevronDown, Folder, Inbox as InboxIcon, Send, ShieldAlert, Trash2, Users } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';

/**
 * Which mailbox and folder the list shows (docs/inbox-outlook-plan.md §3.7).
 *
 * The team inboxes first — the triage queue — each on its own (the API's
 * inbox_id), with "All team inboxes" when there is more than one; then each
 * mailbox the person may read, its folders nested as Outlook has them,
 * with Outlook's own unread counts.
 *
 * `value` is { kind: 'team', inboxId? } for the triage view, or
 * { kind: 'folder', accountId, folderId } for a folder. The trigger is the
 * chevron beside the page title, a labelled button of its own.
 */
const FOLDER_ICON = { inbox: InboxIcon, sentitems: Send, archive: Archive, deleteditems: Trash2, junkemail: ShieldAlert };

/** The folders as a flat list in tree order, each with its depth, so the menu can indent them. */
export function flattenFolders(folders = []) {
  const byParent = new Map();
  const ids = new Set(folders.map((f) => f.folder_id));
  for (const f of folders) {
    // A child whose parent is not listed sits at the top level rather than disappearing with it.
    const parent = f.parent_id && ids.has(f.parent_id) ? f.parent_id : null;
    byParent.set(parent, [...(byParent.get(parent) || []), f]);
  }
  const out = [];
  const walk = (parent, depth) => {
    for (const f of byParent.get(parent) || []) {
      out.push({ ...f, depth });
      walk(f.folder_id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** "My mailbox" for the person's own; a colleague's or a shared one by its name. */
export const mailboxLabel = (box) => (box.mine ? 'My mailbox' : box.display_name || box.email);

/** The team inboxes this person can see, one per mailbox that feeds one. */
export const teamInboxes = (mailboxes = []) => mailboxes.filter((b) => b.inbox).map((b) => ({ id: b.inbox.id, name: b.inbox.name, email: b.email }));

/** What the title reads: the team inbox's name, or "My mailbox · Inbox". */
export function selectionLabel(value, mailboxes = []) {
  if (!value || value.kind !== 'folder') {
    const teams = teamInboxes(mailboxes);
    const picked = teams.find((t) => String(t.id) === String(value?.inboxId));
    if (picked) return `${picked.name} (team)`;
    if (teams.length === 1) return `${teams[0].name} (team)`;
    return teams.length ? 'All team inboxes' : 'Inbox';
  }
  const box = mailboxes.find((b) => String(b.id) === String(value.accountId));
  const folder = box?.folders?.find((f) => f.folder_id === value.folderId || f.well_known === value.folderId);
  return `${box ? mailboxLabel(box) : 'Mailbox'} · ${folder?.display_name || value.folderId}`;
}

function Item({ icon: Icon, label, count, on, indent = 0, onSelect }) {
  return (
    <DropdownMenuItem
      role="menuitemradio"
      aria-checked={on}
      data-on={on}
      onSelect={onSelect}
      className="app-switch__item"
      style={indent ? { paddingLeft: `${12 + indent * 14}px` } : undefined}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count > 0 && <span className="app-switch__count mg-num">{count}</span>}
      {on && <Check className="app-switch__tick size-4 shrink-0" strokeWidth={2} aria-hidden="true" />}
    </DropdownMenuItem>
  );
}

export function MailboxSwitcher({ mailboxes = [], value, onChange, teamCount }) {
  const teams = teamInboxes(mailboxes);
  const isTeam = !value || value.kind !== 'folder';
  const pickedInbox = isTeam && value?.inboxId ? String(value.inboxId) : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="mg-iconbtn" aria-label="Choose a mailbox and folder" title="Choose a mailbox and folder">
          <ChevronDown className="size-[18px]" strokeWidth={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="app-switch overflow-y-auto" aria-label="Mailboxes and folders">
        <DropdownMenuLabel className="app-switch__head"><span>Team inboxes</span></DropdownMenuLabel>
        {teams.length > 1 && (
          <Item icon={Users} label="All team inboxes" on={isTeam && !pickedInbox} count={!pickedInbox ? teamCount : 0} onSelect={() => onChange({ kind: 'team' })} />
        )}
        {teams.map((t) => (
          <Item
            key={`team-${t.id}`}
            icon={Users}
            label={`${t.name} (team)`}
            on={isTeam && (pickedInbox === String(t.id) || (teams.length === 1 && !pickedInbox))}
            count={pickedInbox === String(t.id) || teams.length === 1 ? teamCount : 0}
            onSelect={() => onChange(teams.length === 1 ? { kind: 'team' } : { kind: 'team', inboxId: t.id })}
          />
        ))}
        {!teams.length && <Item icon={Users} label="Team inbox" on={isTeam} onSelect={() => onChange({ kind: 'team' })} />}
        {mailboxes.map((b) => {
          const folders = flattenFolders(b.folders);
          return (
            <div key={b.id} role="group" aria-label={mailboxLabel(b)}>
              <DropdownMenuLabel className="app-switch__head" title={b.email}>
                <span>{mailboxLabel(b)}</span>
                <span>{b.email}{b.is_shared ? ' · shared' : ''}</span>
              </DropdownMenuLabel>
              {!folders.length && (
                <p className={b.status === 'active' ? 'app-switch__note' : 'app-switch__note is-warn'}>
                  {b.status === 'active'
                    ? 'Folders appear after the first sync.'
                    : `This mailbox needs to be reconnected${b.mine ? ' from Settings › My mailbox' : ''}.`}
                </p>
              )}
              {folders.map((f) => {
                const active = value?.kind === 'folder' && String(value.accountId) === String(b.id) && (value.folderId === f.folder_id || value.folderId === f.well_known);
                return (
                  <Item
                    key={f.folder_id}
                    icon={FOLDER_ICON[f.well_known] || Folder}
                    label={f.display_name}
                    count={f.unread_count}
                    on={active}
                    indent={f.depth}
                    onSelect={() => onChange({ kind: 'folder', accountId: b.id, folderId: f.well_known || f.folder_id })}
                  />
                );
              })}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
