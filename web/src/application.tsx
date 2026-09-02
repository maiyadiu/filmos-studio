import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router";

import "@/lib/plugins/builtin";

import { AppProviders } from "@/components/layout/app-providers";
import { YingceGlobalIssuePortal } from "@/film/adapters/yingce/contributions/global-issue-portal";
import { installDesktopBackupBridge } from "@/lib/desktop-backup-bridge";
import { router } from "@/router";

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

async function startApplication() {
    installDesktopBackupBridge();
    if (import.meta.env.VITE_FILMOS_UI_GOLDEN_CAPTURE === "true") {
        const { installUiGoldenFixture } = await import("@/film/governance/ui-golden-fixture");
        installUiGoldenFixture();
    }
    createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
            <AppProviders>
                <RouterProvider router={router} />
                <YingceGlobalIssuePortal />
            </AppProviders>
        </React.StrictMode>,
    );
}

void startApplication();
