const ISSUE_ID = "FILMOS-ISSUE-UI-GOLDEN-001";
const PROJECT_ID = "filmos-ui-golden-project";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const candidateA = {
    round: 1,
    status: "SUPERSEDED",
    superseded_by_candidate_id: "candidate-b-ui-golden",
    candidate: {
        candidate_id: "candidate-a-ui-golden",
        candidate_commit: "1".repeat(40),
        submitted_at: "2026-09-01T01:10:00.000Z",
        github_run: { id: "33465128043", url: "https://github.com/maiyadiu/filmos-studio/actions/runs/33465128043" },
        artifact_id: "9784705257",
        github_remote_verification: { status: "VERIFIED", repository: "maiyadiu/filmos-studio", content_hash: HASH_A },
    },
};

const candidateB = {
    round: 2,
    status: "APPROVED",
    candidate: {
        candidate_id: "candidate-b-ui-golden",
        candidate_commit: "2".repeat(40),
        submitted_at: "2026-09-01T02:20:00.000Z",
        github_run: { id: "33466888838", url: "https://github.com/maiyadiu/filmos-studio/actions/runs/33466888838" },
        artifact_id: "9784705258",
        artifact_digest: `sha256:${HASH_B}`,
        evidence_index_hash: HASH_C,
        github_remote_verification: {
            status: "VERIFIED",
            repository: "maiyadiu/filmos-studio",
            content_hash: HASH_B,
            checks: { commit: true, tree: true, run: true, artifact: true, evidence_index: true },
        },
    },
};

const approvedIssue = {
    issue_id: ISSUE_ID,
    project_id: PROJECT_ID,
    lane: "core",
    state: "DUAL_APPROVED",
    current_round: 2,
    updated_at: "2026-09-01T02:30:00.000Z",
    report: {
        what_happened: "用户在真实打包 App 中提交了连接与使用反馈。",
        expected_result: "双专家闭环、候选证据和 Pilot Gate 在同一事实入口完整可见。",
    },
    evidence: {
        manifest: {
            contentHash: HASH_A,
            completeness: { report: true, context: true, build_identity: true, attachments: true, event_chain: true },
        },
    },
    attachments: [{ attachment_id: "attachment-ui-golden", media_type: "image/png", content_hash: HASH_B }],
    assessments: {
        codex: { verdict: "ACCEPT", round: 2, summary: "本地实现与冻结 Task Package 一致。", evidence_manifest_hash: HASH_A },
        chatgpt: { verdict: "ACCEPT", round: 2, summary: "外部只读复核通过。", evidence_manifest_hash: HASH_A },
    },
    consensus_delta: { items: [], status: "CLOSED", content_hash: HASH_B },
    consensus_proposal: { decision: "IMPLEMENT", task_package_hash: HASH_C, status: "ACCEPTED" },
    consensus_record: { codex: "ACCEPTED", chatgpt: "ACCEPTED", content_hash: HASH_C },
    findings: [
        { finding_id: "finding-noauth", severity: "P0", title: "ChatGPT noauth 合同", status: "CLOSED", problem: "插件曾误走 OAuth。", required_change: "固定为无身份验证并保留 Project Grant。" },
        { finding_id: "finding-roundtrip", severity: "P1", title: "多轮证据闭环", status: "CLOSED", problem: "历史轮次必须追加保存。", required_change: "验证 A→B 与事件链。" },
        { finding_id: "finding-app", severity: "P1", title: "已安装 App 身份", status: "CLOSED", problem: "稳定路径必须对应最终候选。", required_change: "核对 Commit、Tree 与 Build。" },
    ],
    finding_responses: [
        { finding_id: "finding-noauth", disposition: "FIXED_WITH_EVIDENCE" },
        { finding_id: "finding-roundtrip", disposition: "FIXED_WITH_EVIDENCE" },
        { finding_id: "finding-app", disposition: "FIXED_WITH_EVIDENCE" },
    ],
    candidate_history: [candidateA, candidateB],
    active_candidate: candidateB.candidate,
    codex_coordination: { status: "COMPLETED", last_action: "CANDIDATE_B_DOUBLE_SIGNOFF_COMPLETED", last_error_code: null },
    runtime_recovery: { observed_start_ids: ["runtime-start-1", "runtime-start-2"] },
    event_chain_verified: true,
    requirement_delta: { status: "NO_SCOPE_EXPANSION", items: [] },
    architecture_options: [{ option_id: "keep-v1-1", title: "保持 V1.1 总体架构", impact: "仅收口生产接线" }],
    accepted_architecture_option: "keep-v1-1",
    decision_history: [{ decision: "APPROVED", actor: "project_owner" }],
    verdicts: { codex: "LOCAL_ACCEPTED", chatgpt: "EXTERNAL_APPROVED", machine: "PASS" },
    dual_signoff: { content_hash: HASH_C, codex: "LOCAL_ACCEPTED", chatgpt: "EXTERNAL_APPROVED", machine: "PASS" },
};

const ownerDecisionIssue = {
    ...approvedIssue,
    state: "OWNER_DECISION_REQUIRED",
    current_round: 3,
    dual_signoff: null,
    verdicts: { codex: "WAITING", chatgpt: "WAITING", machine: "WAITING" },
    requirement_delta: { status: "SCOPE_EXPANSION", items: ["是否扩展到新的外部 Provider"] },
    architecture_options: [
        { option_id: "keep-boundary", title: "保持当前边界", impact: "Pilot 可继续，费用保持为 0" },
        { option_id: "expand-provider", title: "扩展 Provider", impact: "需要新的授权与验收" },
    ],
    accepted_architecture_option: null,
};

export function installUiGoldenFixture() {
    const mode = new URL(window.location.href).searchParams.get("ui-golden") || "";
    const issue = mode === "owner" ? ownerDecisionIssue : approvedIssue;
    window.filmOSReviewCenterRequest = async (operation) => {
        if (operation === "list_issues") return { issues: [issue] };
        if (operation === "list_bridge_clients") return { clients: [{ client_id: "bridge-client-ui-golden", client_name: "Chrome · FilmOS Review Bridge", created_at: "2026-09-01T01:00:00.000Z", last_seen_at: "2026-09-01T02:30:00.000Z", revoked_at: null }] };
        if (operation === "get_issue") return issue;
        if (operation === "create_pairing_code") return { pairing_code: "834216", expires_at: "2099-09-01T02:35:00.000Z" };
        if (operation === "revoke_bridge_client") return { revoked: true };
        throw new Error(`UI_GOLDEN_UNSUPPORTED_OPERATION:${operation}`);
    };
    const activate = () => window.setTimeout(() => activateFixture(mode), 300);
    if (document.readyState === "complete") activate();
    else window.addEventListener("load", activate, { once: true });
}

function activateFixture(mode: string) {
    if (mode.startsWith("report")) {
        poll(() => {
            if (!window.filmOSReportIssue) return false;
            window.filmOSReportIssue("global");
            window.setTimeout(() => fillReportFixture(mode === "report-paste", mode), 350);
            return true;
        });
        return;
    }
    if (mode === "document-markdown") {
        poll(() => clickButton("Markdown") && markReady(mode));
        return;
    }
    if (mode === "document-readable") {
        poll(() => document.body.textContent?.includes("FilmOS UI Golden") === true && markReady(mode));
        return;
    }
    if (mode === "pairing") {
        poll(() => {
            if (!clickButton("生成6位配对码")) return false;
            window.setTimeout(() => poll(() => document.body.textContent?.includes("834216") === true && markReady(mode)), 100);
            return true;
        });
        return;
    }
    if (["review-top", "review-middle", "review-candidate", "review-bottom", "owner"].includes(mode)) {
        poll(() => {
            const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(ISSUE_ID));
            if (!button) return false;
            button.click();
            window.setTimeout(() => poll(() => scrollReviewDrawer(mode)), 200);
            return true;
        });
    }
}

function fillReportFixture(withAttachment: boolean, mode: string) {
    const occurred = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="例如：在画布 Agent"]');
    const expected = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="描述期望结果"]');
    if (!occurred || !expected) {
        window.setTimeout(() => fillReportFixture(withAttachment, mode), 100);
        return;
    }
    setTextarea(occurred, "连接 FilmOS Studio 时显示未成功，需要保留现场证据。");
    window.setTimeout(() => {
        setTextarea(expected, "连接成功并进入双专家 Review Bus 闭环。");
        if (!withAttachment) {
            poll(() => reportFieldsReady(occurred, expected) && markReady(mode));
            return;
        }
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNkYGD4z8DAwMDEAAUADikBAzN1kSIAAAAASUVORK5CYII="), (value) => value.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], "连接失败截图.png", { type: "image/png", lastModified: 1_788_224_400_000 }));
        occurred.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
        poll(() => reportFieldsReady(occurred, expected)
            && document.body.textContent?.includes("连接失败截图.png") === true
            && markReady(mode));
    }, 75);
}

function setTextarea(element: HTMLTextAreaElement | undefined, value: string) {
    if (!element) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
}

function reportFieldsReady(occurred: HTMLTextAreaElement, expected: HTMLTextAreaElement) {
    return occurred.value === "连接 FilmOS Studio 时显示未成功，需要保留现场证据。"
        && expected.value === "连接成功并进入双专家 Review Bus 闭环。";
}

function clickButton(label: string) {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    if (!button) return false;
    button.click();
    return true;
}

function scrollReviewDrawer(mode: string) {
    const body = document.querySelector<HTMLElement>(".ant-drawer-body");
    if (!body) return false;
    const positions: Record<string, number> = { "review-top": 0, "review-middle": 720, "review-candidate": 1450, "review-bottom": 2600, owner: 0 };
    body.scrollTop = positions[mode] ?? 0;
    return markReady(mode);
}

function markReady(mode: string) {
    document.documentElement.dataset.filmosUiGoldenReady = mode;
    return true;
}

function poll(action: () => boolean, attempts = 40) {
    if (action() || attempts <= 1) return;
    window.setTimeout(() => poll(action, attempts - 1), 100);
}
