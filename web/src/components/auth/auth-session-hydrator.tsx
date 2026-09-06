import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "antd";
import { RefreshCw, Unplug } from "lucide-react";

import { applyUserSession } from "@/lib/user-session";
import { getAuthSession } from "@/services/api/auth";
import { FullScreenLoader } from "@/components/ui/aceternity/full-screen-loader";
import { preloadWorkspaceRoute } from "@/lib/workspace-route-modules";
import { useUserStore } from "@/stores/use-user-store";

export function AuthSessionHydrator({ children }: { children: ReactNode }) {
    const hydrated = useUserStore((state) => state.hydrated);
    const [attempt, setAttempt] = useState(0);
    const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

    useEffect(() => {
        let cancelled = false;
        // 登录态与当前工作区 chunk 并行恢复，避免进入应用后再出现一次页面级等待。
        preloadWorkspaceRoute(window.location.pathname);
        getAuthSession({ refresh: attempt > 0 })
            .then(async (payload) => {
                if (cancelled) return;
                await applyUserSession(payload);
                if (!cancelled) setStatus("ready");
            })
            .catch(() => {
                // 无法确认会话不等于游客；保留现有身份和路由，恢复前不挂载工作区。
                if (!cancelled) setStatus("error");
            });
        return () => {
            cancelled = true;
        };
    }, [attempt]);

    if (status === "error") {
        const localBrowser = ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);
        return (
            <main className="grid min-h-dvh place-items-center bg-background p-6 text-foreground">
                <section role="alert" aria-labelledby="workbench-connection-title" className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8">
                    <Unplug aria-hidden className="mb-5 size-8 text-muted-foreground" />
                    <p className="mb-2 text-sm font-medium text-muted-foreground">FilmOS Studio</p>
                    <h1 id="workbench-connection-title" className="text-xl font-semibold">暂时无法进入工作台</h1>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">暂时无法确认工作台会话。请检查服务连接或账号状态后重试；不会把连接失败当成未登录。</p>
                    {localBrowser ? <p className="mt-3 text-sm leading-relaxed text-muted-foreground">本机源码模式无需公开账号登录。请通过源码目录中的“源码启动.command”打开；临时验收页面不是日常启动入口。</p> : null}
                    <Button type="primary" className="mt-6" icon={<RefreshCw className="size-4" />} onClick={() => { setStatus("loading"); setAttempt((value) => value + 1); }}>重新连接</Button>
                </section>
            </main>
        );
    }
    return status === "ready" && hydrated ? children : <FullScreenLoader />;
}
