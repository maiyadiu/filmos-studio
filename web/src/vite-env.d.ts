/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_CHANGELOG__: string;

interface ImportMetaEnv {
    readonly VITE_FILMOS_BUILD_COMMIT?: string;
    readonly VITE_FILMOS_BUILD_TREE?: string;
    readonly VITE_FILMOS_BUILD_ID?: string;
    readonly VITE_FILMOS_RELEASE_CHANNEL?: "development" | "candidate" | "pilot" | "stable";
    readonly VITE_FILMOS_EXTERNAL_PAID_SUBMIT_ENABLED?: "true" | "false";
}
