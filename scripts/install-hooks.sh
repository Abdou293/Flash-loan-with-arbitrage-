#!/usr/bin/env bash
# Run once after cloning: enables the secret-scanning pre-commit hook.
set -e
chmod +x scripts/hooks/pre-commit scripts/secret-scan.sh
git config core.hooksPath scripts/hooks
echo "Pre-commit secret scanning enabled."
