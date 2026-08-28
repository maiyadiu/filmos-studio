import fixture from "./fixtures/golden-b.json";
import { replayGoldenBFixture, type HostAssetInventorySnapshot } from "./host-inventory";

export function runGoldenBLocalFixture() {
    return replayGoldenBFixture(fixture as HostAssetInventorySnapshot);
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
    process.stdout.write(`${JSON.stringify(runGoldenBLocalFixture())}\n`);
}
