'use strict';
// What an agent asks to do, as the approval card a person reads (Room.requestApproval renders and records it).

// Claude Code's permission request as an approval card: what it wants to change, in the words a person reads.
function claudeCard({ tool, input = {}, description, blockedPath = null }, rel) {
  const lines = (s, sign) => String(s || '').split('\n').map((l) => `${sign} ${l}`).join('\n');
  if (tool === 'Bash') return { kind: 'command', command: String(input.command || ''), reason: description || input.description || '', title: `Run: ${String(input.command || '').replace(/\s+/g, ' ').slice(0, 160)}`, paths: blockedPath ? [blockedPath] : [] };
  const file = input.file_path || input.notebook_path || '';
  // blocked_path: the file Claude Code says the request touches; checked with the rest.
  const also = (x) => ({ ...x, paths: x.paths.concat(blockedPath && !x.paths.includes(blockedPath) ? [blockedPath] : []) });
  if (tool === 'Edit') return also({ kind: 'edit', paths: [file], title: `Edit ${rel(file)}${input.replace_all ? ' (every match in the file)' : ''}`, detail: `${input.replace_all ? '# Replaces EVERY occurrence of the text below\n' : ''}${lines(input.old_string, '-')}\n${lines(input.new_string, '+')}` });
  if (tool === 'Write') return also({ kind: 'edit', paths: [file], title: `Create or replace ${rel(file)}`, detail: lines(input.content, '+') });
  // NotebookEdit: say which cell and what happens to it; a delete is named as one.
  const cell = input.cell_id ? ` cell ${input.cell_id}` : ' a cell';
  const op = input.edit_mode === 'delete' ? `Delete${cell} in notebook` : input.edit_mode === 'insert' ? `Insert a new cell${input.cell_id ? ` after cell ${input.cell_id}` : ''} in notebook` : `Replace${cell} in notebook`;
  return also({ kind: 'edit', paths: [file], title: `${op} ${rel(file)}`, detail: input.edit_mode === 'delete' ? `# Deletes${cell}` : lines(input.new_source, '+') });
}

// Codex's approval request: a file change (its paths and diff; grantRoot is a folder it wants to write to, checked like
// a path) or a command it wants to run outside its read-only sandbox.
function codexCard(req, rel) {
  // The directory the command runs in is part of what you approve: shown on the card, and checked like a path.
  if (req.kind === 'command') return { kind: 'command', command: req.command, reason: req.reason, cwd: req.cwd || null, paths: req.cwd ? [req.cwd] : [], title: `Run outside the sandbox: ${String(req.command || '').replace(/\s+/g, ' ').slice(0, 160)}` };
  const paths = (req.paths || []).concat(req.grantRoot ? [req.grantRoot] : []);
  const say = (c) => (c.to ? `Move ${rel(c.path)} to ${rel(c.to)}` : c.type === 'add' ? `Create ${rel(c.path)}` : c.type === 'delete' ? `Delete ${rel(c.path)}` : `Edit ${rel(c.path)}`);
  const changes = req.changes || (req.paths || []).map((p) => ({ path: p }));
  // A change the room never saw is refused whatever else it names; a request to write to a whole folder (grantRoot)
  // is never covered by "Allow edits for this task".
  return { kind: 'edit', paths, detail: req.diff || '', reason: req.reason, title: changes.map(say).join(', ') || 'Change files',
    ...(!changes.length ? { refused: 'Wagon Wheel couldn\'t see which files it would change' } : {}), ...(req.grantRoot ? { noRule: true } : {}) };
}

module.exports = { claudeCard, codexCard };
