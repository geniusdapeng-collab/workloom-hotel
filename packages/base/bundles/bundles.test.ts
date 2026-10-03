/**
 * F11 行业装配测试（P7 舰船换装坞）：
 * 纯函数/文件：草稿骨架 scaffold（五要素 §2.3）/  slug 校验 / 草稿保护移除
 * PG 集成：hotel 声明槽位与真实页面全装配 + 六项校验通过（F2.10）/ 校验留痕（P7E3）/
 *          激活幂等（bundle.activate 事件）/ 草稿校验失败拒绝激活（不静默 L9.2）
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash, generateKeyPairSync, sign as signValue, type KeyObject } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  BundleError, loadPcPageRegistry, registeredBundlePcPages, computeAssembly, listProfileSlugs, scaffoldDraft, removeDraft,
  listSelfServiceBundles, loadBundleUiProjection, loadVerifiedBundleManifest,
  loadVerifiedBundleWorkforcePresets, verifyBundleManifestDocument,
} from "./assembly.js";
import { canonicalBundleArtifactPayload, parseBundleManifest, type BundleManifest } from "@workloom/industry-contract";

describe("草稿骨架与校验（P7E5/§2.3，文件级）", () => {
  it("五要素向导产出草稿骨架：五槽目录 + bundle.json status=draft（不进分发）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    scaffoldDraft({
      slug: "retail", displayName: "零售版", version: "0.1.0",
      changelog: "首版草稿", fenceRef: "hotel-baseline/v1", ownerMemberNo: "MEM-001",
    }, root);
    for (const sub of ["schemas", "presets", "fences", "skills", "ui"]) {
      expect(existsSync(join(root, "retail", sub))).toBe(true);
    }
    const bj = JSON.parse(readFileSync(join(root, "retail/bundle.json"), "utf-8"));
    expect(bj.workloom.status).toBe("draft");
    expect(bj.workloom.owner).toBe("MEM-001");
    // v3.0 第⑦槽：草稿自带 model-policy.yml 骨架（默认继承底座策略）
    expect(existsSync(join(root, "retail", "model-policy.yml"))).toBe(true);
    expect(listProfileSlugs(root)).toEqual(["retail"]);
    // 草稿可移除；移除后注册表为空
    removeDraft("retail", root);
    expect(listProfileSlugs(root)).toEqual([]);
  });

  it("slug 非法拒绝；重复 slug 拒绝（幂等键保护）", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    const bad = { slug: "Retail!!", displayName: "x", version: "0.1.0", changelog: "x", fenceRef: "f", ownerMemberNo: "MEM-001" };
    expect(() => scaffoldDraft(bad, root)).toThrowError(BundleError);
    const good = { ...bad, slug: "retail" };
    scaffoldDraft(good, root);
    expect(() => scaffoldDraft(good, root)).toThrowError(/已存在/);
  });

  it("已激活/已分发 profile 不可移除（§2.3 保护）", () => {
    // hotel 非草稿（真实仓库 bundles/hotel）
    expect(() => removeDraft("hotel")).toThrowError(/仅草稿态/);
  });

  it("页面登记来自真实 PC 入口，公共页面包含装配与合作方并拒绝未知编号", () => {
    const manifest = loadVerifiedBundleManifest("hotel");
    const pages = registeredBundlePcPages(loadPcPageRegistry(), manifest);
    expect(pages).toEqual(expect.arrayContaining(["p7", "p31", "/assembly", "/partners"]));
    expect(pages).not.toContain("p999");
  });

  it("候选行业包篡改后完整性校验失败关闭", () => {
    const source = new URL("../../../bundles/hotel/bundle.json", import.meta.url);
    const manifest = JSON.parse(readFileSync(source, "utf8"));
    expect(verifyBundleManifestDocument(manifest, "hotel").workloom.ui.serviceFront.enabled).toBe(true);
    manifest.workloom.displayName = "被篡改的名称";
    expect(() => verifyBundleManifestDocument(manifest, "hotel"))
      .toThrow(/完整性摘要不一致/);
  });

  it("候选行业包任一声明资产被篡改后运行时拒绝装载", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundle-asset-integrity-"));
    const source = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(source, join(root, "hotel"), { recursive: true });
    const asset = join(root, "hotel/presets/pricing-agent.yml");
    writeFileSync(asset, `${readFileSync(asset, "utf8")}\n# 未经封装的篡改\n`, "utf8");
    expect(() => loadVerifiedBundleManifest("hotel", root))
      .toThrow(/资产.*内容与摘要不一致/);
  });

  it("稳定包无条件使用独立 Ed25519 公钥环验签，并拒绝同目录换根、错钥与撤销密钥", () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundle-ed25519-"));
    const source = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(source, join(root, "hotel"), { recursive: true });
    const manifestPath = join(root, "hotel/bundle.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.workloom.status = "stable";
    const normalizedStable = parseBundleManifest(manifest);
    manifest.integrity.digest = createHash("sha256")
      .update(canonicalBundleArtifactPayload(normalizedStable, normalizedStable.integrity?.assets))
      .digest("hex");
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const publicPem = (key: typeof first.publicKey) => key.export({ type: "spki", format: "pem" }).toString();
    const ring = (revoked: string[] = []) => ({
      schemaVersion: "workloom.bundle.trust/v1",
      keys: {
        "release-v1": { algorithm: "ed25519", publicKey: publicPem(first.publicKey) },
        "release-v2": { algorithm: "ed25519", publicKey: publicPem(second.publicKey) },
      },
      revoked,
    });
    const signWith = (keyId: string, privateKey: typeof first.privateKey) => {
      manifest.integrity.signature = {
        algorithm: "ed25519",
        keyId,
        value: signValue(null, Buffer.from(manifest.integrity.digest, "hex"), privateKey).toString("base64"),
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };
    const previousNodeEnv = process.env.NODE_ENV;
    const previousVerificationKeys = process.env.BUNDLE_VERIFICATION_KEYS;
    const previousTrustPath = process.env.BUNDLE_TRUST_PATH;
    try {
      delete process.env.NODE_ENV;
      delete process.env.BUNDLE_TRUST_PATH;
      process.env.BUNDLE_VERIFICATION_KEYS = JSON.stringify(ring());
      signWith("release-v1", first.privateKey);
      expect(loadVerifiedBundleManifest("hotel", root).workloom.industry).toBe("hotel");

      // 攻击者即使替换 Bundle 目录中的伪公钥环并自签，运行时也不把它当成信任根。
      writeFileSync(join(root, ".verification-keys.json"), `${JSON.stringify({
        ...ring(),
        keys: { "release-v1": { algorithm: "ed25519", publicKey: publicPem(second.publicKey) } },
      }, null, 2)}\n`);
      signWith("release-v1", second.privateKey);
      expect(() => loadVerifiedBundleManifest("hotel", root)).toThrow(/无法验证/);

      signWith("release-v2", second.privateKey);
      expect(loadVerifiedBundleManifest("hotel", root).integrity?.signature?.keyId).toBe("release-v2");
      process.env.BUNDLE_VERIFICATION_KEYS = JSON.stringify(ring(["release-v2"]));
      expect(() => loadVerifiedBundleManifest("hotel", root)).toThrow(/已撤销/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousVerificationKeys === undefined) delete process.env.BUNDLE_VERIFICATION_KEYS;
      else process.env.BUNDLE_VERIFICATION_KEYS = previousVerificationKeys;
      if (previousTrustPath === undefined) delete process.env.BUNDLE_TRUST_PATH;
      else process.env.BUNDLE_TRUST_PATH = previousTrustPath;
    }
  });

  it("三端 UI 只读取通过完整性校验的当前行业投影", () => {
    const projection = loadBundleUiProjection("ai-pm");
    expect(projection.bundleId).toBe("ai-pm");
    expect(projection.ui.navigation.slots[0]?.title).toBe("开发场域");
    expect(projection.ui.home.widgets[0]?.component).toBe("QuickTaskList");
    expect(projection.ui.terminology["actor.requirement-analyst"]).toBe("需求分析官");
    expect(() => loadBundleUiProjection("missing-industry")).toThrow(/不存在或不可读取/);
  });

  it.each([
    {
      label: "缺少 coverage",
      mutate: (root: string) => {
        const path = join(root, "hotel/presets/pricing-agent.yml");
        const preset = YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        delete preset.coverage;
        writeFileSync(path, YAML.stringify(preset));
      },
      expected: /pricing-agent\.yml.*coverage/s,
    },
    {
      label: "缺少 night_shift",
      mutate: (root: string) => {
        const path = join(root, "hotel/presets/pricing-agent.yml");
        const preset = YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        delete preset.night_shift;
        writeFileSync(path, YAML.stringify(preset));
      },
      expected: /pricing-agent\.yml.*night_shift/s,
    },
    {
      label: "重复事件前缀",
      mutate: (root: string) => {
        const path = join(root, "hotel/presets/review-agent.yml");
        const preset = YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        preset.coverage = [{ eventPrefix: "price.", label: "重复覆盖" }];
        writeFileSync(path, YAML.stringify(preset));
      },
      expected: /事件前缀 price\. 已由岗位 pricing-agent 认领/,
    },
  ])("运行时装配在 $label 时失败关闭", ({ mutate, expected }) => {
    const root = mkdtempSync(join(tmpdir(), "wl-workforce-contract-"));
    const source = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(source, join(root, "hotel"), { recursive: true });
    const manifestPath = join(root, "hotel/bundle.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.workloom.status = "draft";
    delete manifest.integrity;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    mutate(root);

    expect(() => loadVerifiedBundleWorkforcePresets("hotel", root)).toThrow(expected);
  });

  it("酒店行业仓的非示例候选包在开发与生产均不开放自助开通", () => {
    // 本仓的真实酒店包是经营实例，区别于基座内置的 example=true 酒店示例。
    expect(loadVerifiedBundleManifest("hotel").workloom).toMatchObject({
      status: "candidate",
      example: false,
    });
    const previousNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      const registry = listSelfServiceBundles();
      expect(registry.version).toMatch(/^[a-f0-9]{16}$/);
      expect(registry.entries.map((entry) => entry.slug)).toEqual(["ai-pm"]);
      expect(registry.entries.every((entry) => entry.provisioningMode === "guided-assembly")).toBe(true);
      expect(registry.rejected).toContainEqual({ slug: "hotel", reason: "未开放自助开通" });

      process.env.NODE_ENV = "production";
      const productionRegistry = listSelfServiceBundles();
      expect(productionRegistry.entries).toEqual([]);
      expect(productionRegistry.rejected).toContainEqual({
        slug: "hotel",
        reason: "尚未进入稳定发布状态",
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });
});

describe("自助开通可见性契约（隔离合成包）", () => {
  const keyId = "visibility-test-v1";
  interface FixtureOptions {
    status: BundleManifest["workloom"]["status"];
    example?: boolean;
    signing?: { keyId: string; privateKey: KeyObject };
  }

  function withFixtureRoot(check: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "wl-自助可见性-"));
    const keys = ["NODE_ENV", "BUNDLE_VERIFICATION_KEYS", "BUNDLE_TRUST_PATH"] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      delete process.env.BUNDLE_VERIFICATION_KEYS;
      delete process.env.BUNDLE_TRUST_PATH;
      check(root);
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }

  function trustKey(publicKey: KeyObject, revoked: string[] = []): void {
    process.env.BUNDLE_VERIFICATION_KEYS = JSON.stringify({
      schemaVersion: "workloom.bundle.trust/v1",
      keys: { [keyId]: { algorithm: "ed25519", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString() } },
      revoked,
    });
  }

  function writeFixture(root: string, slug: string, options: FixtureOptions): void {
    const directory = join(root, slug);
    mkdirSync(directory);
    const asset = '{"fixture":"合成测试资产"}\n';
    writeFileSync(join(directory, "fixture.json"), asset);
    const integrity: NonNullable<BundleManifest["integrity"]> = {
      algorithm: "sha256",
      digest: "0".repeat(64),
      assets: { "fixture.json": createHash("sha256").update(asset).digest("hex") },
    };
    const document = {
      schemaVersion: "workloom.bundle/v1",
      name: `@workloom/${slug}`,
      version: "1.0.0",
      workloom: {
        industry: slug,
        displayName: "自助开通测试包",
        description: "合成夹具，仅用于验证行业包可见性契约。",
        status: options.status,
        owner: "自助开通测试",
        ...(options.example === undefined ? {} : { example: options.example }),
        compatibility: { base: ">=0.1.0 <1.0.0", ui: ">=0.1.0 <1.0.0", contract: "2.0.0" },
        provides: { library: ["fixture.json"] },
        ui: {
          schemaVersion: "workloom.bundle.ui/v1",
          navigation: { slots: [] },
          home: { widgets: [] },
          serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
          theme: { brand: {} },
        },
      },
      integrity,
    };
    // 缺省字段参与规范形摘要；省略 example 的文档仍交给真实运行时解析。
    integrity.digest = createHash("sha256")
      .update(canonicalBundleArtifactPayload(parseBundleManifest(document)))
      .digest("hex");
    if (options.signing) {
      integrity.signature = {
        algorithm: "ed25519",
        keyId: options.signing.keyId,
        value: signValue(null, Buffer.from(integrity.digest, "hex"), options.signing.privateKey).toString("base64"),
      };
    }
    writeFileSync(join(directory, "bundle.json"), `${JSON.stringify(document, null, 2)}\n`);
  }

  const channelCases: Array<{
    label: string;
    status: FixtureOptions["status"];
    example?: boolean;
    development: string | null;
    production: string | null;
  }> = [
    { label: "候选示例", status: "candidate", example: true, development: null, production: "尚未进入稳定发布状态" },
    { label: "候选非示例", status: "candidate", example: false, development: "未开放自助开通", production: "尚未进入稳定发布状态" },
    { label: "候选省略示例标志", status: "candidate", development: "未开放自助开通", production: "尚未进入稳定发布状态" },
    { label: "稳定示例", status: "stable", example: true, development: null, production: null },
    { label: "稳定非示例", status: "stable", example: false, development: "未开放自助开通", production: "未开放自助开通" },
    { label: "稳定省略示例标志", status: "stable", development: "未开放自助开通", production: "未开放自助开通" },
    { label: "草稿示例", status: "draft", example: true, development: "尚未进入稳定发布状态", production: "尚未进入稳定发布状态" },
    { label: "退役示例", status: "retired", example: true, development: "尚未进入稳定发布状态", production: "尚未进入稳定发布状态" },
  ];

  it.each(channelCases)("$label 按正式发布通道与开放声明决定可见性", (testCase) => {
    withFixtureRoot((root) => {
      const key = generateKeyPairSync("ed25519");
      trustKey(key.publicKey);
      writeFixture(root, "fixture", {
        status: testCase.status,
        example: testCase.example,
        ...(testCase.status === "stable" ? { signing: { keyId, privateKey: key.privateKey } } : {}),
      });
      for (const channel of ["development", "production"] as const) {
        process.env.NODE_ENV = channel;
        const registry = listSelfServiceBundles(root);
        expect(registry.version).toMatch(/^[a-f0-9]{16}$/);
        const reason = testCase[channel];
        if (reason === null) {
          expect(registry.entries).toEqual([{
            slug: "fixture",
            displayName: "自助开通测试包",
            description: "合成夹具，仅用于验证行业包可见性契约。",
            version: "1.0.0",
            serviceFrontEnabled: false,
            provisioningMode: "guided-assembly",
          }]);
          expect(registry.rejected).toEqual([]);
        } else {
          expect(registry.entries).toEqual([]);
          expect(registry.rejected).toEqual([{ slug: "fixture", reason }]);
        }
      }
    });
  });

  it.each([
    { label: "未签名", mode: "unsigned", expected: /未签名的稳定行业包/ },
    { label: "错误签名", mode: "wrong-key", expected: /无法验证/ },
    { label: "未受信密钥", mode: "unknown-key", expected: /不在可信公钥环/ },
    { label: "撤销密钥", mode: "revoked", expected: /已撤销/ },
  ])("稳定示例包在 $label 时两通道均拒绝，并保留同目录的合格包", ({ mode, expected }) => {
    withFixtureRoot((root) => {
      const trusted = generateKeyPairSync("ed25519");
      const wrong = generateKeyPairSync("ed25519");
      trustKey(trusted.publicKey, mode === "revoked" ? [keyId] : []);
      writeFixture(root, "untrusted", {
        status: "stable",
        example: true,
        ...(mode === "unsigned" ? {} : {
          signing: { keyId: mode === "unknown-key" ? "unknown-release" : keyId, privateKey: mode === "wrong-key" ? wrong.privateKey : trusted.privateKey },
        }),
      });
      // 正例用独立可信密钥，撤销坏包密钥也不得压掉其他可选包。
      const allowed = generateKeyPairSync("ed25519");
      const ring = JSON.parse(process.env.BUNDLE_VERIFICATION_KEYS!);
      ring.keys["allowed-release"] = { algorithm: "ed25519", publicKey: allowed.publicKey.export({ type: "spki", format: "pem" }).toString() };
      process.env.BUNDLE_VERIFICATION_KEYS = JSON.stringify(ring);
      writeFixture(root, "allowed", { status: "stable", example: true, signing: { keyId: "allowed-release", privateKey: allowed.privateKey } });
      for (const channel of ["development", "production"]) {
        process.env.NODE_ENV = channel;
        expect(() => loadVerifiedBundleManifest("untrusted", root)).toThrow(expected);
        const registry = listSelfServiceBundles(root);
        expect(registry.entries.map((entry) => entry.slug)).toEqual(["allowed"]);
        expect(registry.rejected).toEqual([{ slug: "untrusted", reason: expect.stringMatching(expected) }]);
      }
    });
  });

  it.each([
    { label: "清单", expected: /行业包内容与完整性摘要不一致/ },
    { label: "声明资产", expected: /资产.*内容与摘要不一致/ },
  ])("明确开放的候选包在 $label 篡改后两通道均拒绝", ({ label, expected }) => {
    withFixtureRoot((root) => {
      writeFixture(root, "fixture", { status: "candidate", example: true });
      const path = join(root, "fixture/bundle.json");
      if (label === "清单") {
        const manifest: BundleManifest = JSON.parse(readFileSync(path, "utf8"));
        manifest.workloom.description = "未经封装的清单变更";
        writeFileSync(path, JSON.stringify(manifest));
      } else {
        writeFileSync(join(root, "fixture/fixture.json"), '{"fixture":"未经封装的资产变更"}\n');
      }
      for (const channel of ["development", "production"]) {
        process.env.NODE_ENV = channel;
        const registry = listSelfServiceBundles(root);
        expect(registry.entries).toEqual([]);
        expect(registry.rejected).toEqual([{ slug: "fixture", reason: expect.stringMatching(expected) }]);
      }
    });
  });

  it("空目录在两通道均返回空注册表，不产生自助开通选项", () => {
    withFixtureRoot((root) => {
      for (const channel of ["development", "production"]) {
        process.env.NODE_ENV = channel;
        const registry = listSelfServiceBundles(root);
        expect(registry.version).toMatch(/^[a-f0-9]{16}$/);
        expect(registry.entries).toEqual([]);
        expect(registry.rejected).toEqual([]);
      }
    });
  });
});

/* ---------------- PG 集成（同一数据库可重跑） ---------------- */

const RUN_DB = process.env.RUN_DB_TESTS === "1" && !!process.env.DATABASE_APP_URL;
describe.runIf(RUN_DB)("行业装配 PG 集成（F2.10 铁律）", async () => {
  const pg = await import("pg");
  const {
    activateBundle, recheckBundle, createBundleDraft,
  } = await import("./assembly.js");
  const app = new pg.default.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gw = new pg.default.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const owner = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
  const fixtureSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const scope = { tenantId: "tenant-demo", workspaceId: `ws-bundle-${fixtureSuffix}` };

  beforeAll(async () => {
    // 每个测试进程复制一份最小 hotel 装配实物，避免并行的 onboarding/Bundle 用例
    // 共同翻转 ws-yunqi.industry，造成状态断言与草稿激活互相污染。
    const workspace = await owner.query(
      `INSERT INTO workspaces (id, tenant_id, name, slug, industry, stage, night_config)
       SELECT $1, tenant_id, '行业装配隔离夹具', $2, industry, stage, night_config
       FROM workspaces WHERE id='ws-yunqi' RETURNING id`,
      [scope.workspaceId, `bundle-${fixtureSuffix}`],
    );
    if (!workspace.rows[0]) throw new Error("行业装配测试缺少显式 hotel 种子工作区 ws-yunqi");
    await owner.query(
      `INSERT INTO profiles (workspace_id, tenant_id, industry, archive, forbidden, pii_vault)
       SELECT $1, tenant_id, industry, archive, forbidden, pii_vault
       FROM profiles WHERE workspace_id='ws-yunqi'`,
      [scope.workspaceId],
    );
    await owner.query(
      `INSERT INTO agents
         (id, workspace_id, preset_key, name, version, kind, readonly, fence_bindings, skills, status, invalid_reason, meta)
       SELECT id || '-' || $2, $1, preset_key, name, version, kind, readonly,
              fence_bindings, skills, status, invalid_reason, meta
       FROM agents WHERE workspace_id='ws-yunqi'`,
      [scope.workspaceId, fixtureSuffix],
    );
    await owner.query(
      `INSERT INTO fence_rules
         (id, rule_id, version, workspace_id, name, level, match_spec, action,
          is_baseline, status, created_by, approved_event_id)
       SELECT id || '-' || $2, rule_id, version, $1, name, level, match_spec, action,
              is_baseline, status, created_by, approved_event_id
       FROM fence_rules WHERE workspace_id='ws-yunqi'`,
      [scope.workspaceId, fixtureSuffix],
    );
  });

  afterAll(async () => {
    await owner.query(`DELETE FROM fence_rules WHERE workspace_id=$1`, [scope.workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM agents WHERE workspace_id=$1`, [scope.workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM profiles WHERE workspace_id=$1`, [scope.workspaceId]).catch(() => undefined);
    await owner.query(`DELETE FROM workspaces WHERE id=$1`, [scope.workspaceId]).catch(() => undefined);
    await Promise.all([app.end(), gw.end(), owner.end()]);
  });
  /** app 池断言查询辅助：事务内设 RLS 上下文（与生产口径一致；池直查在 RLS 下恒 0 行） */
  const qApp = async <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) => {
    const c = await app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
      const r = await c.query<T>(sql, params);
      await c.query("COMMIT");
      return r;
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };


  it("hotel profile：声明资产与实例完整装配，真实公共和行业页面校验通过", async () => {
    const manifest = loadVerifiedBundleManifest("hotel");
    const presets = loadVerifiedBundleWorkforcePresets("hotel");
    const uiPath = manifest.workloom.provides.ui.find((path) => path.endsWith("/cases.json"));
    if (!uiPath) throw new Error("隔离 hotel 夹具缺少明确声明的界面用例");
    const uiCases = JSON.parse(readFileSync(new URL(`../../../bundles/hotel/${uiPath}`, import.meta.url), "utf8")) as { cases: Array<{ page: string }> };
    const pageCount = new Set(uiCases.cases.map((item) => item.page)).size;
    const p = await computeAssembly(app, scope, "hotel");
    expect(p.status).toBe("active");
    expect(p.filledCount).toBe(6 + (manifest.workloom.provides.modelPolicy ? 1 : 0));
    expect(p.checks.map((c) => c.ok)).toEqual([true, true, true, true, true, true]);
    expect(p.canActivate).toBe(true);
    expect(p.agents.map((agent) => agent.presetKey).sort())
      .toEqual(presets.map((preset) => preset.preset_key).sort());
    expect(p.agents.every((agent) => agent.fenceOk)).toBe(true);
    expect(p.slots[0]!.summary).toContain("字段");
    expect(p.slots[5]!.summary).toBe(`${pageCount} 个页面 · ${uiCases.cases.length} 条界面状态用例`);
    expect(p.slots[6]!.id).toBe("model-policy");
    expect(p.slots[6]!.filled).toBe(Boolean(manifest.workloom.provides.modelPolicy));
    expect(p.slots[6]!.summary).toContain(manifest.workloom.provides.modelPolicy ? "已配置" : "平台默认");
  });

  it("校验留痕：recheck 写 bundle.check_run 事件（P7E3 留痕可查）", async () => {
    const r = await recheckBundle(app, gw, scope, "hotel", "MEM-001");
    expect(r.eventId).toMatch(/^E-\d+$/);
    const ev = await qApp(
      `SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE event_id=$1`, [r.eventId]);
    expect(ev.rows[0]!.action).toBe("bundle.check_run");
  });

  it("激活幂等：hotel 已激活仍可重激活并留痕 bundle.activate", async () => {
    const r = await activateBundle(app, gw, scope, "hotel", "MEM-001");
    expect(r.eventId).toMatch(/^E-\d+$/);
    const ind = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    expect(ind.rows[0]!.industry).toBe("hotel");
  });

  /** 第三行业夹具只复用公共装配资产，不借用 hotel 路由、适配器或权限。 */
  function publicDraftFixture(root: string, slug: string): { expectedFilled: number } {
    const source = new URL("../../../bundles/hotel", import.meta.url).pathname;
    cpSync(source, join(root, slug), { recursive: true });
    const path = join(root, slug, "bundle.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as BundleManifest;
    manifest.name = `@workloom/${slug}`;
    manifest.workloom.industry = slug;
    manifest.workloom.status = "draft";
    manifest.workloom.ui.navigation.slots = [];
    manifest.workloom.ui.permissions = [];
    manifest.workloom.ui.serviceFront = { enabled: false, identityPolicy: "disabled", tabs: [], services: [] };
    manifest.workloom.ui.inspection = { enabled: false };
    delete manifest.integrity;
    const allowed = new Set(registeredBundlePcPages(loadPcPageRegistry(), parseBundleManifest(manifest)));
    const uiPath = manifest.workloom.provides.ui.find((asset) => asset.endsWith("/cases.json"));
    if (!uiPath) throw new Error("第三行业夹具缺少界面用例声明");
    const document = JSON.parse(readFileSync(join(root, slug, uiPath), "utf8")) as { pages: string[]; cases: Array<{ page: string }> };
    document.cases = document.cases.filter((item) => allowed.has(item.page));
    document.pages = [...new Set(document.cases.map((item) => item.page))];
    writeFileSync(join(root, slug, uiPath), `${JSON.stringify(document, null, 2)}\n`);
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return { expectedFilled: 6 + (manifest.workloom.provides.modelPolicy ? 1 : 0) };
  }

  it("H-15 第三行业公共装配：填充资产、公共页面和自有声明即可激活，无底座改动", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-h15-"));
    try {
      const fixture = publicDraftFixture(root, "copycat");
      const p0 = await computeAssembly(app, scope, "copycat", root);
      expect(p0.status).toBe("draft");
      expect(p0.filledCount).toBe(fixture.expectedFilled);
      expect(p0.checks.every((check) => check.ok)).toBe(true);
      expect(p0.canActivate).toBe(true);
      const act = await activateBundle(app, gw, scope, "copycat", "MEM-001", root);
      expect(act.eventId).toMatch(/^E-\d+$/);
      const ind = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
      expect(ind.rows[0]!.industry).toBe("copycat");
      const p1 = await computeAssembly(app, scope, "copycat", root);
      expect(p1.status).toBe("active");
      expect(p1.checks.every((check) => check.ok)).toBe(true);
    } finally {
      try { await activateBundle(app, gw, scope, "hotel", "MEM-001"); }
      finally { rmSync(root, { recursive: true, force: true }); }
    }
    const back = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
    expect(back.rows[0]!.industry).toBe("hotel");
  }, 20000);

  it("未知页面即使列入 cases.pages 仍拒绝激活，工作区、profile 和事件均不发生激活变更", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-unknown-page-"));
    try {
      publicDraftFixture(root, "copycat");
      const manifest = JSON.parse(readFileSync(join(root, "copycat/bundle.json"), "utf8")) as BundleManifest;
      const uiPath = manifest.workloom.provides.ui.find((asset) => asset.endsWith("/cases.json"))!;
      writeFileSync(join(root, "copycat", uiPath), JSON.stringify({ pages: ["p999"], cases: [{ page: "p999", name: "伪造登记" }] }));
      const before = await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId]);
      const beforeProfile = await qApp(`SELECT industry FROM profiles WHERE workspace_id=$1`, [scope.workspaceId]);
      const beforeEvents = await qApp(`SELECT count(*)::int AS count FROM biz_events WHERE workspace_id=$1`, [scope.workspaceId]);
      const profile = await computeAssembly(app, scope, "copycat", root);
      expect(profile.checks.find((check) => check.key === "ui")).toMatchObject({ ok: false, detail: expect.stringContaining("p999") });
      expect(profile.canActivate).toBe(false);
      await expect(activateBundle(app, gw, scope, "copycat", "MEM-001", root))
        .rejects.toMatchObject({ code: "ASSEMBLY_CHECK_FAILED" });
      expect((await qApp(`SELECT industry FROM workspaces WHERE id=$1`, [scope.workspaceId])).rows).toEqual(before.rows);
      expect((await qApp(`SELECT industry FROM profiles WHERE workspace_id=$1`, [scope.workspaceId])).rows).toEqual(beforeProfile.rows);
      expect((await qApp(`SELECT count(*)::int AS count FROM biz_events WHERE workspace_id=$1`, [scope.workspaceId])).rows).toEqual(beforeEvents.rows);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it("草稿 Bundle：六槽待填充 + 校验五项全红（第⑦槽骨架自带不阻断）+ 拒绝激活（F2.10 不静默 L9.2）", async () => {
    const root = mkdtempSync(join(tmpdir(), "wl-bundles-"));
    const slug = `draft-${Date.now().toString(36)}`;
    const created = await createBundleDraft(gw, scope, {
      slug, displayName: "草稿行业", version: "0.1.0",
      changelog: "测试草稿", fenceRef: "hotel-baseline/v1", ownerMemberNo: "MEM-002",
    }, "MEM-002", root);
    expect(created.eventId).toMatch(/^E-\d+$/);

    const p = await computeAssembly(app, scope, slug, root);
    expect(p.status).toBe("draft");
    // v3.0：草稿自带第⑦槽 model-policy.yml 骨架（filled=1）；其余六槽待填充
    expect(p.filledCount).toBe(1);
    expect(p.canActivate).toBe(false);
    const failed = p.checks.filter((c) => !c.ok);
    expect(failed.length).toBe(5); // 五项铁律校验全红
    expect(failed.every((c) => c.fix)).toBe(true); // 每项失败都带修复指引（FixList）
    expect(p.checks.find((c) => c.key === "model_policy")?.ok).toBe(true); // 第⑦槽骨架即合法（非阻断）

    await expect(activateBundle(app, gw, scope, slug, "MEM-002", root))
      .rejects.toMatchObject({ code: "ASSEMBLY_CHECK_FAILED" });
  }, 20000);
});
