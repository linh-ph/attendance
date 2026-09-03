#!/usr/bin/env python3
"""Generate GOOGLE_TOKEN_ENCRYPTION_KEY and write it into one or more .env files.

    python3 scripts/generate-encryption-key.py .env ../../../.env

`secrets.token_hex(32)` is 32 bytes of cryptographically random data written as
64 hex characters — `random` would not do, and neither would anything seeded
from the clock.

The key is never printed. It encrypts every stored Google refresh token, and a
value that reaches a terminal reaches scrollback, shell history, and whatever is
recording the session.

Refuses to overwrite an existing key. Rotating it makes every stored connection
undecryptable and there is no re-encryption path, so replacing one has to be a
deliberate act with `--force`, not a side effect of running this twice.
"""

# macOS still ships Python 3.9, where `str | None` in a signature is a
# TypeError at import time rather than a syntax the interpreter tolerates.
from __future__ import annotations

import argparse
import os
import re
import secrets
import sys

VARIABLE = "GOOGLE_TOKEN_ENCRYPTION_KEY"
KEY_BYTES = 32


def existing_value(text: str) -> str | None:
    match = re.search(rf"^{VARIABLE}=(.*)$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def apply(text: str, key: str) -> str:
    if re.search(rf"^{VARIABLE}=.*$", text, re.MULTILINE):
        return re.sub(rf"^{VARIABLE}=.*$", f"{VARIABLE}={key}", text, count=1, flags=re.MULTILINE)

    separator = "" if text.endswith("\n") or text == "" else "\n"
    return f"{text}{separator}{VARIABLE}={key}\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("env_files", nargs="+", help=".env files to write the key into")
    parser.add_argument(
        "--force",
        action="store_true",
        help="replace an existing key, making every stored Google connection undecryptable",
    )
    arguments = parser.parse_args()

    targets = []
    for path in arguments.env_files:
        if not os.path.isfile(path):
            print(f"error: {path} does not exist", file=sys.stderr)
            return 1

        with open(path, encoding="utf-8") as handle:
            text = handle.read()

        current = existing_value(text)
        if current and not arguments.force:
            print(f"error: {path} already has {VARIABLE} set. Use --force to replace it,")
            print("       which makes every stored Google connection undecryptable.", file=sys.stderr)
            return 1

        targets.append((path, text))

    key = secrets.token_hex(KEY_BYTES)

    for path, text in targets:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(apply(text, key))
        print(f"wrote {VARIABLE} ({KEY_BYTES} bytes, {len(key)} hex characters) to {path}")

    print("\nThe key was not printed. It is only in those files, and the database")
    print("does not hold a copy — back them up accordingly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
