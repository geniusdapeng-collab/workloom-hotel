/**
 * 酒店考试题集校验脚本（审计/CI 复核用，非产品代码）
 *
 * 口径：走基座同一套装载器（`loadVerifiedBundleEvalQuestions`）——
 * 行业包清单 → 契约/兼容/摘要校验 → 题集路径白名单 → 题目 Schema 逐条校验。
 * 只有这道门通过，考试院才会用这套题开考（见 apps/server/src/service/eval.ts）。
 *
 * 用法：tsx scripts/verify-hotel-eval-questions.mts
 */
import { loadVerifiedBundleEvalQuestions } from "../packages/base/bundles/eval-questions.js";

const BUDGET = { minQuestions: 12, minRedLine: 5, requireStructures: ["single-single", "single-multi", "multi-single", "multi-multi", "adversarial"] };

const set = loadVerifiedBundleEvalQuestions("hotel");
const questions = set.questions;
const redLine = questions.filter((q) => q.redLine);
const structures = new Set(questions.map((q) => q.structure));
const subjects = new Map<string, number>();
for (const q of questions) subjects.set(q.subject, (subjects.get(q.subject) ?? 0) + 1);

console.log(`题集来自 bundle=${set.bundleId}@${set.bundleVersion} digest=${set.integrityDigest.slice(0, 12)}`);
console.log(`题目总数=${questions.length} 红线题=${redLine.length}`);
console.log(`结构分布=${[...structures].sort().join(",")}`);
console.log(`学科分布=${[...subjects.entries()].map(([k, v]) => `${k}:${v}`).join(" ")}`);

const problems: string[] = [];
if (questions.length < BUDGET.minQuestions) problems.push(`题目数 ${questions.length} < ${BUDGET.minQuestions}`);
if (redLine.length < BUDGET.minRedLine) problems.push(`红线题 ${redLine.length} < ${BUDGET.minRedLine}`);
for (const need of BUDGET.requireStructures) {
  if (!structures.has(need as never)) problems.push(`缺少结构 ${need}`);
}
for (const q of questions) {
  if (!q.scenario.turns.length) problems.push(`题「${q.tags.join("/")}」没有对话轮次`);
  if (!q.assertions.length) problems.push(`题「${q.tags.join("/")}」没有断言`);
  const hasLatency = q.assertions.some((a) => a.type === "latency_max_ms");
  if (!hasLatency) problems.push(`题「${q.tags.join("/")}」缺少时延断言`);
}
const duplicateTags = questions.map((q) => q.tags.join("|")).filter((v, i, arr) => arr.indexOf(v) !== i);
if (duplicateTags.length) problems.push(`题目标签重复：${duplicateTags.join("；")}`);

if (problems.length) {
  console.error(`\n❌ 题集校验失败（${problems.length} 项）`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}
console.log("\n✅ 酒店考试题集校验通过（题目数/红线题/结构覆盖/断言完备/标签唯一）");
