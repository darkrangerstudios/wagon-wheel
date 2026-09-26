'use strict';
// Which files an editing agent may touch, decided by the host before any card is shown.
// - Outside the agent's folder: refused.
// - Inside git's own folder (.git, or the repository's git directories): refused. An edit there can run commands
//   (core.fsmonitor, core.hooksPath, hooks), which would turn "edit files" into "run commands" with no command card.
// - Files that can run code or change how your tools behave (editor tasks, git hooks, agent instructions, package
//   scripts): always a card, never covered by "Allow edits for this task", and the card says why.
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');

// The real path of a file that may not exist yet, resolved the way the operating system will: one segment at a time.
// A symlink is followed even when its target doesn't exist yet (writing through a dangling link creates the target),
// ".." applies after the links before it are resolved (link/.. is the parent of the link's target, not of the link),
// and existing folders take their on-disk name (realpathSync.native), so on a case-insensitive disk .GIT is .git.
const abs = (root, p) => (path.isAbsolute(String(p)) ? String(p) : `${root}${path.sep}${p}`); // no textual ".." folding
function resolveReal(p) {
  const queue = String(path.isAbsolute(String(p)) ? p : `${process.cwd()}${path.sep}${p}`).split(path.sep).filter(Boolean);
  let cur = path.parse(path.resolve('/')).root, hops = 0;
  while (queue.length) {
    const seg = queue.shift();
    if (seg === '.') continue;
    if (seg === '..') { cur = path.dirname(cur); continue; }
    const next = path.join(cur, seg);
    let st = null; try { st = fs.lstatSync(next); } catch { /* not there yet */ }
    if (st && st.isSymbolicLink()) {
      if (++hops > 40) return next; // a loop: treat the link itself as the path
      const target = fs.readlinkSync(next);
      queue.unshift(...target.split(path.sep).filter(Boolean));
      if (path.isAbsolute(target)) cur = path.parse(path.resolve('/')).root;
      continue;
    }
    if (st) { try { cur = fs.realpathSync.native(next); continue; } catch { /* raced away */ } }
    cur = next;
  }
  return cur;
}

function within(p, root) {
  const r = path.relative(resolveReal(root), resolveReal(p));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

// Names compare case-insensitively (and NFC-normalized): on the default macOS and Windows disks .VSCODE is .vscode.
const fold = (s) => String(s).normalize('NFC').toLowerCase();
const SENSITIVE_DIRS = new Set(['.vscode', '.husky', '.claude', '.codex', '.github', '.devcontainer', '.idea'].map(fold));
const SENSITIVE_FILES = new Set(['.envrc', '.env', 'AGENTS.md', 'CLAUDE.md', '.gitattributes', '.gitmodules', '.gitignore', 'package.json', '.npmrc', 'Makefile', '.pre-commit-config.yaml', '.mcp.json'].map(fold));

// git's own folders for a working folder, real paths; [] when it isn't a repository. Cached per folder.
const gitCache = new Map();
function gitDirs(root) {
  if (gitCache.has(root)) return gitCache.get(root);
  const p = new Promise((resolve) => execFile('git', ['-C', root, 'rev-parse', '--absolute-git-dir', '--git-common-dir'], { timeout: 10000, encoding: 'utf8' },
    (e, out) => resolve(e ? [] : String(out).split('\n').map((x) => x.trim()).filter(Boolean).map((x) => resolveReal(path.resolve(root, x))))));
  gitCache.set(root, p); if (gitCache.size > 50) gitCache.delete(gitCache.keys().next().value);
  return p;
}

// { refused: reason | null, sensitive: reason | null } for the paths a request would change.
function check(paths, root, dirs = []) {
  if (!paths.length) return { refused: 'Wagon Wheel couldn\'t see which files it would change', sensitive: null };
  let sensitive = null;
  const realRoot = resolveReal(root);
  const inside = (real, base) => { const r = path.relative(base, real); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  for (const raw of paths) {
    const real = resolveReal(abs(root, raw)); // resolved once per path
    if (!inside(real, realRoot)) return { refused: 'outside its folder', sensitive: null };
    const rel = path.relative(realRoot, real), parts = rel.split(path.sep).map(fold);
    if (parts.includes('.git') || dirs.some((d) => inside(real, d))) return { refused: 'inside git\'s own folder, where an edit can run commands', sensitive: null };
    if (SENSITIVE_DIRS.has(parts[0]) || SENSITIVE_FILES.has(parts[parts.length - 1])) sensitive = sensitive || `${rel} can run code or change how your tools behave`;
  }
  return { refused: null, sensitive };
}

module.exports = { resolveReal, within, gitDirs, check, abs, SENSITIVE_DIRS, SENSITIVE_FILES };
