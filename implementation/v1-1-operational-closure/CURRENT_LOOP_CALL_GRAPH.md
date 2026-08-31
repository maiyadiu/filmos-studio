# 当前闭环调用图

## 已存在

```text
ReportIssuePortal
  -> LocalForage draft
  -> WebKit reviewIssueRequest
  -> FilmOSStudioDesktop
  -> POST Review Bus /v1/issues
  -> SQLite WAL append-only event + mutable projection

ChatGPT active conversation
  -> Secure Tunnel
  -> FilmOSChatGPTMCP read-only review tools
  -> Review Bus redacted projection

Chrome extension user click
  -> challenge
  -> decision
  -> Review Bus writeback
```

## 基线断点

```text
Issue persisted
  -X-> packaged Codex Watcher
  -X-> Codex subscription BrainSession
  -X-> automatic complete Evidence Pack

ChatGPT CHANGES_REQUIRED
  -X-> atomic Verdict + Findings
  -X-> Candidate A supersede
  -X-> Candidate B

paired assessments
  -X-> Consensus Proposal
  -X-> dual response
  -X-> immutable Consensus Record
  -X-> Issue Task Package
```

## 目标

```text
Issue -> Evidence -> Codex Assessment -> ChatGPT Assessment
      -> Consensus Proposal -> dual accept -> Issue Task Package
      -> Candidate A -> ChatGPT Findings -> Candidate A superseded
      -> Codex Session resumes -> Candidate B -> remote verify
      -> Codex LOCAL_ACCEPTED + ChatGPT EXTERNAL_APPROVED + Machine PASS
      -> Dual Signoff -> Next Pilot Allowed
```
