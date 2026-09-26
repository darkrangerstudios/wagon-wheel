'use strict';
// "A separate copy": a real git repository in a temp folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const copyMode = require('../src/copyMode');
// Throwaway repositories: never the person's git config (their commit signing would wait on a prompt).
process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1';

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-copy-')));
  fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'alpha\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir }); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'files'], { cwd: dir });
  return dir;
}

test('a copy is a new branch in its own folder; the person\'s folder is untouched', async () => {
  const r = repo(), store = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-store-'));
  assert.strictEqual(await copyMode.repoRoot(path.join(r, 'sub')), r);
  assert.strictEqual(await copyMode.repoRoot(store), null);
  const copy = await copyMode.create({ repo: r, dir: path.join(store, 'copy'), branch: copyMode.branchName('Fix login!', 'ab12cd34-ef') });
  assert.strictEqual(copy.branch, 'wagon-wheel/fix-login-ab12cd34');
  assert.strictEqual(copyMode.mapPath(path.join(r, 'sub'), copy), path.join(copy.dir, 'sub'));
  assert.strictEqual(copyMode.mapPath('/elsewhere', copy), '/elsewhere');
  fs.writeFileSync(path.join(copy.dir, 'sub', 'a.txt'), 'omega\n');
  assert.deepStrictEqual(await copyMode.changes(copy), { files: ['sub/a.txt'], commits: 0 });
  assert.strictEqual(fs.readFileSync(path.join(r, 'sub', 'a.txt'), 'utf8'), 'alpha\n');
  // The commands the person runs bring the change in, then remove the copy.
  execFileSync('/bin/sh', ['-c', copyMode.bringInCommand(copy, "Dean's room").replace('git commit', 'git -c user.email=t@t -c user.name=t commit').replace('git merge', 'git -c user.email=t@t -c user.name=t merge')]);
  assert.strictEqual(fs.readFileSync(path.join(r, 'sub', 'a.txt'), 'utf8'), 'omega\n');
  execFileSync('/bin/sh', ['-c', copyMode.removeCommand(copy)]);
  assert.ok(!fs.existsSync(copy.dir));
});

test('a repository with no commits cannot be copied, and says why', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-empty-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  await assert.rejects(copyMode.create({ repo: dir, dir: path.join(dir, '..', path.basename(dir) + '-copy'), branch: 'wagon-wheel/x' }), /no commits yet/);
});

test('within() compares real paths', () => {
  const r = repo();
  assert.ok(copyMode.within(path.join(r, 'sub', 'a.txt'), r));
  assert.ok(!copyMode.within(path.join(r, '..', 'other'), r));
  assert.ok(!copyMode.within('/etc/passwd', r));
});
