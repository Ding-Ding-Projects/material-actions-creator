#!/bin/sh
# Protocol: one JSON line in on stdin, one JSON line out on stdout.
request=$(cat)
bytes=$(printf '%s' "$request" | wc -c | tr -d ' ')
printf '{"ok":true,"result":{"title":"Hello from sh","summary":"The request was %s bytes. Extension id: %s."}}\n' "$bytes" "$MAC_EXTENSION_ID"
