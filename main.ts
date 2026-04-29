// rose-qwen-director — uses ProjectRose chat hooks to keep the agent on
// task. The first time the agent's thinking contains a numbered or bulleted
// list, we capture it as a checklist. Subsequent thinking blocks update
// completion status (checkbox marks, or words like "done"/"complete" on the
// item line). When the agent tries to respond to the user with tasks still
// pending, we inject a system message reminding it to finish. When the
// user sends a new message we drop the in-memory state so the next turn
// starts clean.

interface ExtCtx {
  rootPath: string
  registerHooks: (hooks: ChatHook[]) => void
}

type HookType = 'on_thought' | 'on_message' | 'on_tool_call'

type HookEvent =
  | { type: 'on_thought'; content: string; turnId: string }
  | { type: 'on_message'; content: string; turnId: string }
  | { type: 'on_tool_call'; toolName: string; params: Record<string, unknown>; result: string; error: boolean; turnId: string }

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
let lastTurnId: string | null = null
// True between an injection and the start of the next turn — used to tell a
// fresh user message apart from an auto-injection iteration. Both produce a
// new turnId on the host side; only the user-message case should reset.
let injectedThisTurn = false

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

// Called at the start of every hook fire. Returns true if a fresh user
// message just arrived (state was cleared); false if this is the same turn
// or an auto-injection continuation.
function syncTurn(turnId: string): boolean {
  if (turnId === lastTurnId) return false
  const wasInjecting = injectedThisTurn
  lastTurnId = turnId
  injectedThisTurn = false
  if (wasInjecting) return false
  // Previous turn ended without us injecting — the agent finished freely
  // and the next turnId is therefore a fresh user message.
  checklist = []
  return true
}

function applyThinking(content: string): void {
  const parsed = parseList(content)
  if (parsed.length === 0) return

  if (checklist.length === 0) {
    // First list seen — capture as canonical.
    checklist = parsed.map((i) => ({ ...i }))
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
    type: 'on_thought',
    handler: (event) => {
      if (event.type !== 'on_thought') return
      syncTurn(event.turnId)
      applyThinking(event.content)
    }
  },
  {
    type: 'on_message',
    handler: (event) => {
      if (event.type !== 'on_message') return
      syncTurn(event.turnId)
      const reminder = buildReminder()
      if (reminder) {
        injectedThisTurn = true
        return { inject: reminder }
      }
    }
  }
]

export function register(ctx: ExtCtx): () => void {
  ctx.registerHooks(hooks)
  return () => {
    checklist = []
    lastTurnId = null
    injectedThisTurn = false
  }
}
