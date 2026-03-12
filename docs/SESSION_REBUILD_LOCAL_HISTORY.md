# Session Rebuild From Local History

## Goal

Allow users to rebuild an ended session with useful local context while keeping private terminal content off the control plane.

This is **not** true process resurrection.

It is:

- local transcript persistence on the VPS
- local shell command history persistence on the VPS
- creation of a new session that starts with prior context preloaded

## Non-Goals

This design does **not** attempt to restore:

- exact process state
- editor state
- ncurses screen state
- running agent internal memory
- terminal cursor/app mode from the ended session

It only restores:

- transcript context
- shell command history
- session metadata

## Privacy Boundary

Private terminal content should remain on the user VPS.

Store session artifacts only under the VPS user account, for example:

- `~/.chatcode/history/<session-id>/transcript.log`
- `~/.chatcode/history/<session-id>/commands.hist`
- `~/.chatcode/history/<session-id>/meta.json`

Do **not** store ended-session transcripts in:

- control-plane
- Durable Objects
- D1
- R2

This keeps the trust model simple:

- control-plane coordinates sessions
- VPS stores private content

## Proposed Local Layout

Base directory:

- `~/.chatcode/history/`

Per session:

- `~/.chatcode/history/<session-id>/meta.json`
- `~/.chatcode/history/<session-id>/transcript.log`
- `~/.chatcode/history/<session-id>/commands.hist`

Optional:

- `~/.chatcode/history/<session-id>/summary.json`
  - only if later generated locally on the VPS

## Stored Metadata

`meta.json` should include:

- `session_id`
- `title`
- `agent_type`
- `workdir`
- `created_at`
- `ended_at`
- `exit_reason`
- `gateway_version`
- `shell`

This is enough to support rebuild UX and local inspection.

## Transcript Capture

Two practical options:

### Option A: Capture from tmux on end

When session ends:

- call `tmux capture-pane`
- persist final pane transcript to `transcript.log`

Pros:

- simple
- no continuous write overhead

Cons:

- only final visible history window unless history limit is large enough

### Option B: Rolling local transcript file

During session life:

- append terminal output to a local file

Pros:

- better history fidelity

Cons:

- more write volume
- more implementation complexity

Recommendation for MVP:

- start with **Option A**
- rely on tmux history limit

## Command History Capture

Use shell-native history files, not PTY parsing.

Examples:

### Bash

- set `HISTFILE` to a per-session path
- enable append behavior
- load history on session start

Example environment/setup:

```sh
export HISTFILE="$HOME/.chatcode/history/<session-id>/commands.hist"
shopt -s histappend
history -r "$HISTFILE" 2>/dev/null || true
PROMPT_COMMAND='history -a; history -n'
```

### Zsh

- set `HISTFILE` to a per-session path
- reload with `fc -R`

Recommendation:

- treat bash as MVP baseline first
- support zsh later if needed

## Rebuild Flow

User action:

- `Rebuild session`

Gateway behavior:

1. Read local history files for ended session
2. Create a new tmux session in the same `workdir`
3. Preload transcript into the pane
4. Preload shell command history file
5. Start a fresh shell or agent command

The rebuilt session should be clearly labeled, for example:

- `codex-4 (rebuilt)`

## How To Preload Transcript

tmux does not have a clean native “restore scrollback” API.

Practical workaround:

- create the new tmux session
- write saved transcript into the pane before starting normal interaction

Two reasonable approaches:

### Approach 1: print transcript before execing shell

Start command roughly like:

```sh
cat "$TRANSCRIPT_FILE"
printf '\\n--- rebuilt session ---\\n\\n'
exec "$SHELL"
```

Pros:

- simple
- transcript becomes visible in pane and scrollback

Cons:

- not identical to original scrollback semantics

### Approach 2: start shell, then inject transcript into pane

Possible, but more awkward and less predictable.

Recommendation:

- use **Approach 1**

## UX Semantics

Important:

- call it `Rebuild session`
- not `Resume session`

Reason:

- the old process is gone
- only history/context is restored

This distinction should stay explicit in the UI.

## Summaries and Adaptation

With this design, ended-session transcript is not available to the control-plane.

That means:

- ended-session summaries cannot be generated centrally later

This is acceptable if the product rule is:

- summarization/adaptation happens only while sessions are live
- ended sessions are rebuildable locally, but not centrally retained

This is a reasonable privacy-first tradeoff.

## Retention

Recommended MVP defaults:

- keep local history for `7` to `30` days
- or until explicit cleanup

Cleanup script should eventually remove:

- `~/.chatcode/history/`

or provide a flag to keep/remove rebuild artifacts.

## MVP Implementation Order

1. Persist final transcript on session end using tmux capture
2. Persist shell history file per session
3. Expose local ended-session metadata in gateway
4. Add `rebuild session` gateway command
5. Add UI action for rebuild

## Open Questions

1. Do we want history retention by count, age, or disk cap?
2. Do we want rebuilt sessions to default to shell only, or re-run the prior agent command?
3. Should cleanup remove rebuild history by default, or preserve it unless explicitly asked?
