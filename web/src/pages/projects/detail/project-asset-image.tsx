import type { ReactNode } from "react";

import { CachedResourceImage } from "@/components/cached-resource-image";
import { resourceFileUrl, resourceIdFromStorageKey } from "@/services/api/resources";
import type { ProjectAsset } from "@/services/api/projects";
import type { Asset } from "@/stores/use-asset-store";

/** 列表与大图使用同一存储引用，个人素材缓存尚未载入也能恢复项目内图片。 */
export function ProjectAssetImage({ asset, personalAsset, className, fallback }: {
    asset: ProjectAsset;
    personalAsset?: Asset;
    className?: string;
    fallback?: ReactNode;
}) {
    const personalImage = personalAsset?.kind === "image" ? personalAsset : undefined;
    const storageKey = personalImage?.data.storageKey || asset.storageKey;
    const resourceId = resourceIdFromStorageKey(storageKey);
    const src = personalImage?.coverUrl || personalImage?.data.dataUrl || (resourceId ? resourceFileUrl(resourceId) : "");
    return <CachedResourceImage storageKey={storageKey} src={src} alt={asset.title} className={className} fallback={fallback} />;
}
