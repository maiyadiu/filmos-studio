import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const assetsDir = resolve(import.meta.dirname, "../dist/assets");
const warningBytes = 500 * 1024;
const budgets = Object.freeze({
    maxJavaScriptBytes: 1_900_000,
    maxOversizedJavaScriptChunks: 10,
    maxCanvasProjectChunkBytes: 900_000,
    maxApplicationEntryBytes: 100_000,
});

function sourceGroup(source) {
    const marker = "node_modules/";
    const index = source.lastIndexOf(marker);
    if (index < 0) return "application";
    const parts = source.slice(index + marker.length).split("/");
    return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function sourceAttribution(name) {
    const mapPath = resolve(assetsDir, `${name}.map`);
    if (!existsSync(mapPath)) return [];
    const sourceMap = JSON.parse(readFileSync(mapPath, "utf8"));
    const counts = new Map();
    for (const [index, source] of (sourceMap.sources || []).entries()) {
        const group = sourceGroup(source);
        const current = counts.get(group) || { modules: 0, sourceBytes: 0 };
        counts.set(group, {
            modules: current.modules + 1,
            sourceBytes: current.sourceBytes + (sourceMap.sourcesContent?.[index]?.length || 0),
        });
    }
    return [...counts.entries()]
        .map(([source, totals]) => ({ source, ...totals }))
        .sort((left, right) => right.sourceBytes - left.sourceBytes || right.modules - left.modules || left.source.localeCompare(right.source))
        .slice(0, 5);
}

const chunks = readdirSync(assetsDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, bytes: statSync(resolve(assetsDir, name)).size }))
    .sort((left, right) => right.bytes - left.bytes);
const oversized = chunks.filter((chunk) => chunk.bytes > warningBytes);
const canvasProject = chunks.find((chunk) => /^project-[\w-]+\.js$/.test(chunk.name));
const applicationEntry = chunks.find((chunk) => /^application-[\w-]+\.js$/.test(chunk.name));
const failures = [];

if (!canvasProject) failures.push("canvas project chunk was not found");
if (!applicationEntry) failures.push("application entry chunk was not found");
if ((chunks[0]?.bytes || 0) > budgets.maxJavaScriptBytes) failures.push(`largest JavaScript chunk exceeds ${budgets.maxJavaScriptBytes} bytes`);
if (oversized.length > budgets.maxOversizedJavaScriptChunks) failures.push(`oversized JavaScript chunk count exceeds ${budgets.maxOversizedJavaScriptChunks}`);
if (canvasProject && canvasProject.bytes > budgets.maxCanvasProjectChunkBytes) failures.push(`canvas project chunk exceeds ${budgets.maxCanvasProjectChunkBytes} bytes`);
if (applicationEntry && applicationEntry.bytes > budgets.maxApplicationEntryBytes) failures.push(`application entry chunk exceeds ${budgets.maxApplicationEntryBytes} bytes`);

console.log(
    JSON.stringify(
        {
            status: failures.length ? "FAILED" : "PASSED",
            budgets,
            largestJavaScriptChunk: chunks[0] || null,
            oversizedJavaScriptChunks: oversized.map((chunk) => ({ ...chunk, sources: sourceAttribution(chunk.name) })),
            canvasProjectChunk: canvasProject || null,
            applicationEntryChunk: applicationEntry || null,
            failures,
        },
        null,
        2,
    ),
);

if (failures.length) process.exitCode = 1;
