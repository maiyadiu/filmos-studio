#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
macos_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
test_root=$(mktemp -d "${TMPDIR:-/tmp}/filmos-pilot-test.XXXXXX")
cleanup() {
    find "$test_root" -type f -delete 2>/dev/null || true
    find "$test_root" -depth -type d -empty -delete 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
source_data="$test_root/formal/WorkbenchData"
pilot_support="$test_root/pilot-support"
pilot_data="$pilot_support/WorkbenchData"
mkdir -p "$source_data/resources/users/user-1/image"
printf 'target-asset' >"$source_data/resources/users/user-1/image/target.bin"
printf 'direct-canvas-resource' >"$source_data/resources/users/user-1/image/direct.bin"
printf 'other-asset' >"$source_data/resources/users/user-1/image/other.bin"
sqlite3 "$source_data/open_ai_canvas.db" <<'SQL'
CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT, name TEXT);
CREATE TABLE project_units (id TEXT PRIMARY KEY, project_id TEXT, title TEXT);
CREATE TABLE canvas_projects (id TEXT PRIMARY KEY, project_id TEXT, user_id TEXT, title TEXT, payload_json TEXT);
CREATE TABLE canvas_unit_links (id TEXT PRIMARY KEY, canvas_id TEXT, unit_id TEXT, role TEXT);
CREATE TABLE workflow_template_versions (id TEXT PRIMARY KEY, template_key TEXT, definition_json TEXT);
CREATE TABLE workflow_instances (id TEXT PRIMARY KEY, project_id TEXT, template_version_id TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT, display_name TEXT);
CREATE TABLE model_channels (id TEXT PRIMARY KEY, user_id TEXT, api_key TEXT, secret_key TEXT, headers_json TEXT);
CREATE TABLE channel_models (id TEXT PRIMARY KEY, channel_id TEXT, provider_model_key TEXT);
CREATE TABLE model_pricings (id TEXT PRIMARY KEY, channel_id TEXT, model TEXT, per_request_micros INTEGER);
CREATE TABLE ark_private_asset_bindings (id TEXT PRIMARY KEY, user_id TEXT, resource_id TEXT, project_name TEXT, ark_asset_id TEXT);
CREATE TABLE logical_models (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE logical_model_revisions (id TEXT PRIMARY KEY, logical_model_id TEXT, capability_spec_json TEXT);
CREATE TABLE prompt_templates (id TEXT PRIMARY KEY, created_by TEXT, content TEXT);
CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT);
CREATE TABLE o_auth_states (id TEXT PRIMARY KEY, code_verifier TEXT);
CREATE TABLE canvas_shares (id TEXT PRIMARY KEY, project_id TEXT, token_cipher TEXT);
CREATE TABLE user_oss_settings (id TEXT PRIMARY KEY, user_id TEXT, value_json TEXT);
CREATE TABLE project_asset_links (id TEXT PRIMARY KEY, project_id TEXT, asset_id TEXT, folder_id TEXT);
CREATE TABLE assets (id TEXT PRIMARY KEY, user_id TEXT, primary_version_id TEXT, title TEXT, payload_json TEXT);
CREATE TABLE asset_versions (id TEXT PRIMARY KEY, asset_id TEXT, definition_json TEXT);
CREATE TABLE asset_representations (id TEXT PRIMARY KEY, task_id TEXT, asset_version_id TEXT, resource_id TEXT, metadata_json TEXT);
CREATE TABLE resources (id TEXT PRIMARY KEY, user_id TEXT, provider TEXT, storage_setting_id TEXT, object_key TEXT, public_url TEXT);
CREATE TABLE credit_accounts (user_id TEXT PRIMARY KEY, available_microcredits INTEGER);
CREATE TABLE credit_ledger_entries (id TEXT PRIMARY KEY, user_id TEXT, amount_microcredits INTEGER);
CREATE TABLE billing_orders (id TEXT PRIMARY KEY, user_id TEXT, task_id TEXT, amount_microcredits INTEGER);
CREATE TABLE redeem_batches (id TEXT PRIMARY KEY, codes_cipher TEXT);
CREATE TABLE redeem_codes (id TEXT PRIMARY KEY, batch_id TEXT, code_hash TEXT);
CREATE TABLE admin_audit_events (id TEXT PRIMARY KEY, metadata_json TEXT);
INSERT INTO projects VALUES ('project-target', 'user-1', '真实项目');
INSERT INTO projects VALUES ('project-other', 'user-1', '其他项目');
INSERT INTO project_units VALUES ('unit-target', 'project-target', '第1集');
INSERT INTO project_units VALUES ('unit-other', 'project-other', '其他集');
INSERT INTO canvas_projects VALUES ('canvas-target', 'project-target', 'user-1', '画布', '{"resourceId":"resource-direct","token":"canvas-secret"}');
INSERT INTO canvas_projects VALUES ('canvas-other', 'project-other', 'user-1', '其他画布', '{"resourceId":"resource-other"}');
INSERT INTO canvas_unit_links VALUES ('canvas-link-target', 'canvas-target', 'unit-target', 'production');
INSERT INTO canvas_unit_links VALUES ('canvas-link-other', 'canvas-other', 'unit-other', 'production');
INSERT INTO workflow_template_versions VALUES ('workflow-template-target', 'target-flow', '{"steps":[]}');
INSERT INTO workflow_template_versions VALUES ('workflow-template-other', 'other-flow', '{"steps":[]}');
INSERT INTO workflow_instances VALUES ('workflow-target', 'project-target', 'workflow-template-target');
INSERT INTO workflow_instances VALUES ('workflow-other', 'project-other', 'workflow-template-other');
INSERT INTO users VALUES ('user-1', 'password-secret', '本地用户');
INSERT INTO model_channels VALUES ('channel-1', 'user-1', 'sk-secret-api-key', 'provider-secret', '{"Authorization":"Bearer hidden"}');
INSERT INTO channel_models VALUES ('model-1', 'channel-1', 'provider-model-secret');
INSERT INTO model_pricings VALUES ('price-1', 'channel-1', 'provider-model-secret', 1000000);
INSERT INTO ark_private_asset_bindings VALUES ('ark-1', 'user-1', 'resource-target', 'external-project', 'external-asset-secret');
INSERT INTO logical_models VALUES ('logical-1', 'private-catalog');
INSERT INTO logical_model_revisions VALUES ('logical-revision-1', 'logical-1', '{"provider":"external"}');
INSERT INTO prompt_templates VALUES ('prompt-1', 'user-1', 'private prompt');
INSERT INTO auth_sessions VALUES ('session-1', 'user-1', 'session-secret');
INSERT INTO o_auth_states VALUES ('oauth-1', 'verifier-secret');
INSERT INTO canvas_shares VALUES ('share-1', 'project-target', 'cipher-secret');
INSERT INTO user_oss_settings VALUES ('oss-1', 'user-1', '{"secret":"hidden"}');
INSERT INTO project_asset_links VALUES ('link-target', 'project-target', 'asset-target', '');
INSERT INTO project_asset_links VALUES ('link-other', 'project-other', 'asset-other', '');
INSERT INTO assets VALUES ('asset-target', 'user-1', 'version-target', '目标素材', '{}');
INSERT INTO assets VALUES ('asset-other', 'user-1', 'version-other', '其他素材', '{}');
INSERT INTO asset_versions VALUES ('version-target', 'asset-target', '{}');
INSERT INTO asset_versions VALUES ('version-other', 'asset-other', '{}');
INSERT INTO asset_representations VALUES ('representation-target', '', 'version-target', 'resource-target', '{}');
INSERT INTO asset_representations VALUES ('representation-other', '', 'version-other', 'resource-other', '{}');
INSERT INTO resources VALUES ('resource-target', 'user-1', 'local', 'oss-secret-id', 'users/user-1/image/target.bin', 'https://signed.invalid/target?token=secret');
INSERT INTO resources VALUES ('resource-direct', 'user-1', 'local', '', 'users/user-1/image/direct.bin', '');
INSERT INTO resources VALUES ('resource-other', 'user-1', 'local', '', 'users/user-1/image/other.bin', '');
INSERT INTO credit_accounts VALUES ('user-1', 1000000);
INSERT INTO credit_ledger_entries VALUES ('credit-1', 'user-1', 1000000);
INSERT INTO billing_orders VALUES ('billing-1', 'user-1', '', 1000000);
INSERT INTO redeem_batches VALUES ('batch-1', 'cipher-secret');
INSERT INTO redeem_codes VALUES ('code-1', 'batch-1', 'hash-secret');
INSERT INTO admin_audit_events VALUES ('audit-1', '{"token":"audit-secret"}');
SQL
source_hash=$(shasum -a 256 "$source_data/open_ai_canvas.db" | awk '{print $1}')

FILMOS_PILOT_SUPPORT_ROOT="$pilot_support" "$macos_root/scripts/prepare-pilot-project-copy" \
    --source-data-dir "$source_data" --pilot-data-dir "$pilot_data" --project-id project-target >/dev/null

test "$(shasum -a 256 "$source_data/open_ai_canvas.db" | awk '{print $1}')" = "$source_hash"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM projects;')" = "1"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT name FROM projects;')" = "真实项目-PILOT"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM project_units;')" = "1"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM canvas_unit_links;')" = "1"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT id FROM canvas_unit_links;')" = "canvas-link-target"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM workflow_template_versions;')" = "1"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT id FROM workflow_template_versions;')" = "workflow-template-target"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM model_channels;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM channel_models;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM model_pricings;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM ark_private_asset_bindings;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM logical_models;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM logical_model_revisions;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM prompt_templates;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM auth_sessions;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM canvas_shares;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" "SELECT COUNT(*) FROM users WHERE password_hash <> '';" )" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM assets;')" = "1"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT title FROM assets;')" = "目标素材"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM resources;')" = "2"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" "SELECT COUNT(*) FROM resources WHERE id = 'resource-other';")" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM credit_accounts;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM credit_ledger_entries;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM billing_orders;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM redeem_batches;')" = "0"
test "$(sqlite3 "$pilot_data/open_ai_canvas.db" 'SELECT COUNT(*) FROM admin_audit_events;')" = "0"
test -f "$pilot_data/resources/users/user-1/image/target.bin"
test -f "$pilot_data/resources/users/user-1/image/direct.bin"
test ! -e "$pilot_data/resources/users/user-1/image/other.bin"
grep -q '"nonempty_secret_field_count": 0' "$pilot_data/PILOT_COPY_MANIFEST.json"
grep -q '"finance_row_count": 0' "$pilot_data/PILOT_COPY_MANIFEST.json"
grep -q '"local_resource_files_copied": 2' "$pilot_data/PILOT_COPY_MANIFEST.json"
grep -q '"source_authority": "formal-project-scoped-sanitized-copy"' "$pilot_data/PILOT_COPY_MANIFEST.json"
grep -q '"global_catalog_policy": "clear-user-and-provider-global-catalogs-retain-only-referenced-workflow-template-versions"' "$pilot_data/PILOT_COPY_MANIFEST.json"

FILMOS_PILOT_SUPPORT_ROOT="$pilot_support" "$macos_root/scripts/backup-pilot-data" --pilot-data-dir "$pilot_data" >/dev/null
test "$(find "$pilot_support/AutoBackups" -type f -name '*.filmosbackup' | wc -l | tr -d ' ')" = "1"
unzip -tq "$(find "$pilot_support/AutoBackups" -type f -name '*.filmosbackup')" >/dev/null
FILMOS_PILOT_SUPPORT_ROOT="$pilot_support" "$macos_root/scripts/restore-pilot-backup" \
    --archive "$(find "$pilot_support/AutoBackups" -type f -name '*.filmosbackup')" \
    --restore-data-dir "$pilot_support/RestoreValidation/WorkbenchData" >/dev/null
test "$(sqlite3 "$pilot_support/RestoreValidation/WorkbenchData/open_ai_canvas.db" 'SELECT COUNT(*) FROM projects;')" = "1"
test "$(sqlite3 "$pilot_support/RestoreValidation/WorkbenchData/open_ai_canvas.db" 'SELECT COUNT(*) FROM resources;')" = "2"
test -f "$pilot_support/RestoreValidation/WorkbenchData/RESTORE_RECEIPT.json"

printf 'PILOT_DATA_SCRIPTS_PASS source_unchanged=true project_count=1 asset_count=1 resource_count=2 finance_count=0 secret_count=0 backup_count=1 restore_validated=true\n'
