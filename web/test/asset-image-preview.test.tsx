import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CachedResourceImage } from "../src/components/cached-resource-image";
import { AssetMediaPreview } from "../src/components/asset-media-preview";
import { ProjectAssetImage } from "../src/pages/projects/detail/project-asset-image";
import type { ProjectAsset } from "../src/services/api/projects";
import type { ImageAsset } from "../src/stores/use-asset-store";

const key = "generation-image:guest:fixture-result";
const stale = "blob:https://fixture.invalid/expired-document";
const personal: ImageAsset = { id: "fixture-image", kind: "image", title: "生成图片", coverUrl: stale, tags: [], createdAt: "fixture", updatedAt: "fixture", data: { storageKey: key, dataUrl: stale, width: 2, height: 1, bytes: 4, mimeType: "image/png" } };
const project: ProjectAsset = { id: personal.id, title: personal.title, mediaType: "image", storageKey: key, category: "other", status: "confirmed", versionCount: 1, usages: [], position: 0, updatedAt: "fixture" };
const fallback = <span>图片暂不可用</span>;

test("local generation images wait for their storage reference instead of rendering persisted blob URLs", () => {
    const html = renderToStaticMarkup(<AssetMediaPreview asset={personal} alt="fixture" fallback={fallback} />);
    expect(html).toContain("图片暂不可用");
    expect(html).not.toContain(stale);
    expect(html).not.toContain("<img");
});

test("project thumbnail and preview accept project storage without a hydrated personal catalog", () => {
    for (const personalAsset of [undefined, personal]) {
        const html = renderToStaticMarkup(<ProjectAssetImage asset={project} personalAsset={personalAsset} fallback={fallback} />);
        expect(html).toContain("cached-resource-image-shell");
        expect(html).toContain("图片暂不可用");
        expect(html).not.toContain(stale);
    }
});

test("server resource thumbnails still defer authenticated cache reads until mount", () => {
    const html = renderToStaticMarkup(<CachedResourceImage storageKey="resource:fixture" src="/api/resources/fixture/file" fallback={fallback} />);
    expect(html).toContain("图片暂不可用");
    expect(html).not.toContain("<img");
});

test("unkeyed direct images keep their source; absent images render the supplied fallback", () => {
    expect(renderToStaticMarkup(<CachedResourceImage src="data:image/png;base64,fixture" alt="fixture" />)).toContain('src="data:image/png;base64,fixture"');
    expect(renderToStaticMarkup(<CachedResourceImage fallback={fallback} />)).toBe("<span>图片暂不可用</span>");
});
