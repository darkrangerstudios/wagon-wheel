'use strict';
// "A separate copy": the room's agents work on their own git branch in a worktree kept in Wagon Wheel's storage, so
// the person's folder is untouched until they bring the changes in themselves. Wagon Wheel creates the copy; it never
// merges into the person's folder or deletes the copy: it gives the commands, and the person runs them.
const { execFile } = require('child_process');
const fs = require('fs'), path = require('path');

function git(cwd, args, timeout = 20000) {
  return new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args], { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().split('\n')[0] || 'git failed')) : resolve(String(out).replace(/\s+$/, '')))));
}

const { resolveReal: real, within } = require('./editPolicy');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The repository a folder belongs to, or null (not a git folder, or git missing).
async function repoRoot(dir) { try { return real(await git(dir, ['rev-parse', '--show-toplevel'])); } catch { return null; } }

function branchName(roomName, roomId) {
  const s = String(roomName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'room';
  return `wagon-wheel/${s}-${String(roomId).replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
}

// A new branch at the repository's current commit, checked out in dir. Uncommitted changes in the person's folder
// are not in it (git copies commits, not the working tree): the Start screen says so.
async function create({ repo, dir, branch }) {
  let base;
  try { base = await git(repo, ['rev-parse', '--verify', 'HEAD']); } catch { throw new Error('its git repository has no commits yet, so there is nothing to copy. Commit once, or let agents edit your folder instead'); }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, dir, base], 60000);
  return { repo, dir: real(dir), branch, base };
}

// Where a folder inside the repository lives in the copy.
function mapPath(p, copy) { return within(p, copy.repo) ? path.join(copy.dir, path.relative(real(copy.repo), real(p))) : p; }

// What changed in the copy since it was made: uncommitted files and commits on its branch.
async function changes(copy) {
  const [status, commits] = await Promise.all([git(copy.dir, ['status', '--porcelain']), git(copy.dir, ['rev-list', '--count', `${copy.base}..HEAD`])]);
  const files = status ? status.split('\n').map((l) => l.slice(3)).filter(Boolean) : [];
  return { files, commits: Number(commits) || 0 };
}

// Commands the person runs themselves: bring the copy's changes into their folder, and remove the copy afterwards.
function bringInCommand(copy, roomName) {
  return `cd ${q(copy.dir)} && git add -A && (git diff --cached --quiet || git commit -m ${q(`Wagon Wheel: ${roomName}`)}) && cd ${q(copy.repo)} && git merge --no-ff ${q(copy.branch)}`;
}
function removeCommand(copy) { return `git -C ${q(copy.repo)} worktree remove ${q(copy.dir)} && git -C ${q(copy.repo)} branch -D ${q(copy.branch)}`; }

module.exports = { repoRoot, branchName, create, mapPath, changes, bringInCommand, removeCommand, within, git };
