#!/bin/sh
# Queue summaries are context data; failures must not prevent a session starting.
if command -v spillway >/dev/null 2>&1; then
  spillway session-summary 2>/dev/null || printf '%s\n' 'Spillway: service unavailable.'
else
  printf '%s\n' 'Spillway: CLI is not installed. See /spillway:setup.'
fi
