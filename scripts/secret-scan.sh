#!/usr/bin/env bash
# Full scan: (1) the working folder and (2) the entire git history. Run before every push.
set -u
command -v gitleaks >/dev/null 2>&1 || { echo "gitleaks not installed" >&2; exit 1; }
fail=0
echo "== Scanning working folder (including untracked files) =="
gitleaks dir . --config .gitleaks.toml --redact || fail=1
echo "== Scanning full git history =="
if git rev-parse HEAD >/dev/null 2>&1; then
  gitleaks git . --config .gitleaks.toml --redact || fail=1
else
  echo "(no commits yet, nothing in history)"
fi
if [ $fail -ne 0 ]; then echo "RESULT: SECRETS FOUND - DO NOT PUSH" >&2; exit 1; fi
echo "RESULT: clean - no secrets found"
