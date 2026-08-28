# Track 14 shared contract request

Track 14 does not directly modify shared Film Core, Host project, desktop bundle, or central Feature Flag contracts.

Requested Program Integrator changes:

1. Add central defaults `film.chatgpt_app: false` and `film.chatgpt_proposal_handoff: false`.
2. Wire `web/src/film/chatgpt/ChatGPTHandoffPanel.tsx` into the project surface only when the first flag is explicitly true.
3. Wire `desktop-shell/FilmOSChatGPTBridge` proposal open/import handler into the real `desktop/macos` bundle.
4. Register `com.filmos.proposal` / `.filmosproposal` in `desktop/macos/App/Info.plist` using `CFBundleDocumentTypes` and `UTExportedTypeDeclarations`.
5. Keep `packages/filmos-tool-contracts/contract.v1.json` as the Track 14 source; any Film Core shared schema promotion requires separate Owner review.

No request changes Stable IDs, Film Core `expected_version/content_hash`, Host tables, Canvas JSON, or authority boundaries.
