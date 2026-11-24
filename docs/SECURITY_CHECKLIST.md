# Final security checklist (run before every push)

- [ ] `bash scripts/secret-scan.sh` is clean (working folder **and** full git history).
- [ ] `git ls-files | grep -E '\.env$|\.local\.|node_modules'` prints nothing (only `.env.example` is tracked).
- [ ] `.env.example` contains placeholders only (no real RPC URL, key, address of a funded wallet).
- [ ] No private key, seed phrase or RPC URL with an API key anywhere in code, tests, docs, screenshots or commit messages.
- [ ] The pre-commit hook is active on your clone (`git config core.hooksPath` prints `scripts/hooks`).
- [ ] You only ever used a **burner** wallet for testnet; the funded main wallet never touched this repo.
- [ ] Contract addresses (Balancer Vault, routers, tokens, Multicall3) verified against official sources and the `VERIFY`/unverified notes updated.
- [ ] `DRY_RUN` is `true`; no mainnet deployment or transaction has been made.
- [ ] README states what was and was not run; no profit claims; disclaimer present.
- [ ] If anything sensitive was ever committed: stop, rotate/revoke that key at its provider immediately, then clean history
      (`git filter-repo --replace-text` or BFG) and force-push; deleting the file in a new commit is NOT enough.
- [ ] Enable GitHub secret scanning + push protection in the repo settings (free for public repos).
