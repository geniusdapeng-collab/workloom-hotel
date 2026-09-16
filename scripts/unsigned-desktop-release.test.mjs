import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/build-desktop.yml"), "utf8");
const builder = fs.readFileSync(path.join(root, "electron-builder.yml"), "utf8");
const product = JSON.parse(fs.readFileSync(path.join(root, "product.manifest.json"), "utf8"));
const sites = ["index.html", "en.html"].map((name) =>
  fs.readFileSync(path.join(root, "apps/site", name), "utf8"));

test("tag 发布明确选择平台未签名，手动发布默认保留 signed 路径", () => {
  assert.match(workflow, /platform_signing:[\s\S]*type: choice[\s\S]*signed[\s\S]*unsigned[\s\S]*default: signed/u);
  assert.match(workflow, /PLATFORM_SIGNING:.*workflow_dispatch.*inputs\.platform_signing.*unsigned/u);
  assert.match(workflow, /if \[ "\$PLATFORM_SIGNING" = "signed" \]; then/u);
});

test("平台未签名模式不削弱 Bundle Ed25519 信任链", () => {
  assert.match(workflow, /BUNDLE_SIGNING_PRIVATE_KEY/u);
  assert.match(workflow, /test -n "\$BUNDLE_SIGNING_PRIVATE_KEY"/u);
  assert.match(workflow, /pnpm bundle:release/u);
  assert.match(workflow, /build\/bundle-trust\.json/u);
  assert.match(builder, /from: build\/bundle-trust\.json[\s\S]*to: bundle-trust\.json/u);
});

test("signed 与 unsigned 平台校验边界清晰", () => {
  assert.match(workflow, /MAC_CSC_LINK/u);
  assert.match(workflow, /APPLE_APP_SPECIFIC_PASSWORD/u);
  assert.match(workflow, /WIN_CSC_LINK/u);
  assert.match(workflow, /codesign --verify --deep --strict/u);
  assert.match(workflow, /xcrun stapler validate/u);
  assert.match(workflow, /Get-AuthenticodeSignature/u);
  assert.match(workflow, /CSC_IDENTITY_AUTO_DISCOVERY=false/u);
  assert.match(workflow, /CSC_LINK= CSC_KEY_PASSWORD=/u);
  assert.match(workflow, /WIN_CSC_LINK= WIN_CSC_KEY_PASSWORD=/u);
  assert.match(workflow, /-c\.mac\.notarize=false/u);
});

test("Release 同时交付三个固定命名平台制品并披露安装风险", () => {
  assert.match(builder, /artifactName: "\$\{productName\}-\$\{os\}-\$\{arch\}\.\$\{ext\}"/u);
  assert.match(workflow, /--mac dmg --arm64/u);
  assert.match(workflow, /--mac dmg --x64/u);
  assert.match(workflow, /--win nsis --x64/u);
  assert.match(workflow, /未做 Apple\/Windows 平台代码签名/u);
  assert.match(workflow, /xattr -cr/u);
  assert.match(workflow, /SmartScreen/u);
  assert.match(workflow, /body_path: release-notes\.md/u);
  for (const site of sites) {
    assert.match(site, /workloom-hotel\/releases\/latest/u);
    assert.doesNotMatch(site, /releases\/latest\/download\/WorkLoom-macOS\.zip/u);
  }
});

test("桌面产品身份、端口和签名配置与产品清单一致", () => {
  assert.equal(product.release.artifactPrefix, product.displayName);
  assert.ok(builder.includes(`appId: ${product.release.appId}`));
  assert.ok(builder.includes(`productName: ${product.displayName}`));
  assert.ok(builder.includes(`workloomPortOffset: ${product.desktop.portOffset}`));
  for (const marker of [
    "hardenedRuntime: true",
    "notarize: true",
    "entitlements: build/entitlements.mac.plist",
  ]) {
    assert.ok(builder.includes(marker), `缺少 ${marker}`);
  }
});

test("Windows 实包冒烟与 runner 的 PostgreSQL 工具链隔离", () => {
  for (const [name, port] of [
    ["WORKLOOM_PG_PORT", "55432"],
    ["WORKLOOM_SERVER_PORT", "58787"],
    ["WORKLOOM_WEB_PORT", "55173"],
    ["WORKLOOM_NATS_PORT", "54222"],
  ]) {
    assert.ok(workflow.includes(`${name}: "${port}"`), `缺少 ${name} 隔离端口`);
  }
  for (const supportRoot of ["wl-smoke", "wl-app-smoke", "wl-render-default"]) {
    assert.ok(workflow.includes(`$RUNNER_TEMP/${supportRoot}`), `${supportRoot} 未统一使用 RUNNER_TEMP`);
    assert.ok(workflow.includes(`\${{ runner.temp }}/${supportRoot}/logs/`), `${supportRoot} 日志未进入失败诊断`);
    assert.ok(workflow.includes(`\${{ runner.temp }}/${supportRoot}/install-state.json`), `${supportRoot} 状态未进入失败诊断`);
  }
  assert.match(workflow, /actions\/upload-artifact@v4/u);
  assert.match(workflow, /锁定源安装 17\.11\.0/u);
  assert.doesNotMatch(workflow, /\$\{TEMP\}\/wl-/u);
  assert.doesNotMatch(workflow, /\$env:TEMP\\wl-/u);
});
