'use strict';
// v0.8.0 (Kestrel P1-1, P2-1): which files an editing agent may touch, decided before any card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const policy = require('../src/editPolicy');
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p)); // deliberately NOT realpath'd: macOS /var -> /private/var

test('a file that doesn\'t exist yet is resolved through its nearest existing folder, symlinks included', () => {
  const root = tmp('ww-pol-'), out = tmp('ww-out-');
  fs.symlinkSync(out, path.join(root, 'link'));
  assert.ok(policy.within(path.join(root, 'new', 'deep.txt'), root), 'a new file in the folder, even via /var -> /private/var');
  assert.ok(!policy.within(path.join(root, 'link', 'new.txt'), root), 'a symlinked subfolder pointing outside is outside');
  const linkedRoot = path.join(tmp('ww-lr-'), 'room'); fs.symlinkSync(root, linkedRoot);
  assert.ok(policy.within(path.join(linkedRoot, 'x.txt'), root) && policy.within(path.join(root, 'x.txt'), linkedRoot), 'a room folder reached through a symlink still contains its files');
  assert.ok(!policy.within(path.join(root, '..', 'sibling.txt'), root));
});

test('git\'s own folder is refused; files that can run code always ask; no known files is refused', async () => {
  const root = tmp('ww-git-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dirs = await policy.gitDirs(root);
  assert.ok(dirs.length >= 1 && dirs.every((d) => d.endsWith('.git')));
  assert.match(policy.check([path.join(root, '.git', 'config')], root, dirs).refused, /git's own folder/);
  assert.match(policy.check([path.join(root, 'sub', '.git', 'hooks', 'pre-commit')], root, dirs).refused, /git's own folder/, 'a nested .git too');
  assert.match(policy.check(['/etc/hosts'], root, dirs).refused, /outside its folder/);
  assert.match(policy.check([], root, dirs).refused, /couldn't see which files/);
  for (const f of ['.vscode/tasks.json', '.husky/pre-commit', 'package.json', 'AGENTS.md', 'CLAUDE.md', '.github/workflows/ci.yml', '.envrc']) {
    const v = policy.check([path.join(root, f)], root, dirs);
    assert.strictEqual(v.refused, null, f); assert.match(v.sensitive, /can run code/, f);
  }
  assert.deepStrictEqual(policy.check([path.join(root, 'src', 'a.js')], root, dirs), { refused: null, sensitive: null });
});

test('in a separate copy, the person\'s git folder is outside the copy and the copy\'s .git file is refused', async () => {
  const repo = fs.realpathSync(tmp('ww-crepo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo }); fs.writeFileSync(path.join(repo, 'a'), 'a');
  execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: repo });
  const copy = await require('../src/copyMode').create({ repo, dir: path.join(tmp('ww-cstore-'), 'copy'), branch: 'wagon-wheel/t' });
  const dirs = await policy.gitDirs(copy.dir);
  assert.match(policy.check([path.join(copy.dir, '.git')], copy.dir, dirs).refused, /git's own folder/);
  assert.match(policy.check([path.join(repo, '.git', 'config')], copy.dir, dirs).refused, /outside its folder|git's own folder/);
  assert.strictEqual(policy.check([path.join(copy.dir, 'a')], copy.dir, dirs).refused, null);
});

test('case does not matter: .GIT is .git, .VSCODE is .vscode, Package.json is package.json', async () => {
  const root = tmp('ww-case-');
  execFileSync('git', ['init', '-q'], { cwd: root }); fs.mkdirSync(path.join(root, '.vscode'));
  const dirs = await policy.gitDirs(root);
  const ci = fs.existsSync(path.join(root, '.GIT')); // a case-insensitive disk (macOS default)
  for (const p of ['.GIT/config', '.Git/hooks/pre-commit', '.gIt']) assert.match(policy.check([path.join(root, p)], root, dirs).refused || '', /git's own folder/, p);
  for (const p of ['.VSCODE/tasks.json', 'Package.json', 'claude.md', '.Husky/pre-commit']) assert.ok(policy.check([path.join(root, p)], root, dirs).sensitive, p);
  if (ci) assert.strictEqual(policy.resolveReal(path.join(root, '.GIT', 'config')), path.join(fs.realpathSync(root), '.git', 'config'), 'the on-disk name');
});

test('symlinks the way the OS resolves them: a dangling link pointing out is outside; link/.. is the target\'s parent', () => {
  const root = tmp('ww-sym-'), out = tmp('ww-symout-');
  fs.symlinkSync(path.join(out, 'not-yet.txt'), path.join(root, 'dang'));
  assert.ok(!policy.within(path.join(root, 'dang'), root), 'writing through a dangling link would create a file outside');
  fs.mkdirSync(path.join(out, 'sub'));
  fs.symlinkSync(path.join(out, 'sub'), path.join(root, 'link'));
  assert.ok(!policy.within(`${root}/link/../x.txt`, root), 'link/.. is the parent of the link\'s target');
  assert.strictEqual(policy.check(['link/../x.txt'], root).refused, 'outside its folder', 'relative paths are not folded as text first');
  assert.ok(policy.within(`${root}/a/../b.txt`, root), 'plain .. inside the folder is fine');
  fs.symlinkSync('loop', path.join(root, 'loop'));
  assert.doesNotThrow(() => policy.resolveReal(path.join(root, 'loop', 'x')));
});
