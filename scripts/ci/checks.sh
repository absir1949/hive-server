#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# Use a fresh checkout. Never borrow a developer or production environment.
for candidate in .env .env.local backend/.env backend/.env.local apps/radar/backend/.env apps/radar/backend/.env.local; do
  if [[ -e "$candidate" ]]; then
    echo "Refusing a checkout containing a local environment file: $candidate" >&2
    exit 2
  fi
done
# Unit tests stub browser/Docker adapters and use temporary files/local HTTP.
# Do not start server.js or any Chrome container here.
npm test
