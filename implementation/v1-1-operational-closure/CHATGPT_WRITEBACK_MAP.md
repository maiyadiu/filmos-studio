# ChatGPT 写回图

ChatGPT MCP 继续只读。所有写回必须来自 Chrome 用户手势和一次性 challenge。

```text
CHATGPT_ASSESSMENT
CHATGPT_REVIEW_DECISION       # 原子 Verdict + Findings + close/reopen
CHATGPT_CONSENSUS_DECISION    # 接受或请求修改 Proposal
FINDING_DECISION
```

`CHATGPT_REVIEW_DECISION` 必须验证 Issue、Candidate ID、Candidate Commit、Nonce、Task Package、Constitution 和 scope assessment。任一 Finding schema 无效时整个事务拒绝，不能留下半写入 Verdict。
