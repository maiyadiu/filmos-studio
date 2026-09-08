import { useEffect, useRef, useState, type ImgHTMLAttributes, type ReactNode } from "react";

import { resourceIdFromStorageKey } from "@/services/api/resources";
import { cacheResourceObjectUrl } from "@/services/resource-blob-cache";
import { resolveImageUrl } from "@/services/image-storage";
import { getActiveUserScope } from "@/lib/user-scope";

type CachedResourceImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
    storageKey?: string;
    src?: string;
    fallback?: ReactNode;
    eager?: boolean;
};

/**
 * 资源图片优先读取按用户隔离的本地 Blob 缓存，避免刷新后再次从对象存储下载。
 * 本地生成图同样按 storageKey 恢复；持久化的 blob URL 不可跨页面生命周期复用。
 * 没有存储标识的普通外链、data URL 和 Blob URL 保持直接显示。
 */
export function CachedResourceImage({ storageKey, src = "", fallback = null, eager = false, onError, ...props }: CachedResourceImageProps) {
    const remoteResource = Boolean(resourceIdFromStorageKey(storageKey));
    const scope = getActiveUserScope();
    const identity = JSON.stringify([scope, storageKey, src]);
    const targetRef = useRef<HTMLSpanElement>(null);
    const [nearViewport, setNearViewport] = useState(eager || !remoteResource);
    const [resolved, setResolved] = useState<{ identity: string; url: string; failed?: boolean }>();

    useEffect(() => {
        if (!remoteResource || eager) {
            setNearViewport(true);
            return;
        }
        const image = targetRef.current;
        if (!image || typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                setNearViewport(true);
                observer.disconnect();
            }
        }, { rootMargin: "240px" });
        observer.observe(image);
        return () => observer.disconnect();
    }, [eager, remoteResource]);

    useEffect(() => {
        let cancelled = false;
        if (!storageKey) {
            return () => { cancelled = true; };
        }
        if (!nearViewport) {
            return () => { cancelled = true; };
        }

        setResolved(undefined);
        const fallbackUrl = src.startsWith("blob:") ? "" : src;
        const resolve = remoteResource ? cacheResourceObjectUrl(storageKey) : resolveImageUrl(storageKey, fallbackUrl);
        void resolve.then((url) => {
            if (!cancelled && scope === getActiveUserScope()) setResolved({ identity, url: url || fallbackUrl });
        }).catch(() => {
            if (!cancelled && scope === getActiveUserScope()) setResolved({ identity, url: fallbackUrl });
        });
        return () => { cancelled = true; };
    }, [identity, nearViewport, remoteResource, scope, src, storageKey]);

    const current = resolved?.identity === identity ? resolved : undefined;
    const imageUrl = current?.failed ? "" : storageKey ? current?.url : src;
    const image = imageUrl ? <img {...props} src={imageUrl} onError={(event) => {
        setResolved({ identity, url: "", failed: true });
        onError?.(event);
    }} /> : fallback;
    if (!storageKey) return image;
    return (
        <span ref={targetRef} className="cached-resource-image-shell">
            {image}
        </span>
    );
}
