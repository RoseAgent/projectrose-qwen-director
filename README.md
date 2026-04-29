# rose-qwen-director

A ProjectRose extension that keeps the agent honest about its own plans.

## What it does

When the agent's thinking contains a numbered or bulleted list, the
extension captures it as a checklist held in memory. As more thinking blocks
arrive, items are marked complete when they appear with `- [x]` style
checkmarks, or when the line ends with `done` / `complete` / `completed`.

When the agent tries to respond to the user with tasks still pending, the
extension injects a system-role reminder before the next assistant turn
runs, listing the unfinished items. The agent can keep working through as
many auto-injected turns as it needs. Once every item is marked complete,
the agent's reply is allowed to reach the user.

The in-memory checklist is dropped the moment the user sends a new message,
so each conversation turn starts clean.

## Installation

Inside ProjectRose:

1. Open the Extensions panel.
2. Install from disk and select this folder, or install from the GitHub URL.
3. Enable the extension.

The extension only declares `main` and `chatHooks` — it has no UI surface.

## Build

```sh
npm install
npm run build
```

The build produces `dist/main.js`, which the host loads on extension
activation. The repo also commits `dist/` so the extension can be installed
as a pre-built bundle.

## How the hook flow works

- `on_thought` — fires for every completed thinking block. The handler
  parses list items and either captures the canonical list (first time) or
  marks existing items complete.
- `on_message` — fires when the agent emits an assistant text segment.
  The handler checks whether any captured items are still pending and, if
  so, returns `{ inject: '...' }`. The host appends that as a system message
  in the next turn.

A small piece of state (`injectedThisTurn`) is used to distinguish a fresh
user message from an auto-injection continuation. Both produce a new
`turnId` on the host side, but only the former should clear the checklist.

## Limitations

- Captures only from thinking, not from assistant text. If the model never
  thinks, no checklist is built and the extension is a no-op.
- The first list wins. New items in later thinking are ignored — only
  completion status updates.
- Item matching is text-based with light normalization. If the model
  paraphrases an item heavily between thinking blocks the match may miss.
