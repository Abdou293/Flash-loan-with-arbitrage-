# Flash Loan Arbitrage on Arbitrum (Educational / Portfolio Project)

> **Work in progress.** Built in phases. Dry-run mode only; no real transactions are sent.

**Disclaimer:** educational/portfolio project. Not financial advice. No profit guarantees.
Not security-audited. Use at your own risk.

## Status
- [x] Phase 1: project structure and secret scanning
- [~] Phase 2: smart contract + Foundry tests (mock tests pass; fork tests written, not yet run)
- [ ] Phase 3: bot framework and strategies (dry-run)
- [ ] Phase 4: backtesting and dry-run report
- [ ] Phase 5: testnet test + dashboard
- [ ] Phase 6: publishing

## Secret scanning (required before committing)
Install [gitleaks](https://github.com/gitleaks/gitleaks), then run once:

    bash scripts/install-hooks.sh

Full scan (working folder + git history) before every push:

    bash scripts/secret-scan.sh
