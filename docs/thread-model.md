# thread model

Each content node in Structa can deepen through an append-only thread.

## storage

Threads live on `node.meta.thread`:

```json
[
  {
    "id": "thread-...",
    "kind": "comment",
    "body": "user words",
    "summary": "short collapsed summary",
    "at": "2026-04-18T10:00:00.000Z",
    "origin": "ptt"
  }
]
```

Related helpers:

- `appendThreadComment(nodeId, text, kind, origin)`
- `setThreadCommentSummary(nodeId, commentId, summary)`
- `getNodeThread(nodeId)`

## interaction

- hold `ptt` on content writes the raw comment immediately
- no llm call blocks that write
- a `thread-refine` queue job later condenses the latest comment for collapsed views
- if refine fails or times out, the raw comment remains the summary

## rendering

- KNOW shows thread depth through the stacked-bars glyph
- KNOW detail renders body + comments inside one scroll frame
- SHOW / TELL / NOW surface the latest thread summary when available

## intent

Threads preserve the user's words without overwriting the canonical item body.
They make Structa a knowledge-development tool instead of a flat capture list.
