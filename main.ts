// rose-qwen-director — uses ProjectRose chat hooks to keep the agent on
// task. The first time the agent's thinking contains a numbered or bulleted
// list, we capture it as a checklist. Subsequent thinking blocks update
// completion status (checkbox marks, or words like "done"/"complete" on the
// item line). When the agent tries to respond to the user with tasks still
// pending, we inject a system message reminding it to finish. State is
// cleared explicitly when the host fires `on_user_message`, so a fresh user
// message always starts with an empty checklist regardless of how the prior
// turn ended.

interface ExtCtx {
  rootPath: string
  registerHooks: (hooks: ChatHook[]) => void
  notifyStatus: (text: string, opts?: { tone?: 'info' | 'success' | 'error' | 'warning'; durationMs?: number }) => void
}

let notifyStatus: ExtCtx['notifyStatus'] = () => {}

type HookType = 'on_thought' | 'on_message' | 'on_tool_call' | 'on_user_message'

type HookEvent =
  | { type: 'on_thought'; content: string; turnId: string }
  | { type: 'on_message'; content: string; turnId: string }
  | { type: 'on_tool_call'; toolName: string; params: Record<string, unknown>; result: string; error: boolean; turnId: string }
  | { type: 'on_user_message'; content: string }

interface ChatHook {
  type: HookType
  handler: (event: HookEvent) => Promise<{ inject?: string } | void> | { inject?: string } | void
  allowMultiple?: boolean
}

interface ChecklistItem {
  text: string
  done: boolean
}

let checklist: ChecklistItem[] = []

function canonicalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s*[-—:]\s*\b(done|complete|completed)\b\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Parse a single line. Returns null when the line is not a list item.
function parseListItem(line: string): { text: string; done: boolean } | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  // Bulleted with checkbox — handles both `- [x]` and `-[x]` (no space).
  let m = trimmed.match(/^[-*+]\s*\[([ xX])\]\s*(.+)$/)
  if (m) {
    return { text: m[2].trim(), done: m[1].toLowerCase() === 'x' }
  }

  // Numbered with checkbox — `1. [x] item`, `2) [ ] item`.
  m = trimmed.match(/^\d+[.)]\s*\[([ xX])\]\s*(.+)$/)
  if (m) {
    return { text: m[2].trim(), done: m[1].toLowerCase() === 'x' }
  }

  // Plain bulleted — done if the text contains "done" or "complete(d)".
  m = trimmed.match(/^[-*+]\s+(.+)$/)
  if (m) {
    const text = m[1].trim()
    return { text, done: /\b(done|complete|completed)\b/i.test(text) }
  }

  // Plain numbered.
  m = trimmed.match(/^\d+[.)]\s+(.+)$/)
  if (m) {
    const text = m[1].trim()
    return { text, done: /\b(done|complete|completed)\b/i.test(text) }
  }

  return null
}

function parseList(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = []
  for (const line of content.split('\n')) {
    const item = parseListItem(line)
    if (item) items.push(item)
  }
  return items
}

function applyThinking(content: string): void {
  const parsed = parseList(content)
  if (parsed.length === 0) return

  if (checklist.length === 0) {
    // First list seen — capture as canonical.
    checklist = parsed.map((i) => ({ ...i }))
    notifyStatus(`Director: tracking ${checklist.length} task${checklist.length === 1 ? '' : 's'}`, { tone: 'info' })
    return
  }

  // Subsequent thinking blocks may show the same list with checkmarks or
  // completion markers. Only flip items from pending → done; never the
  // other way, and never add new items mid-turn.
  for (const incoming of parsed) {
    if (!incoming.done) continue
    const ik = canonicalize(incoming.text)
    const existing = checklist.find((c) => {
      const ck = canonicalize(c.text)
      return ck === ik || ck.startsWith(ik) || ik.startsWith(ck)
    })
    if (existing) existing.done = true
  }
}

function buildReminder(): string | null {
  if (checklist.length === 0) return null
  const incomplete = checklist.filter((i) => !i.done)
  if (incomplete.length === 0) return null
  const list = incomplete.map((i) => `- [ ] ${i.text}`).join('\n')
  return (
    'You stated tasks in your plan but have not finished them all. ' +
    'Do not stop or report done — keep working until every task below is complete.\n\n' +
    `Remaining:\n${list}`
  )
}

const hooks: ChatHook[] = [
  {
    type: 'on_user_message',
    handler: () => {
      // Fresh user message — drop any checklist carried over from a prior turn.
      checklist = []
    }
  },
  {
    type: 'on_thought',
    handler: (event) => {
      if (event.type !== 'on_thought') return
      applyThinking(event.content)
    }
  },
  {
    type: 'on_message',
    handler: (event) => {
      if (event.type !== 'on_message') return
      const reminder = buildReminder()
      if (reminder) {
        const remaining = checklist.filter((i) => !i.done).length
        notifyStatus(`Director: nudging agent — ${remaining} task${remaining === 1 ? '' : 's'} left`, { tone: 'warning' })
        return { inject: reminder }
      }
    }
  }
]

export function register(ctx: ExtCtx): () => void {
  notifyStatus = ctx.notifyStatus ?? (() => {})
  ctx.registerHooks(hooks)
  return () => {
    checklist = []
    notifyStatus = () => {}
  }
}
