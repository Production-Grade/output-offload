import type { EngineInterface as Engine, Register } from 'claude-code'

// A tool result over LIMIT characters is the thing that refills a context: it is read once, then
// re-sent with every later request until the session compacts. This mod saves the whole result to a
// file and hands the model a short digest plus the path, so exact text is one Grep or ranged Read away.

const LIMIT = 20_000
const DIGEST_MODEL = 'claude-haiku-5-5'
const DIGEST_INPUT = 24_000 // characters of the result the digest model sees (head and tail)
const FALLBACK_HEAD = 3_000
const FALLBACK_TAIL = 2_000

// Tools whose results are data the model reads once. Anything else (Skill, ToolSearch, Agent reports,
// session tools) carries instructions or schemas the model needs whole, so it passes untouched.
const OFFLOAD_TOOLS = new Set(['Bash', 'Read', 'Grep', 'Glob', 'WebFetch'])
const KEEP_MCP = /^mcp__(ccd_|plugin-authoring)/

const IMAGE = /\.(png|jpe?g|gif|webp|pdf)$/i

// The engine already saves a very large result to a file and shows only its first 2KB, which misses
// anything at the end (the error on the last line). Those get a digest of the whole saved file.
const PERSISTED = /^<persisted-output>[\s\S]*?Full output saved to: (\S+)/

export const shouldOffload = (tool: string, input: Record<string, unknown>, text: string): boolean => {
  if (text.length <= LIMIT && !PERSISTED.test(text)) return false
  if (tool === 'Read') {
    // A ranged read is already the narrow read we want; an image or PDF is not text to digest.
    if (input.offset !== undefined || input.limit !== undefined || input.pages !== undefined) return false
    if (typeof input.file_path === 'string' && IMAGE.test(input.file_path)) return false
  }
  if (OFFLOAD_TOOLS.has(tool)) return true
  return tool.startsWith('mcp__') && !KEEP_MCP.test(tool)
}

const describe = (tool: string, input: Record<string, unknown>) => {
  const what = input.command ?? input.file_path ?? input.pattern ?? input.url ?? ''
  return `${tool}${what ? ` ${String(what).slice(0, 200)}` : ''}`
}

const clip = (text: string, head: number, tail: number) =>
  text.length <= head + tail
    ? text
    : `${text.slice(0, head)}\n…[${text.length - head - tail} characters cut]…\n${text.slice(-tail)}`

const DIGEST_PROMPT = (call: string, text: string) => `An agent ran: ${call}
The result is too long to keep in its context. Write a digest it can work from.
- Keep exact: errors and warnings, counts, totals, ids, paths, URLs, versions, and the final lines.
- Say what kind of output it is and how it is laid out (sections, columns, one row per what).
- Name what to grep for to find specific parts.
- At most 1,200 characters. No preamble.

<result>
${clip(text, Math.round(DIGEST_INPUT * 0.65), Math.round(DIGEST_INPUT * 0.35))}
</result>`

export const register: Register = on => {
  let n = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'offload', description: 'What output-offload has kept out of context, by day' })
    return next(e)
  })

  on('command.run', { command: 'offload' }, async $ => {
    const keys = (await $.store.keys()).filter(k => k.startsWith('saved:')).sort().slice(-7)
    if (!keys.length) return { text: 'Nothing offloaded yet.' }
    const rows = await Promise.all(keys.map(async k => {
      const v = (await $.store.get(k)) as { calls: number; chars: number }
      return `${k.slice(6)}  ${v.calls} results  ~${Math.round(v.chars / 4000)}K tokens kept out`
    }))
    return { text: rows.join('\n') }
  })

  on('tool.call', async ($, e, next) => {
    const done = await next(e)
    if (done.deny !== undefined || done.isError || done.text === undefined) return done
    const input = e as unknown as Record<string, unknown>
    if (!shouldOffload(e.tool, input, done.text)) return done

    // Past this point the tool has run: any failure hands the model the result as it was.
    try {
      const saved = PERSISTED.exec(done.text)?.[1]
      const text = saved ? await $.fs.read(saved) : done.text
      const call = describe(e.tool, input)
      let path = saved
      if (!path) {
        const sid = await $.session.id()
        const name = `${String(++n).padStart(3, '0')}-${e.tool.replace(/\W+/g, '_').slice(0, 40)}.txt`
        const root = await $.session.root()
        await $.fs.write(`${root}/.claude-offload/${sid}/${name}`, text)
        path = `${root}/.claude-offload/${sid}/${name}`
      }

      const r = await $.model.complete({
        model: DIGEST_MODEL, prompt: DIGEST_PROMPT(call, text), maxTokens: 600, effort: 'low', timeoutMs: 20_000,
      })
      const digest = r.isAnswered ? r.text.trim() : clip(text, FALLBACK_HEAD, FALLBACK_TAIL)
      const lines = text.split('\n').length
      await tally($, (saved ? done.text.length : text.length) - digest.length)
      return {
        deny: `the full result (${text.length.toLocaleString('en')} characters, ${lines.toLocaleString('en')} lines) is saved at ${path}. ${
          r.isAnswered ? 'Digest' : 'Head and tail'
        }:\n\n${digest}\n\nFor exact text, Grep that file or Read it with offset/limit. Don't Read it whole.`,
      }
    } catch (err) {
      // Nothing was saved, so the model gets the ends of the result rather than all of it.
      $.ui.log(`could not save the result: ${String(err)}`)
      return { deny: `the result was ${done.text.length.toLocaleString('en')} characters; only the head and tail are kept:

${clip(done.text, FALLBACK_HEAD, FALLBACK_TAIL)}` }
    }
  })
}

// Running totals per day, for /spend and for showing what the mod saved.
const tally = async ($: Engine, chars: number) => {
  const key = `saved:${new Date(await $.clock.now()).toISOString().slice(0, 10)}`
  const was = ((await $.store.get(key)) as { calls: number; chars: number } | undefined) ?? { calls: 0, chars: 0 }
  await $.store.set(key, { calls: was.calls + 1, chars: was.chars + chars })
}
