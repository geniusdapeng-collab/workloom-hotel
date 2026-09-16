import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./twin-router.ts", import.meta.url), "utf8");

describe("酒店经营投影路由权限边界", () => {
  it("每个酒店页面只读取自己的导航能力，不提供通用事件查询", () => {
    const permissions = [
      "hotel.incidents.read",
      "hotel.price-health.read",
      "hotel.goals.read",
      "hotel.orders.read",
      "hotel.channels.read",
      "hotel.reputation.read",
      "hotel.voice-front.read",
      "hotel.frontdesk-housekeeping.read",
      "hotel.archive.read",
      "hotel.stores.read",
      "hotel.revenue.read",
    ];
    for (const permission of permissions) {
      expect(source).toContain(`navigationPermissionProcedure("${permission}")`);
    }
    expect(source).not.toMatch(/\bevents:\s*(?:protectedProcedure|navigationPermissionProcedure)/);
    expect(source).not.toContain("protectedProcedure");
  });

  it("订单穿透只能读取当前租户与工作区，档案读取也受工作区隔离", () => {
    expect(source).toContain("set_config('app.tenant_id', $1, true)");
    expect(source).toContain("set_config('app.workspace_id', $1, true)");
    expect(source).toContain("async function readArchive");
    expect(source).toContain("payload->'object'->>'id' = $2");
  });
});
