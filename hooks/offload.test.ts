import { expect, test } from 'claude-code/testing'

const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} of build output`).join('\n')

const ANSWER = { isAnswered: true, text: 'Build log, 3000 lines, no errors.', usage: {} }

type On = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

const engine = (on: On, text: string, written: { path: string; text: string }[], answer: unknown = ANSWER) => {
  on('tool.call', () => ({ result: { stdout: text }, text }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 24) }))
  on('fs.write', (_, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('model.complete', () => ({ value: answer as never }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
}

test('a big Bash result is saved and replaced by a digest', async ($, on) => {
  const written: { path: string; text: string }[] = []
  engine(on, BIG, written)
  const r = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(written[0]?.path).toBe('/proj/.claude-offload/s1/001-Bash.txt')
  expect(written[0]?.text).toBe(BIG)
  expect(r.deny).toContain('Build log, 3000 lines, no errors.')
  expect(r.deny).toContain('/proj/.claude-offload/s1/001-Bash.txt')
})

test('a small result passes through', async ($, on) => {
  const written: { path: string; text: string }[] = []
  engine(on, 'ok', written)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(r.text).toBe('ok')
  expect(written.length).toBe(0)
})

test('a ranged Read is never offloaded', async ($, on) => {
  const written: { path: string; text: string }[] = []
  engine(on, BIG, written)
  const r = await $.tool.call({ tool: 'Read', file_path: '/proj/a.log', offset: 1, limit: 3000 })
  expect(r.deny).toBe(undefined)
  expect(written.length).toBe(0)
})

test('tools that carry instructions are never offloaded', async ($, on) => {
  const written: { path: string; text: string }[] = []
  engine(on, BIG, written)
  const r = await $.tool.call({ tool: 'Skill', skill: 'lean' } as never)
  expect(r.deny).toBe(undefined)
})

test('when the digest model fails, head and tail stand in', async ($, on) => {
  const written: { path: string; text: string }[] = []
  engine(on, BIG, written, { isAnswered: false, reason: 'empty-reply', usage: {} })
  const r = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(r.deny).toContain('Head and tail')
  expect(r.deny).toContain('line 2999 of build output')
})

test("the engine's own saved output gets a digest of the whole file", async ($, on) => {
  const written: { path: string; text: string }[] = []
  const preview = '<persisted-output>\nOutput too large (110.3KB). Full output saved to: /p/tool-results/t1.txt\n\nPreview (first 2KB):\nline 0'
  engine(on, preview, written)
  on('fs.read', () => ({ value: `${BIG}\nERROR: step 4711 failed` }))
  const r = await $.tool.call({ tool: 'Bash', command: 'make' })
  expect(written.length).toBe(0)
  expect(r.deny).toContain('/p/tool-results/t1.txt')
  expect(r.deny).toContain('Digest')
})
