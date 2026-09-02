#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
macos_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/filmos-review-source-test.XXXXXX")
cleanup() {
    find "$test_root" -type f -delete 2>/dev/null || true
    find "$test_root" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

source_root="$test_root/source"
developer_root="$test_root/Application Support/FilmOS Studio/DeveloperRepository"
review_bus_dir="$test_root/Application Support/FilmOS Studio/review-bus"
target="$developer_root/filmos-studio"
mkdir -p "$source_root"
git -C "$source_root" init -q
git -C "$source_root" config user.name "FilmOS Test"
git -C "$source_root" config user.email "filmos-test@example.invalid"
git -C "$source_root" remote add origin https://github.com/maiyadiu/filmos-studio.git
git -C "$source_root" remote set-url --push origin git@github.com:maiyadiu/filmos-studio.git
printf 'base\n' >"$source_root/README.md"
git -C "$source_root" add README.md
git -C "$source_root" commit -qm "test: base"
first_commit=$(git -C "$source_root" rev-parse HEAD)

FILMOS_REVIEW_SOURCE_ROOT="$source_root" \
FILMOS_REVIEW_DEVELOPER_ROOT="$developer_root" \
FILMOS_REVIEW_BUS_LOCAL_DIR="$review_bus_dir" \
    "$macos_root/scripts/prepare-review-source-repository" >/dev/null

test "$(git -C "$target" rev-parse HEAD)" = "$first_commit"
test "$(git -C "$target" remote get-url origin)" = "https://github.com/maiyadiu/filmos-studio.git"
test "$(git -C "$target" remote get-url --push origin)" = "git@github.com:maiyadiu/filmos-studio.git"
test "$(stat -f '%Lp' "$review_bus_dir/developer-repository.json")" = "600"
python3 - "$review_bus_dir/developer-repository.json" "$target" "$first_commit" <<'PY'
import json, pathlib, sys
value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert value["repository"] == "maiyadiu/filmos-studio"
assert value["source_repository"] == str(pathlib.Path(sys.argv[2]).resolve())
assert value["source_commit"] == sys.argv[3]
assert len(value["source_tree"]) == 40
PY

printf 'second\n' >>"$source_root/README.md"
git -C "$source_root" add README.md
git -C "$source_root" commit -qm "test: second"
second_commit=$(git -C "$source_root" rev-parse HEAD)
git -C "$source_root" remote set-url origin https://github.com/maiyadiu/filmos-studio
git -C "$source_root" remote set-url --push origin git@github.com:maiyadiu/filmos-studio
FILMOS_REVIEW_SOURCE_ROOT="$source_root" \
FILMOS_REVIEW_DEVELOPER_ROOT="$developer_root" \
FILMOS_REVIEW_BUS_LOCAL_DIR="$review_bus_dir" \
    "$macos_root/scripts/prepare-review-source-repository" >/dev/null
test "$(git -C "$target" rev-parse HEAD)" = "$second_commit"
test "$(git -C "$target" remote get-url origin)" = "https://github.com/maiyadiu/filmos-studio"
test "$(git -C "$target" remote get-url --push origin)" = "git@github.com:maiyadiu/filmos-studio"

printf 'dirty\n' >"$target/dirty.txt"
if FILMOS_REVIEW_SOURCE_ROOT="$source_root" \
    FILMOS_REVIEW_DEVELOPER_ROOT="$developer_root" \
    FILMOS_REVIEW_BUS_LOCAL_DIR="$review_bus_dir" \
    "$macos_root/scripts/prepare-review-source-repository" >/dev/null 2>&1; then
    echo "dirty canonical repository was overwritten" >&2
    exit 1
fi

printf 'REVIEW_SOURCE_REPOSITORY_PASS local_clone=true official_remote=true atomic_locator=true dirty_fail_closed=true\n'
