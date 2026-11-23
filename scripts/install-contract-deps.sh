#!/usr/bin/env bash
# Installs the Solidity dependencies into contracts/lib (git-ignored). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
mkdir -p lib

if [ ! -d lib/forge-std/src ]; then
  rm -rf lib/forge-std
  git clone --depth 1 https://github.com/foundry-rs/forge-std.git lib/forge-std
fi

if [ ! -d lib/openzeppelin-contracts/contracts ]; then
  rm -rf lib/openzeppelin-contracts
  git clone --depth 1 --branch v5.0.2 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
fi
echo "Contract dependencies ready: $(ls lib | tr '\n' ' ')"
