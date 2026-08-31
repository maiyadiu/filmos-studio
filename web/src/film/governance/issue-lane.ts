export type IssueRoutingContext = {
    surface: "global" | "project" | "content-unit" | "canvas" | "agent" | "generation-composer" | "error";
    pathname: string;
};

export type IssueRoutingInput = {
    occurred: string;
    expected: string;
    blocking: boolean;
    context: IssueRoutingContext;
};

export type IssueRoutingRisk = {
    architecture_gap?: boolean;
    core_state?: boolean;
};

const ARCHITECTURE_MARKERS = [
    /架构|整体重构|重新设计|另起架构|现有结构.+不符合|未来功能.+限制|重复系统/i,
    /architecture|redesign|structural gap/i,
];

const CORE_MARKERS = [
    /Film Core|Review Bus|Candidate|双专家|ChatGPT Findings?|Consensus|MCP|Runtime|Provider/i,
    /预算|账本|权限|授权|认证|登录|密钥|迁移|数据丢失|重复提交|串线|状态权威|回滚/i,
    /Budget|Ledger|Auth|Secret|Token|Cookie|Migration|Data Loss|Duplicate Submit|Session|Stale/i,
];

/**
 * The reporter never chooses Fast/Core/Architecture. FilmOS derives a
 * conservative structured risk signal from the observed workflow and forwards
 * that signal to Review Bus, whose constitution remains the lane authority.
 */
export function inferIssueRoutingRisk(input: IssueRoutingInput): IssueRoutingRisk {
    const material = `${input.context.surface}\n${input.context.pathname}\n${input.occurred}\n${input.expected}`;
    if (ARCHITECTURE_MARKERS.some((pattern) => pattern.test(material))) return { architecture_gap: true };

    const blockedOperationalSurface = input.blocking
        && ["agent", "generation-composer", "error"].includes(input.context.surface);
    if (blockedOperationalSurface || CORE_MARKERS.some((pattern) => pattern.test(material))) {
        return { core_state: true };
    }
    return {};
}
