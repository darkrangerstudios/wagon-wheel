'use strict';
// Slash commands the room understands, grouped by platform. The room runs them itself on each agent's
// real controls; the CLIs' interactive slash commands don't exist in headless mode.

// Picker catalogue: Claude Code's own model menu when the CLI reports it (claudeModels.query), otherwise the same
// native text built in. Tier order, Default (recommended) first. minCli: the Claude Code version that can run it.
const claudeModels = require('./claudeModels');
const CLAUDE_CATALOG = claudeModels.FALLBACK;
const CLAUDE_MODELS = [...CLAUDE_CATALOG.map((m) => m.id), 'sonnet', 'opus', 'haiku'];
const CLAUDE_EFFORTS = claudeModels.EFFORTS;

// New rooms pass { participants: [{id,label,provider}], controls: { [id]: {models,model,efforts} } }.
// The legacy {codexModels, codexModel} form remains supported.
function specs(ctx = {}) {
  if (Array.isArray(ctx.participants)) return participantSpecs(ctx);
  const models = ctx.codexModels || [];
  const current = models.find((m) => m.id === ctx.codexModel) || models[0];
  const codexEfforts = current ? current.supportedReasoningEfforts.map((e) => e.reasoningEffort) : [];
  return [
    { group: 'Room', cmd: '/help', desc: 'List commands' },
    { group: 'Room', cmd: '/stop', desc: 'Stop both agents and cancel hand-offs' },
    { group: 'Room', cmd: '/default', args: ['claude', 'codex', 'both'], desc: 'Who answers a message with no @mention' },
    { group: 'Room', cmd: '/both', args: ['sequential', 'parallel'], desc: 'How @both works: take turns, or answer at once' },
    { group: 'Room', cmd: '/history add', desc: 'Add a local Claude Code session or Codex thread as reference both agents can read (local only)' },
    { group: 'Room', cmd: '/history remove', desc: 'Stop sharing a history source' },
    { group: 'Room', cmd: '/history all', desc: 'Include a shared source\'s earlier history (on) or only what is said from now on (off): /history all <h1|claude|codex> on|off' },
    { group: 'Room', cmd: '/history share', args: ['claude on', 'claude off', 'codex on', 'codex off'], desc: 'Let the other agent read an agent\'s conversation (it can\'t change it)' },
    { group: 'Claude', cmd: '/claude model', args: CLAUDE_MODELS, allowAnyArg: true, desc: 'Switch Claude model (restarts on the same session)' },
    { group: 'Claude', cmd: '/claude effort', args: CLAUDE_EFFORTS, desc: 'Claude effort: how hard the model tries' },
    { group: 'Claude', cmd: '/claude fast', args: ['on', 'off'], desc: 'Opus fast mode, ~2.5x faster; billed to usage credits' },
    { group: 'Claude', cmd: '/claude compact', desc: 'Summarize Claude\'s context to free space' },
    { group: 'Codex', cmd: '/codex model', args: models.map((m) => m.id), desc: 'Switch Codex model (applies from the next turn)' },
    { group: 'Codex', cmd: '/codex effort', args: codexEfforts, desc: `Codex reasoning effort${current ? ` for ${current.id}` : ''}` },
    { group: 'Codex', cmd: '/codex fast', args: ['on', 'off'], desc: 'Priority tier: faster, uses more of your Codex quota' },
    { group: 'Codex', cmd: '/codex compact', desc: 'Summarize Codex\'s thread to free space' }
  ];
}

function participantSpecs({ participants, controls = {} }) {
  const ids = participants.map((p) => p.id);
  const room = specs().filter((s) => s.group === 'Room');
  room.find((s) => s.cmd === '/stop').desc = 'Stop all agents and cancel hand-offs';
  room.find((s) => s.cmd === '/default').args = [...ids, 'both'];
  room.find((s) => s.cmd === '/history add').desc = 'Add a local Claude Code session or Codex thread as shared reference (local only)';
  room.find((s) => s.cmd === '/history all').desc = `Include a shared source's earlier history (on) or only what is said from now on (off): /history all <h1|${ids.join('|')}> on|off`;
  const share = room.find((s) => s.cmd === '/history share');
  share.args = ids.flatMap((source) => [
    ...['on', 'off'].map((value) => `${source} ${value}`),
    ...ids.filter((reader) => reader !== source).flatMap((reader) => ['on', 'off'].map((value) => `${source} ${reader} ${value}`))
  ]);
  share.desc = 'Let agents read each other\'s conversations: <agent> <reader> on|off; leave out the reader to share with everyone';
  return room.concat(participants.filter((p) => ['claude', 'codex'].includes(p.provider)).flatMap((p) => {
    const control = controls[p.id] || {};
    const models = Array.isArray(control.models) ? control.models : p.provider === 'claude' ? CLAUDE_CATALOG : [];
    const current = models.find((m) => m.id === control.model) || models[0];
    const effortValues = control.efforts || (current && (current.efforts || current.supportedReasoningEfforts)) || (p.provider === 'claude' ? CLAUDE_EFFORTS : []);
    const efforts = Array.isArray(effortValues) ? effortValues.map((e) => typeof e === 'string' ? e : e.reasoningEffort).filter(Boolean) : [];
    const command = (action, options) => ({ group: p.label || p.id, cmd: `/${p.id} ${action}`,
      participant: p.id, action, provider: p.provider, ...options });
    return [
      command('model', { args: models.map((m) => m.id), ...(p.provider === 'claude' ? { allowAnyArg: true } : {}),
        desc: p.provider === 'claude' ? 'Switch Claude model (restarts on the same session)' : 'Switch Codex model (applies from the next turn)' }),
      command('effort', { args: efforts, desc: `Thinking effort for ${p.label || p.id}${current ? ` (${current.id})` : ''}` }),
      command('fast', { args: ['on', 'off'], desc: p.provider === 'claude' ? 'Opus fast mode; billed to usage credits' : 'Priority tier: faster, uses more of your Codex quota' }),
      command('compact', { desc: `Summarize ${p.label || p.id}'s conversation to free up space` }),
      command('session', { args: ['new', 'switch', 'continue', 'fork'], desc: `Start ${p.label || p.id} over (new), or switch it to one of your conversations (switch asks copy or original)` }),
      command('access', { args: ['read', 'edit', 'run'], desc: `What ${p.label || p.id} may do: read only, edit files, or edit files and run commands (each edit and command asks you first)` }),
      command('mode', { args: ['ask', 'auto', 'bypass'], desc: `How ${p.label || p.id}'s edits are answered: ask you each time, auto-accept edits, or bypass (edits and commands without asking; needs the Allow Bypass setting)` })
    ];
  }));
}

// Longest matching command wins; the rest of the line is the argument.
function parse(text, list) {
  const t = String(text).trim().replace(/\s+/g, ' ');
  const hit = list.filter((s) => t === s.cmd || t.startsWith(s.cmd + ' ')).sort((a, b) => b.cmd.length - a.cmd.length)[0];
  if (!hit) return { error: `Unknown command "${t.split(' ').slice(0, 2).join(' ')}". Type /help for the list.` };
  const arg = t.slice(hit.cmd.length).trim();
  if (hit.args && !arg) return { error: `${hit.cmd} needs a value: ${hit.args.join(', ')}` };
  if (hit.args && hit.args.length && !hit.args.includes(arg) && !hit.allowAnyArg) return { error: `${hit.cmd} accepts: ${hit.args.join(', ')}` };
  return { spec: hit, arg };
}

module.exports = { specs, parse, CLAUDE_MODELS, CLAUDE_EFFORTS, CLAUDE_CATALOG };
