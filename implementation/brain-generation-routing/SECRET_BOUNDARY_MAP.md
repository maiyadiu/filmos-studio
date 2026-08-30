# Secret Boundary Map

| Secret | Authority | Stable record stores |
|---|---|---|
| API keys | existing secure channel store/backend secret boundary | opaque secret reference only |
| ChatGPT runtime key | macOS Keychain | tunnel/profile status only |
| CLI tokens | CLI-owned login store | pseudonymous binding reference only |
| Provider binding proof | broker/secure runtime | opaque proof reference only |

Secrets, cookies, raw credentials, private paths and alias mappings are excluded from project exports, logs, catalog snapshots, hashes, receipts and convenience ZIPs.
