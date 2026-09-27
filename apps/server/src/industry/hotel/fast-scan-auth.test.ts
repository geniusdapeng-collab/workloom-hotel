import { beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => ({ navigationPermissions: [] as string[], actionPermissions: [] as string[], canWrite: false }));
vi.mock("../../service/access-authority.js", () => ({
  AccessAuthorityError: class AccessAuthorityError extends Error {},
  currentMemberAuthority: async (identity: unknown) => ({ identity, permissions: {} }),
  memberAccessGrants: () => ({ navigationPermissions: [], actionPermissions: authority.canWrite ? ["workspace.write"] : [] }),
  resolveAuthoritativeClientAccess: async () => ({ navigationPermissions: authority.navigationPermissions, actionPermissions: authority.actionPermissions }),
}));

import { hotelTwinRouter } from "./twin-router.js";
import type { TrpcContext } from "../../trpc/context.js";

const identity: NonNullable<TrpcContext["identity"]> = {
  kind: "member", tenantId: "tenant-a", workspaceId: "workspace-a",
  memberId: "member-a", memberNo: "MEM-001", name: "测试店长", role: "owner", plan: "pro",
};
const context = (signedIn: boolean): TrpcContext => ({
  session: signedIn ? identity : null,
  identity: signedIn ? identity : null,
  partnerIdentity: null,
  headers: new Headers(),
});

beforeEach(() => { authority.navigationPermissions = []; authority.actionPermissions = []; authority.canWrite = false; });

describe("酒店体检入口的服务端授权", () => {
  it("无 JWT 直接调用预览与回执均拒绝", async () => {
    const caller = hotelTwinRouter.createCaller(context(false));
    await expect(caller.fastScanPreview({} as never)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.fastScanReceipt({ idempotencyKey: "request-001" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("有 JWT 但活动行业包未授权时拒绝", async () => {
    const caller = hotelTwinRouter.createCaller(context(true));
    await expect(caller.fastScanPreview({} as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.fastScanReceipt({ idempotencyKey: "request-001" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("执行要求基础写权限及独立的行业执行权限", async () => {
    const caller = hotelTwinRouter.createCaller(context(true));
    authority.navigationPermissions = ["hotel.fast-scan.read"];
    authority.actionPermissions = ["hotel.fast-scan.execute"];
    await expect(caller.fastScanExecute({} as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    authority.canWrite = true;
    authority.actionPermissions = [];
    await expect(caller.fastScanExecute({} as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    authority.actionPermissions = ["hotel.fast-scan.execute"];
    await expect(caller.fastScanExecute({} as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
