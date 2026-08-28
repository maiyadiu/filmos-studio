# Track 14 shared contract request

Track 14 does not modify shared Film Core stable IDs or Host project data. Program Integrator 已完成七个中央默认关闭开关、Web Handoff、macOS bundle 文件关联/Keychain/Preview CLI 与合同源的集成。

Integrated Program changes:

1. Integrate these central defaults, all `false`: `film.chatgpt_app`, `film.chatgpt_read_tools`, `film.chatgpt_widgets`, `film.chatgpt_secure_tunnel`, `film.chatgpt_proposal_handoff`, `film.chatgpt_write_tools`, `film.chatgpt_api_panel`.
2. Wire `web/src/film/chatgpt/ChatGPTHandoffPanel.tsx` into the project surface only when the first flag is explicitly true.
3. Wire the loopback health, Keychain and proposal open/import handler into the real `desktop/macos` bundle.
4. Register `com.filmos.proposal` / `.filmosproposal` in `desktop/macos/App/Info.plist` using `CFBundleDocumentTypes` and `UTExportedTypeDeclarations`.
5. Keep `packages/filmos-tool-contracts/contract.v1.json` as the Track 14 source; any Film Core shared schema promotion requires separate Owner review.

The matching runtime names are documented in `.env.example`. `read_tools` and `widgets` are independently enforced; write tools and the API panel remain unregistered. No candidate/dev process automatically flips a repository default. This request is now `INTEGRATED_LOCAL`; external ChatGPT/Tunnel remains `BLOCKED_EXTERNAL_ACCOUNT`.

No request changes Stable IDs, Film Core `expected_version/content_hash`, Host tables, Canvas JSON, or authority boundaries.
