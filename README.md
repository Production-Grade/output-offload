# output-offload

A Claude Code mod that keeps big tool results out of your context. When a result runs past
20,000 characters, the whole result is saved to a file. The model gets a short digest of it
from Haiku plus the file's path. When it needs exact text, that's one Grep or ranged Read away.

## Why

Once a tool result lands in context, it stays there. It gets sent again with every later
request until the session compacts. A 100 KB build log read once at the start of a long session
can cost more than all the code the model writes. Most of the time the model needed three facts
from it: did it pass, what failed, and where.

Claude Code already saves very large results to a file, but it shows only the first 2 KB of
each. That misses whatever is at the end, which is usually the error. output-offload digests the
whole saved file instead.

## What the model sees

```
the full result (112,916 characters, 6,001 lines) is saved at .../tool-results/toolu_01X....txt. Digest:

Build log: sequential numbered build steps, one row per step.
- Total steps: 6000, failed: 1 (step 4711)
- Final lines: ERROR: step 4711 failed
Grep "ERROR" for failures, "^4711" for the failed step.

For exact text, Grep that file or Read it with offset/limit. Don't Read it whole.
```

The digest keeps errors, counts, ids, paths, URLs, versions and the final lines exact. It also
says how the output is laid out and what to grep for. If the digest call fails, the model gets
the head and tail of the result instead.

## What it leaves alone

- Results under the limit.
- Reads with `offset`, `limit` or `pages`, because those are already the narrow read you want.
  Images and PDFs too.
- Skill, ToolSearch, Agent and session-tool results. The model needs those whole.
- Only `Bash`, `Read`, `Grep`, `Glob`, `WebFetch` and MCP tools are offloaded.

## Install

```
/plugin marketplace add Production-Grade/output-offload
/plugin install output-offload@output-offload
```

Raise Claude Code's own shell limit so the mod sees whole outputs. Add this to the `env` block of
`~/.claude/settings.json`:

```json
"BASH_MAX_OUTPUT_LENGTH": "150000"
```

At a small value, Claude Code cuts the middle out of shell output before any mod sees it.

Saved results go to `.claude-offload/<session>/` in your project. Add that to `.gitignore`.

`/offload` shows how many results it kept out of context each day, and roughly how many tokens.

## Settings

Constants at the top of [`hooks/register.ts`](hooks/register.ts):

| Constant | Default | What it does |
|---|---|---|
| `LIMIT` | `20_000` | Characters before a result is offloaded |
| `DIGEST_MODEL` | `claude-haiku-5-5` | Model that writes the digest |
| `DIGEST_INPUT` | `24_000` | Characters of the result the digest model sees (head and tail) |
| `OFFLOAD_TOOLS` | Bash, Read, Grep, Glob, WebFetch | Tools whose results can be offloaded |

## Notes

- The withheld result reaches the model as a tool error carrying the digest. Models carry on fine
  with this, but it does show as an error in the transcript.
- Each digest is one small Haiku call, a fraction of a cent. Without it, the big result gets
  re-sent on every later request.

## What it hooks and writes

- `tool.call` on Bash, Read, Grep, Glob, WebFetch and MCP tools: after the tool runs, a result over the limit is swapped for the digest. Tool input is never changed.
- `command.run` answers its own `/offload` command and nothing else.
- Writes only `.claude-offload/<session>/<n>-<tool>.txt` in your project: plain copies of tool results. Nothing runs or reads them as instructions.
- One small model call per offloaded result, for the digest.

## More from Production Grade

Walkthroughs of these mods and of how I run Claude Code on real work:

- YouTube: [@productiongradeai](https://www.youtube.com/@productiongradeai)
- Substack: [productiongrade.substack.com](https://productiongrade.substack.com)

Part of [Claude Lean Mods](https://github.com/Production-Grade/claude-lean-mods). MIT licence.
