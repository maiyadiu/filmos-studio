import { describe, expect, test } from "bun:test";
import { decodeNovelText, splitTextIntoChapters } from "../src/lib/canvas/canvas-document";

describe("splitTextIntoChapters", () => {
    test("识别常见中文、Markdown、装饰符与英文标题", () => {
        const chapters = splitTextIntoChapters(`书名与作者

第 1 章 初入江湖
第一章正文

＃ 第２章 风雨欲来
第二章正文

【第三章】再会故人
第三章正文

卷四 山河故人
第四章正文

Epilogue: 重逢
尾声正文`);

        expect(chapters.map((chapter) => chapter.title)).toEqual(["序章", "第 1 章 初入江湖", "第２章 风雨欲来", "【第三章】再会故人", "卷四 山河故人", "Epilogue: 重逢"]);
        expect(chapters[0].plainText).toBe("书名与作者");
        expect(chapters[2].plainText).toBe("第二章正文");
    });

    test("普通正文和未识别文本保持为单个章节", () => {
        const text = "这是第一章中发生的故事。\n角色继续前行。";
        const chapters = splitTextIntoChapters(text);

        expect(chapters).toHaveLength(1);
        expect(chapters[0].title).toBe("第 1 章");
        expect(chapters[0].plainText).toBe(text);
    });

    test("整本剧本可按集和幕标题一次拆分", () => {
        const chapters = splitTextIntoChapters(`第001集 归乡
第一集正文

第002集：雨夜
第二集正文

第三幕 告别
第三幕正文`);

        expect(chapters.map((chapter) => chapter.title)).toEqual(["第001集 归乡", "第002集：雨夜", "第三幕 告别"]);
        expect(chapters.map((chapter) => chapter.plainText)).toEqual(["第一集正文", "第二集正文", "第三幕正文"]);
    });

    test("001-020 集 Markdown 范围标题不占章且竖线集标题完整拆分", () => {
        const episodes = Array.from({ length: 20 }, (_, index) => {
            const number = String(index + 1).padStart(3, "0");
            return `# 第${number}集 | 第${number}集标题\n**目标时长：55秒**\n第${number}集正文`;
        }).join("\n\n");
        const chapters = splitTextIntoChapters(`# 《月老到底管了个啥？》
## 第001—020集 完整文学性对白剧本 V3.2

> 基准：项目当前执行索引。

---

${episodes}`);

        expect(chapters).toHaveLength(20);
        expect(chapters[0].title).toBe("第001集 | 第001集标题");
        expect(chapters[19].title).toBe("第020集 | 第020集标题");
        expect(chapters[0].plainText).toContain("第001—020集 完整文学性对白剧本 V3.2");
        expect(chapters[0].plainText).toContain("第001集正文");
        expect(chapters[19].plainText).toContain("第020集正文");
    });
});

describe("decodeNovelText", () => {
    test("解码带 BOM 的 UTF-16LE", () => {
        const bytes = new Uint8Array([0xff, 0xfe, 0x2c, 0x7b, 0x00, 0x4e, 0xe0, 0x7a]);
        expect(decodeNovelText(bytes.buffer)).toBe("第一章");
    });

    test("UTF-8 严格解码失败后回退到 GB18030", () => {
        const bytes = new Uint8Array([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0a, 0xd5, 0xfd, 0xce, 0xc4]);
        expect(decodeNovelText(bytes.buffer)).toBe("第一章\n正文");
    });
});
