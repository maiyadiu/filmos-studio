import { saveRemoteUserDataNow } from "@/services/user-data-sync";
import { flushCanvasStorePersistence } from "@/stores/canvas/use-canvas-store";
import { flushAssetStorePersistence } from "@/stores/use-asset-store";

declare global {
    interface Window {
        filmOSSaveCurrentCanvas?: () => Promise<boolean>;
        filmOSFlushForBackup?: () => Promise<{ status: "ready" }>;
    }
}

export function installDesktopBackupBridge() {
    window.filmOSFlushForBackup = async () => {
        if (window.filmOSSaveCurrentCanvas) {
            const saved = await window.filmOSSaveCurrentCanvas();
            if (!saved) throw new Error("当前画布未能完成持久化");
        }
        await Promise.all([flushCanvasStorePersistence(), flushAssetStorePersistence()]);
        await saveRemoteUserDataNow();
        return { status: "ready" };
    };
}
