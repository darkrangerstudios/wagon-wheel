# AGENTS.md: working on Wagon Wheel

This file is for AI coding agents (Codex, Claude Code, others) working in this repository. The README describes the product; this file covers how to change it safely.

## What this is
Wagon Wheel is a VS Code extension: one chat room where a human, Claude and Codex talk in a single timeline. The extension starts both agents as **private child processes over stdio**: `codex app-server` (newline-delimited JSON-RPC) and `claude -p --input-format stream-json --output-format stream-json`. It routes messages between them. There is no daemon, no network listener and no web server. Plain JavaScript (CommonJS), no build step, no runtime dependencies.

## Map
| File | Owns |
|---|---|
| `src/room.js` | The router. Who hears what: mention parsing, catch-up deltas, `@both` turn-taking, typed tool calls (`_onTool`), request/answer delivery and task turn admission, Pause/Resume/time limit, runs and Stop, posts an agent makes on its own (`unprompted`), delivery receipts (`knownBy`), steering, history seeding. Untyped agents only: line-start `@name` hand-offs (`handoffs()`), hop cap and the 2-replies-per-agent limit. Pure logic, no I/O; the most heavily tested file. |
| `src/tasks.js` | The task ledger: host-owned tasks, typed requests (`request_assistance`) and results, admission (recipient, duplicates, no bouncing, allowances), `finish_task`, Pause/Stop/generations, limits and presets, and the tool specs both agents get. Pure logic, injected clock. |
| `src/scheduler.js` | The one host timer: fixed checks and adaptive polls (10 min, hourly after two quiet checks), no overlap, one catch-up after sleep, bounded `update()` for agent schedule changes. |
| `src/prompts.js` | The standing brief each agent gets (typed and untyped variants). |
| `src/sessionHistory.js` | Access control for shared history: host-only binding and readers, rebinding revokes grants, text-only Claude and Codex readers. |
| `src/historySources.js` | Local history as room context: human-added sources, shared working sessions, the read_session_history tool's output. Local sessions only. |
| `src/setup.js` | Read-only CLI checks (version, sign-in), no model calls. |
| `src/startRoom.js` | Start a Room: filters Wagon Wheel's own room conversations out of the lists (Claude dontAsk mode; Codex session-file originator, product names, saved rooms' own ids), and turns the screen's form into a validated room plan (conversations must come from the lists the host sent; Claude uses the conversation's folder; one writer per original) and setup results into plain-English lines. Pure. |
| `media/start.js`, `media/start.css` | The Start a Room screen (the host side is `openStartScreen` in `extension.js`). Plain English, a help line under every choice; `textContent` only. |
| `src/claudeModels.js` | Claude Code's own model menu from the CLI's initialize response (no model call), tier-sorted with Default first and older models grouped; the same native text as FALLBACK. Effort levels and labels as Claude Code names them. |
| `src/roomsView.js` | The side panel's saved-rooms list: reads room files (parsed once per change, keyed by mtime and size; files over 25 MB listed unparsed), ordered by the newest message, UUID-named files only. The Activity Bar container, Start buttons (viewsWelcome), editor title button and status bar item are wired in `package.json` and `extension.js`. |
| `src/roomLock.js` | One writer per room across VS Code windows: `<id>.lock` holds the owner's pid, created exclusively at boot, released on close and deactivate, taken over when the owner process is gone. |
| `src/feedback.js` | Report a Problem: builds the prefilled GitHub issue URL from versions and the roster, plus opt-in scrubbed log lines. Pure; the command in `extension.js` gathers facts and opens the URL. |
| `src/localUsage.js` | This computer's token use from the CLIs' own logs (`~/.claude/projects`, `~/.codex/sessions`): incremental, read-only, no model calls. Totals plus the breakdown by model, lane (main or subagent), thinking, cache tier and tool call. Unrecognised formats report unknown, never zero. |
| `src/claudeUsage.js` | Claude plan limits from the CLI's headless `/usage` (session, week, per model). |
| `src/codexClient.js` | Private `codex app-server` over stdio: threads, turns, fork, `turn/steer`, `model/list`, rate limits, activity mapping (`describeItem`), typed tools (`dynamicTools` on `thread/start`, answered from `item/tool/call`). Holds the forbidden-method blocklist. |
| `src/copyMode.js` | A separate copy: git worktree + branch in the room's storage, path mapping, changes count, and the bring-in / remove commands the person runs. |
| `src/editPolicy.js` | Which files an editing agent may touch: real-path containment (symlinks, files not yet created), git's own folders refused, sensitive files flagged. |
| `src/approvalCards.js` | What Claude's and Codex's permission requests look like as approval cards (title, paths, diff or command). |
| `src/claudeClient.js` | Persistent `claude -p` stream-json session: streaming, thinking and tool activity, clean interrupt (control_request), steer (interrupt, then continue), model/effort/fast restarts on the same session (held while background jobs run), Ultracode, background jobs (`onJobs`, `stopJobs`) and the turns Claude starts on its own to report them (`onUnprompted`), typed tools as an in-process `sdk` MCP server answered over the same stdio. |
| `src/claudeBinary.js` | Picks the newest Claude Code CLI on the machine. Old CLIs refuse new models. |
| `src/claudeHistory.js` | Reads saved Claude sessions (`~/.claude/projects/**.jsonl`) for forking and briefing. Read-only. |
| `src/attachments.js` | Stores files in the room folder; converts them to each agent's native input. |
| `src/commands.js` | Slash commands (grouped Room / Claude / Codex) and the Claude model catalogue. |
| `src/diffs.js` | Unified-diff parser and in-memory patch applier (never writes to disk). |
| `src/ideContext.js` | Formats the IDE snapshot (active file, selection, tabs, problems). |
| `src/paths.js` | Containment checks (symlink-aware) for agent-supplied diff paths and the IDE snapshot. |
| `src/extension.js` | VS Code glue: commands, webview panel and markup, per-room settings, IDE tracking, diff opener, agent briefs (`roomPrompt`). |
| `media/room.js`, `media/room.css` | The webview UI. |
| `docs/` | GitHub Pages marketing site. |

## Run and test
- `npm test` runs the fast unit suite: router, hand-offs, commands, diffs, IDE context, attachments, Codex activity replay, version guard. It must stay green, and every behaviour change adds a test. Reproduce a bug as a failing test before fixing it (see the runaway test in `test/room.test.js`).
- Live tests spend real quota; run them only when a change touches the process boundary:
  - `node test/live-three-way.js <repoCwd> <imagePath>` (Claude and Codex together)
  - `node test/live-claude-fork.js <claudeSessionId>`
  - `node test/token-ab.js <scratchCwd>`
  - `node test/live-smoke.js <codexThreadId> <scratchCwd>`
  - `node test/live-stop.js <scratchCwd>` (Stop and steer against both real CLIs; run after touching either client's lifecycle)
  - `node test/live-tasks.js <scratchCwd>` (typed request → answer → finish_task with both real CLIs; run after touching tools, tasks or prompts)
  - `node test/live-history.js <scratchCwd>` (each agent reads a local session of the other provider through read_session_history)
- Package: `npm run package` builds `wagon-wheel-<version>.vsix` with a pinned `@vscode/vsce` via npx (no dev dependency). `.vscodeignore` keeps tests, the site and agent notes out; `test/package.test.js` guards it. Install-check with `code --user-data-dir <tmp> --extensions-dir <tmp> --install-extension <vsix>` so your own profile is untouched.
- UI: launch an Extension Development Host with `code --extensionDevelopmentPath="$PWD" --new-window`. Press Cmd+R in that window to reload after changes. `package.json` `version` and `EXPECT` in `media/room.js` must match (a test enforces this); bump both together.

## Guardrails (do not weaken without the repo owner's explicit OK)
- **No listeners.** Never add a TCP/WebSocket port or a local web server. Agents stay stdio children. A localhost port is reachable by every web page in the user's browser.
- **Read-only by default.** Codex runs with `sandbox: read-only` and `approvalPolicy: never`, and server-to-client approval requests are auto-declined (only `item/tool/call` for our own typed tools is answered). Claude runs with `--permission-mode dontAsk`, Read/Glob/Grep plus our own typed tools only, and `--strict-mcp-config` with no MCP server except the in-process `wagon` one the extension answers over stdio. Ultracode (Claude's `ultracode` effort) adds only the Workflow tool. Workflow scripts are model-written, so it also denies the write, shell, network and agent tools by name (`--disallowedTools`) and refuses the CLI's own worktree isolation (which runs `git worktree add` in the person's repo) with a failing `WorktreeCreate` hook. `test/live-ultracode-boundary.js` checks this against the real CLI; run it after any change to the flags or a CLI upgrade. Above read only (seat `access` edit/run, at most one per room): Claude adds the write tools (and Bash) without pre-allowing them, in `default` mode with `--permission-prompt-tool stdio`; Codex keeps the read-only sandbox and runs each turn with `approvalPolicy: on-request`. Every request becomes a room card (`Room.requestApproval`), answered only by the human; Stop, close, time allowance and the card timeout deny; the host refuses before any card: outside the seat's folder, inside git's own folders, or no known files (`editPolicy.check`); sensitive files (can run code) always get a card, never the standing rule. `test/live-edit.js` checks both CLIs by file bytes.
- **Typed tools are requests, not authority.** The host stamps sender, task and generation and decides admission; tool arguments cannot widen permissions, refill allowances or resume paused or stopped work. Never route typed agents by parsing their prose.
- **Forbidden methods** in `codexClient.js` (quota reset-credit spend, logout/login, thread delete) stay blocked.
- **Untrusted output.** The webview renders model output with `textContent` only, under a strict CSP. Never use `innerHTML` with agent or file content.
- **Copy by default.** Bringing in an existing Codex thread or Claude session uses a copy (fork) unless the human chooses "Keep going in the original" on the Start a Room screen or in the agent's Switch menu; a conversation that changed in the last two minutes (read at Start, not from the list) gets a warning first, and one another room already uses (claimed in this window or bound in a saved room) is refused before the screen closes. Never continue a session implicitly, and never rename a conversation the person brought in as the original.
- **Never two writers from a hand-off.** Resume commands are built by the host from ids it holds (`resumeCommand`), never from page text. The room offers the person's original (only when the agent works on a copy), a fork of the agent's conversation, or, via Move it out, the agent's own conversation only after the agent has switched away from it.
- **Plain English in the UI.** No "seat", "fork", "working session" or "roster" on screens people use; `test/start-room.test.js` checks the Start a Room screen for them.
- **One writer per room, in every window.** `roomClaims` covers this extension host; `roomLock` covers other windows. Never open or save a room without both.
- **Problem reports carry no content.** Report a Problem may include versions, the roster and, only on opt-in after the person sees them, scrubbed log lines (which can hold CLI error text; the ACP permission-title line is filtered, CLI stderr is not). Never add transcript, prompt, attachment, file or session content, and never send anything: the person submits on GitHub. Open the URL with `openExternal(string)`, never `Uri.parse`, which re-encodes the query.
- **Agents post on their own only to report.** An unprompted turn (Claude answering a finished background job) becomes a `post` addressed to the human: never a delivery to another agent (its `request_assistance` and `finish_task` are refused, and a human message during it is queued, not steered into it), capped per task (`postCap`), a task turn, held while paused and discarded after Stop (`Room.unprompted`). Stop also ends running jobs (`stop_task`).
- **The room is the only prompt surface, and the host never writes the person's folder itself.** Approval cards are the only way an edit or command is allowed. Separate-copy rooms (`copyMode.js`) create a worktree in the room's storage; bringing changes in and removing the copy are commands the person runs, never the host.
- **Relay labels.** Agent text is always delivered as "relayed by Wagon Wheel, not <human>". Only the human's messages carry authority.

## Conventions
- Match the surrounding style: small functions, a comment only where the *why* isn't obvious, no new dependencies without a clear reason.
- This is a **public repo, all rights reserved**. Never commit personal data, other projects' names or paths, tokens, or machine-specific absolute paths. Scan the staged diff before pushing.
- Commits use the repo's configured author (a GitHub no-reply address). Don't change `git config user.email`.
- One lane per branch or worktree when two agents work at once. Don't edit a file another lane is actively changing; coordinate first. `src/room.js` changes need tests in the same commit.
