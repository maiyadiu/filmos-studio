#!/bin/sh
set -eu

source_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$source_root/scripts/filmos-source-start" start
