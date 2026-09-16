const FIELD_LABELS: Record<string, string> = {
  property: "门店基础信息",
  brand_guideline: "品牌规范",
  business: "经营信息",
  competitors: "竞品信息",
  channels: "渠道信息",
  price_calendar: "价格日历",
  goals: "经营目标",
  audience: "客群画像",
  history_curve: "历史趋势",
  operations: "运营信息",
  staffing: "人员配置",
  suppliers: "供应商信息",
  linen: "布草管理",
  incident_profile: "异常画像",
  faq_kb: "常见问题知识库",
  inspection: "巡检配置",
  sop: "标准作业流程",
  forbidden: "禁止事项",
  approval_matrix: "审批矩阵",
  compensation_policy: "补偿政策",
  memory: "组织记忆",
  channel_new: "是否为新渠道",
  city: "所在城市",
  commission_rules: "佣金规则",
  floor_price: "保底价",
  kind: "类型",
  name: "名称",
  pms_vendor: "客房系统服务商",
  price_bands: "价格区间",
  refund_policy: "退款政策",
  rooms: "客房数",
  rule: "规则",
  scope: "适用范围",
  segment: "客群",
  star: "星级",
  initial_sets: "初始库存",
  laundry_vendor: "洗涤供应商",
  baseline_loss_rate: "基准损耗率",
  delivery_tolerance: "交付容差",
  top_questions: "高频问题",
  pending_candidates: "待确认问题",
  last_mined_at: "最近整理时间",
  root_cause: "根因",
  fallback_level: "兜底等级",
  breakpoint: "异常断点",
  channel_price: "渠道价格",
  other_channel_min: "其他渠道最低价",
  sync_failed: "同步是否失败",
  fence_snapshot: "围栏快照",
};

const VALUE_LABELS: Record<string, string> = {
  online: "在线",
  offline: "离线",
  on_track: "进度正常",
  behind: "进度落后",
  low_star: "低星单体酒店",
  homestay: "民宿",
  unmanned: "无人酒店",
  true: "是",
  false: "否",
  R1: "白班调价围栏",
  R2: "价格底线围栏",
  R3: "新渠道首发审批",
  R4: "大额退款审批",
  R6: "差评回复审批",
  R7: "夜班调价围栏",
  R11: "补偿审批",
  R15: "直播首发审批",
  R17: "渠道价差保护",
  R18: "超售保护",
  R19: "差评响应时限",
  R20: "布草损耗审批",
  pass: "通过",
  blocked: "已拦截",
  agent: "数字员工",
};

const RAW_FIELD = /\b[a-z][a-z0-9]*(?:_[a-z0-9_]+|[A-Z][A-Za-z0-9]*)\b/g;

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? "其他经营信息";
}

/** 客户端只呈现中文业务语义；未知底层字段不会原样透出。 */
export function clientValueText(value: unknown, fallback = "已记录"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const source = String(value);
  const direct = FIELD_LABELS[source] ?? VALUE_LABELS[source];
  if (direct) return direct;
  return source.replace(RAW_FIELD, (token) => FIELD_LABELS[token] ?? VALUE_LABELS[token] ?? "内部字段");
}

/** 客户端编号只用于帮助用户定位，不暴露完整底层标识。 */
export function clientIdentifierText(value: unknown, fallback = "业务编号未记录"): string {
  if (value === null || value === undefined || value === "") return fallback;
  const source = String(value).trim();
  if (!source) return fallback;
  if (/^[\u3400-\u9fff][\u3400-\u9fff\d·（）()\-—\s]{1,30}$/u.test(source)) return source;
  const suffix = source.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase();
  return suffix ? `业务编号末六位 ${suffix}` : fallback;
}

/** 执行者展示只使用人类可读角色，底层身份编号保持脱敏。 */
export function actorText(who: { type?: string; id?: string } | undefined): string {
  if (!who) return "执行者未记录";
  const role = who.type === "agent" ? "数字员工" : "协作成员";
  return `${role} · ${clientIdentifierText(who.id)}`;
}
