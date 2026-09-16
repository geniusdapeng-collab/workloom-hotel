import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const product = JSON.parse(readFileSync(resolve(root, "product.manifest.json"), "utf8"));
const builder = readFileSync(resolve(root, "electron-builder.yml"), "utf8");

test("酒店固定下载资产沿用稳定 ASCII 点号前缀", () => {
  assert.equal(product.release.artifactPrefix, "WorkLoom.Hotel");
  assert.match(builder, /artifactName: "WorkLoom\.Hotel-\$\{os\}-\$\{arch\}\.\$\{ext\}"/u);
  assert.doesNotMatch(product.release.artifactPrefix, /\s/u);
});
