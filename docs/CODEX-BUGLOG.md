# Codex path bug log

Unexpected errors found while running Sol workers and Codex probes. Each entry has its evidence and status.

## Open

### C3. Codex turns are missing from turns.jsonl / usage.jsonl / requests.jsonl
- `grep -ci codex` returns 0 for all three files, including the rotated `turns.jsonl.1`. Only `bridge.jsonl` has Codex events (`codex_thread_started`). The Claude path logs a `sent` field in turns.jsonl, which the multi-Task text-loss check depends on. The Codex path has nothing equivalent.

### C4. Custom droid `model:` with the wrong ID silently falls back to the parent model (Droid behavior)
- `model: custom:codex:default:gpt-6.1-sol` is not a valid Droid model ID. Droid ran the subagent on the parent's `custom:Claude-Code-·-Opus-0` with no error. Both early "sol-worker" runs (smoke test 2c38b4d2, probe c9181e34) ran on Claude Opus.
- The correct ID is `custom:Codex-·-gpt-6.1-sol-0` (displayName with spaces as dashes, plus an index), as seen in session settings files.
- Fixed in `~/.factory/droids/sol-worker.md`. `~/.factory/droids/cs-ragdoll-recorder.md` still has the wrong ID.
- To verify the model a worker uses, check `bridge.jsonl` for `codex_thread_started`, or the subagent's `.settings.json`.

### C7. Bridge Codex sessions are not resumable across bridge restarts
- The resume records (C8) live in memory only. A bridge restart drops them, so the next request re-imports the full history into a new thread. Codex's rollouts would allow it; persisting the records was left out.

### C10. Codex logs a bubblewrap ERROR on every app-server start (noise)
- First seen through the C2 stderr logging, 2026-10-31 20:51:49Z: `ERROR codex_app_server: Codex could not find bubblewrap on PATH ... Codex will use the bundled bubblewrap in the meantime.`
- Harmless: Codex falls back to its bundled copy, and its sandboxed built-in tools are off. Each app-server start still logs it as a `codex_stderr` warning. Options: install `bubblewrap` on the host, or have the bridge drop this one line.

## Fixed

### C1. Long Droid tools made the model poll `wait` every ~30 s
- Codex's `exec` cell yields after ~31 s; the model then calls `wait`, one extra sampling per ~30 s of tool time.
- `-c code_mode.default_exec_yield_time_ms=...` and `-c features.code_mode.default_exec_yield_time_ms=...` have no effect (codex-cli 0.165.0).
- Working setting: thread/start `config.features.code_mode = { enabled: true, default_exec_yield_time_ms: 600000 }`. Probe: 0 waits, `Script completed / Wall time 40.0 seconds` (rollout `rollout-2026-10-31T21-39-46-01a193b0-...jsonl`), versus 1 wait at 31.0 s without it.
- Fix: `CODEX_EXEC_YIELD_MS` in `src/runtime/codex/runtime.ts`, applied in the thread config (also sent on thread/resume). Unit test asserts it.
- Live-verified through the bridge, 2026-10-31 20:51Z: a sol-worker ran `sleep 45` via Droid's Execute. The rollout `rollout-2026-10-31T21-51-49-01a193bb-...jsonl` shows a single `exec`, `Script completed / Wall time 45.2 seconds` and no `wait` call.

### C2. app-server stderr was discarded
- `app-server.ts` spawned with stderr `ignore`. Now stderr is always drained, the last 8 KB is kept (`stderrTail()`), it is appended to the error when the process dies, and each line is logged as `codex_stderr` in `bridge.jsonl`.

### C5. Bridge errors were not logged, and thread/start rejections looked like outages
- A failed request now writes `request_failed` (status, code, message) to `bridge.jsonl` (`src/http/app.ts`).
- When Codex answers thread/start with an RPC error, the bridge returns `400 codex_thread_rejected` with Codex's message instead of `502 codex_error`, so Droid no longer retries it 5 times as "provider temporarily unavailable".

### C6. Every new Codex thread failed: "deferred dynamic tool must include a namespace"
- Found: 2026-10-31 20:32Z, first real sol-worker run. `thread/start: deferred dynamic tool must include a namespace: WebSearch`.
- Cause: deferred tools and Mode/Mission placeholders were registered as top-level dynamic tools with `deferLoading: true`. codex-cli 0.165.0 accepts that flag only inside a `namespace` spec. The fake app-server in unit tests does not validate this.
- Fix: register them as plain dynamic tools; `toolRefusal` still tells the model to load them with ToolSearch first.
- Lesson: adapter changes need one live thread/start before they count as done.

### C8. Sessions could not be resumed after Droid exited
- A clean idle session (end of turn, nothing pending, not cancelled) retired by endHostSession, forget or the idle trim now keeps an in-memory record (last 50): thread id, account, model, tool maps and a hash of the history the thread has seen. The next request with the same prefix plus only new user messages calls `thread/resume` and sends only the new input. Otherwise it falls back to the full-history import. Logged as `codex_thread_resumed` / `codex_thread_resume_failed`.

### C9. An idle session kept a dead app-server
- If the Codex process exited while the session was idle, the bridge kept the dead server and `ensureThread` trusted it. Now the exit is logged (`codex_app_server_exited` with the stderr tail) and the session is retired, so the next request resumes the thread in a new server.

## Confirmed working
- thread/resume in a new app-server restores dynamic tools from the rollout without passing `dynamicTools` again (probe: second server received `item/tool/call` Probe). Memory of earlier turns is not yet proven, because the probe returned the same token every time.

## Probe script issues (not bridge bugs)
- `probe.mjs` counts `wait` through `item/started`, but `wait` doesn't come through as an app-server item, so it always prints 0. Count from the rollout instead.
