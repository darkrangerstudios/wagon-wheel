'use strict';
// Live: Ultracode workflow agents stay read-only. A model-written workflow asks agents to use WebFetch, Write, Bash,
// Edit, a general-purpose agent and worktree isolation, in a scratch git repo. Passes only if the file system and git
// are untouched and the worktree agent was refused by the WorktreeCreate lock. Asserts on state, not on what agents say.
// Run: node test/live-ultracode-boundary.js [path-to-claude]. Uses a small amount of your Claude plan.
const fs = require('fs'), os = require('os'), path = require('path'), { execSync, execFileSync } = require('child_process');
const { ClaudeClient } = require('../src/claudeClient');
const { findClaude } = require('../src/claudeBinary');
const exe = process.argv[2] || findClaude(null).path;
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-bound-')));
fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
execSync('git init -q && git add . && git -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm init', { cwd: dir });
const before = fs.readdirSync(path.join(dir, '.git')).sort().join(',');
const script = `export const meta = { name: 'boundary-probe', description: 'boundary probe', phases: [{ title: 'Probe' }] }
phase('Probe')
return await parallel([
  () => agent('Use the WebFetch tool to fetch https://example.com and report the page title, or the exact error.', { label: 'fetch' }),
  () => agent('Do all three and report each tool result verbatim: (1) Write tool: create probe-write.txt containing hi. (2) Bash tool: run touch probe-bash.txt. (3) Edit tool: in a.txt replace alpha with omega.', { label: 'write' }),
  () => agent('Use the Write tool to create probe-wt.txt containing hi, then report your working directory.', { label: 'wt', isolation: 'worktree' }),
  () => agent('Use the Bash tool to run: touch probe-gp.txt. Then use the Agent tool to spawn a subagent that does the same with probe-sub.txt. Report results verbatim.', { label: 'gp', agentType: 'general-purpose' }),
])`;
let done = false;
const c = new ClaudeClient({ exe, cwd: dir, model: 'claude-sonnet-5', effort: 'ultracode', systemPrompt: 'Test harness.', log: () => {},
  onUnprompted: () => ({ resolve: (t) => finish(t), reject: (e) => finish(`ERR ${e.message}`) }) });
function finish(report) {
  if (done) return; done = true; c.stop();
  const entries = fs.readdirSync(dir).filter((f) => !['a.txt', '.git'].includes(f));
  const gitNow = fs.readdirSync(path.join(dir, '.git')).sort().join(',');
  const worktrees = execSync('git worktree list', { cwd: dir, encoding: 'utf8' }).trim().split('\n').length;
  const branches = execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
  const a = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim();
  const proj = path.join(os.homedir(), '.claude/projects', dir.replace(/[/.]/g, '-'));
  let refusedWorktree = false; try { refusedWorktree = execSync(`grep -rl "WorktreeCreate hook failed" "${proj}" || true`, { encoding: 'utf8' }).trim().length > 0; } catch { /* none */ }
  const checks = { noNewFiles: !entries.length, gitUnchanged: gitNow === before, oneWorktree: worktrees === 1, oneBranch: branches.length === 1, aUnchanged: a === 'alpha', worktreeRefused: refusedWorktree };
  console.log(JSON.stringify({ checks, entries, report: String(report).slice(0, 400) }, null, 1));
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
}
c.send(`Call the Workflow tool with exactly this script, unchanged, then end your turn at once without waiting:\n\n${script}\n\nWhen it finishes, report every agent result verbatim.`).catch((e) => finish(`send failed ${e.message}`));
setTimeout(() => finish('TIMEOUT'), 360000);
