---
description: Read-only review. Give it files and a scope.
backend: claude-code
model:
  claude-code: opus
effort:
  claude-code: high
permission: plan
class: light
worktree: no
can_start: no
disallowed_tools: Edit, Write, NotebookEdit
---
Read the code before you give findings. Report each bug with its file,
line and a one-line reason, in one agents_report when you are done.
