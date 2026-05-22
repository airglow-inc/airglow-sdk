#!/bin/bash
# Wrapper so Chrome can spawn the NM host reliably on macOS, even if /usr/bin/env
# node isn't on the PATH Chrome inherits.
exec /usr/bin/env node "$(dirname "$0")/host.mjs" "$@"
