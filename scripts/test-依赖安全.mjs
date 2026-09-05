import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const web = createRequire(resolve(root, "web/package.json"));
const agent = createRequire(resolve(root, "canvas-agent/package.json"));
const service = createRequire(resolve(root, "services/filmos-chatgpt-app/package.json"));
const semver = agent("semver");

// Resolve from the actual consumer, not a possibly unrelated hoisted copy.
function installed(consumer, name) {
  // Some ESM-only packages intentionally have no CJS/default export. Read
  // metadata along this consumer's search path without importing private APIs.
  for (const directory of consumer.resolve.paths(name) || []) {
    const path = resolve(directory, name, "package.json");
    if (existsSync(path)) {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value.name === name) return { ...value, path };
    }
  }
  throw new Error(`PACKAGE_IDENTITY_NOT_FOUND:${name}`);
}

test("tracked locks exclude the seven known advisory families (not a full security audit)", () => {
  const floors = {
    "fast-uri": ">=3.1.6",
    "@xmldom/xmldom": ">=0.8.15",
    qs: ">=6.16.0",
    "@tiptap/core": ">=3.30.4",
    nanoid: ">=3.3.18 <4 || >=5.1.16",
    "lodash-es": ">=4.18.0",
    sharp: ">=0.35.3",
  };
  const seen = new Set();
  const check = (name, version, location) => {
    if (!(name in floors)) return;
    seen.add(name);
    assert.ok(semver.satisfies(version, floors[name]), `${location}: ${name}@${version}`);
  };
  for (const file of ["web/bun.lock", "canvas-agent/bun.lock"]) {
    for (const line of readFileSync(resolve(root, file), "utf8").split("\n")) {
      const match = line.match(/^\s*"([^"]+)":\s*\["([^"]+)"/);
      if (!match) continue;
      const split = match[2].lastIndexOf("@");
      check(match[2].slice(0, split), match[2].slice(split + 1), `${file}:${match[1]}`);
    }
  }
  for (const directory of ["services/filmos-chatgpt-app", "packages/filmos-agent-contracts", "packages/filmos-agent-tool-contracts", "packages/filmos-generation-contracts", "packages/filmos-tool-contracts"]) {
    const lock = JSON.parse(readFileSync(resolve(root, directory, "package-lock.json"), "utf8"));
    for (const [path, value] of Object.entries(lock.packages)) check(path.split("node_modules/").at(-1), value.version, `${directory}:${path}`);
  }
  assert.deepEqual([...seen].sort(), Object.keys(floors).sort());
});

test("nanoid overrides retain independent CJS and ESM consumers and the application version", async () => {
  assert.equal(installed(web, "nanoid").version, "6.0.0");
  for (const [parent, version] of [["@excalidraw/excalidraw", "3.3.18"], ["postcss", "3.3.18"], ["@excalidraw/mermaid-to-excalidraw", "5.1.16"]]) {
    const consumer = createRequire(installed(web, parent).path);
    assert.equal(installed(consumer, "nanoid").version, version);
    const { nanoid, customAlphabet } = await import(pathToFileURL(consumer.resolve("nanoid")));
    assert.match(nanoid(), /^[\w-]{21}$/);
    assert.match(customAlphabet("abc", 12)(), /^[abc]{12}$/);
  }
});

test("Tiptap keeps one peer-compatible core and resists inherited attribute injection", async () => {
  const core = installed(web, "@tiptap/core");
  const { mergeAttributes, getSchema } = await import(pathToFileURL(resolve(dirname(core.path), core.module)));
  for (const parent of ["@tiptap/react", "@tiptap/starter-kit", "@tiptap/extension-bubble-menu", "@tiptap/extension-floating-menu", "tldraw"]) {
    const consumer = createRequire(installed(web, parent).path);
    assert.equal(consumer.resolve("@tiptap/core"), web.resolve("@tiptap/core"));
    assert.equal(installed(consumer, "@tiptap/pm").version, "3.30.4");
  }
  const input = JSON.parse('{"__proto__":{"data-inherited-canary":"unexpected","onerror":"inert-test-value"}}');
  const attributes = mergeAttributes({ class: "one", style: "color: red" }, input, { class: "two", style: "font-weight: bold" });
  assert.equal(Object.getPrototypeOf(attributes), Object.prototype);
  assert.equal(attributes["data-inherited-canary"], undefined);
  assert.equal(attributes.onerror, undefined);
  assert.equal(attributes.class, "one two");
  assert.match(attributes.style, /color: red/);
  const { createCanvasRichTextExtensions } = await import(pathToFileURL(resolve(root, "web/src/lib/canvas/canvas-rich-text.ts")));
  const schema = getSchema(createCanvasRichTextExtensions());
  const document = schema.nodeFromJSON({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "FilmOS", marks: [{ type: "bold" }] }] }] });
  document.check();
  assert.equal(document.textContent, "FilmOS");
  assert.equal(document.toJSON().content[0].content[0].marks[0].type, "bold");
});

test("Express and AJV consumers resolve patched query and URI parsers", () => {
  for (const consumer of [web, agent, service]) {
    for (const parent of ["express", "body-parser"]) {
      const fromParent = createRequire(installed(consumer, parent).path);
      assert.equal(installed(fromParent, "qs").version, "6.16.0");
      assert.deepEqual(fromParent("qs").parse("item[0]=a&item[1]=b"), { item: ["a", "b"] });
    }
    const fromAjv = createRequire(installed(consumer, "ajv").path);
    assert.equal(installed(fromAjv, "fast-uri").version, "3.1.6");
    const uri = fromAjv("fast-uri");
    assert.equal(uri.serialize(uri.parse("https://example.com/a?x=1")), "https://example.com/a?x=1");
  }
});

test("Chevrotain and document import dependencies resolve patched libraries", async () => {
  for (const parent of ["chevrotain", "@chevrotain/cst-dts-gen", "@chevrotain/gast"]) {
    const consumer = createRequire(installed(web, parent).path);
    assert.equal(installed(consumer, "lodash-es").version, "4.18.1");
    const lodash = await import(pathToFileURL(consumer.resolve("lodash-es")));
    assert.deepEqual(lodash.omit({ keep: 1, remove: 2 }, ["remove"]), { keep: 1 });
  }
  const mammoth = createRequire(installed(web, "mammoth").path);
  assert.equal(installed(mammoth, "@xmldom/xmldom").version, "0.8.15");
  const { DOMParser, XMLSerializer } = mammoth("@xmldom/xmldom");
  const document = new DOMParser().parseFromString("<document><p>FilmOS &amp; test</p></document>", "application/xml");
  assert.match(new XMLSerializer().serializeToString(document), /FilmOS &amp; test/);
});

test("sharp uses the patched native libvips and a matching Node engine contract", () => {
  const sharp = agent("sharp");
  assert.equal(sharp.versions.sharp, "0.35.3");
  assert.ok(semver.gte(sharp.versions.vips, "8.18.3"));
  const manifest = JSON.parse(readFileSync(resolve(root, "canvas-agent/package.json"), "utf8"));
  assert.equal(manifest.engines.node, installed(agent, "sharp").engines.node);
  assert.ok(semver.satisfies(process.versions.node, manifest.engines.node));
});
