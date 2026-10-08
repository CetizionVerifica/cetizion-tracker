import { Archive, ChevronDown, Folder, Inbox as InboxIcon, Send, ShieldAlert, Trash2, Users } from 'lucide-react';
import { cn } from 'cn';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';

/**
 * Which mailbox and folder the list shows (docs/inbox-outlook-plan.md §3.7).
 *
 * The team's shared inbox first — the triage queue, as the page has always
 * been — then each mailbox the person may read with its folders as Outlook
 * has them, nested, with Outlook's own unread counts. A sales user sees
 * their own mailbox ("My mailbox") and the shared ones they are named on;
 * an admin sees every mailbox's folder list.
 *
 * `value` is { kind: 'team' } for the triage view, or
 * { kind: 'folder', accountId, folderId } for a folder.
 */
const FOLDER_ICON = { inbox: InboxIcon, sentitems: Send, archive: Archive, deleteditems: Trash2, junkemail: ShieldAlert };

/** The folders as a flat list in tree order, each with its depth, so the menu can indent them. */
export function flattenFolders(folders = []) {
  const byParent = new Map();
  const ids = new Set(folders.map((f) => f.folder_id));
  for (const f of folders) {
    // A child whose parent is not listed (a well-known root, or a hidden
    // one) sits at the top level rather than disappearing with it.
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

/** "My mailbox" for the person's own; a colleague's or a shared one by its name, the address in the tooltip. */
export const mailboxLabel = (box) => (box.mine ? 'My mailbox' : box.display_name || box.email);

/** What the trigger reads: the team inbox's name, or "My mailbox · Inbox". */
export function selectionLabel(value, mailboxes = []) {
  if (!value || value.kind !== 'folder') {
    const team = mailboxes.find((b) => b.inbox);
    return team?.inbox?.name ? `${team.inbox.name} (team)` : 'Inbox';
  }
  const box = mailboxes.find((b) => String(b.id) === String(value.accountId));
  const folder = box?.folders?.find((f) => f.folder_id === value.folderId || f.well_known === value.folderId);
  return `${box ? mailboxLabel(box) : 'Mailbox'} · ${folder?.display_name || value.folderId}`;
}

export function MailboxSwitcher({ mailboxes = [], value, onChange, className }) {
  const teams = mailboxes.filter((b) => b.inbox);
  const label = selectionLabel(value, mailboxes);
  const isTeam = !value || value.kind !== 'folder';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Choose a mailbox and folder"
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[18px] font-semibold tracking-[-0.018em] text-foreground transition-colors duration-150 hover:bg-secondary',
            className
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-72 overflow-y-auto">
        {teams.map((b) => (
          <DropdownMenuItem key={`team-${b.id}`} onSelect={() => onChange({ kind: 'team' })} className={cn(isTeam && 'bg-primary/10 text-primary')}>
            <Users className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{b.inbox.name} <span className="text-muted-foreground">(team)</span></span>
          </DropdownMenuItem>
        ))}
        {!teams.length && (
          <DropdownMenuItem onSelect={() => onChange({ kind: 'team' })} className={cn(isTeam && 'bg-primary/10 text-primary')}>
            <Users className="size-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Team inbox</span>
          </DropdownMenuItem>
        )}
        {mailboxes.map((b) => {
          const folders = flattenFolders(b.folders);
          return (
            <div key={b.id}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="truncate text-[11.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground" title={b.email}>
                {mailboxLabel(b)}
              </DropdownMenuLabel>
              {!folders.length && (
                <div className="px-2 pb-1.5 text-[12px] text-muted-foreground">
                  {b.status === 'active' ? 'Folders appear after the first sync.' : 'This mailbox needs to be reconnected.'}
                </div>
              )}
              {folders.map((f) => {
                const Icon = FOLDER_ICON[f.well_known] || Folder;
                const active = value?.kind === 'folder' && String(value.accountId) === String(b.id) && (value.folderId === f.folder_id || value.folderId === f.well_known);
                return (
                  <DropdownMenuItem
                    key={f.folder_id}
                    onSelect={() => onChange({ kind: 'folder', accountId: b.id, folderId: f.well_known || f.folder_id })}
                    className={cn(active && 'bg-primary/10 text-primary')}
                    style={{ paddingLeft: `${8 + f.depth * 14}px` }}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{f.display_name}</span>
                    {f.unread_count > 0 && <span className="num shrink-0 text-[12px] font-medium text-primary">{f.unread_count}</span>}
                  </DropdownMenuItem>
                );
              })}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
