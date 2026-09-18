// lib/concerns.js — pure helpers for concerns.json handling, shared by
// read-shared-state and resolve-concern. Tolerates every schema the framework
// has produced so far:
//   wrapped  { concerns: [...] }
//   flat     [ ... ]                       (reviewer.md 契约让 Reviewer 写裸数组)
//   grouped  { p0: [...], p1: [...] }
//
// advance.js's countOpenP0FromConcerns already reads all three; these helpers
// bring write-path consumers (status filter + resolve) in line with it.

/** Collect the concern arrays present in a parsed concerns.json (any schema). */
export function collectConcernLists(content) {
  const lists = [];
  if (Array.isArray(content)) {
    lists.push(content);
  } else if (content && typeof content === "object") {
    if (Array.isArray(content.concerns)) lists.push(content.concerns);
    if (Array.isArray(content.p0)) lists.push(content.p0);
    if (Array.isArray(content.p1)) lists.push(content.p1);
    if (Array.isArray(content.p2)) lists.push(content.p2);
  }
  return lists;
}

/**
 * Keep only items with the given status, in place, so the original top-level
 * shape (array vs {concerns}|{p0,p1}) is preserved on write-back. Returns the
 * same object/array; returns it unchanged when no concern list is present.
 */
export function filterConcernsByStatus(content, status) {
  const lists = collectConcernLists(content);
  for (const list of lists) {
    const kept = list.filter((c) => c && c.status === status);
    list.length = 0;
    list.push(...kept);
  }
  return content;
}

/**
 * Mark a concern (by id) as resolved, in place, across all schemas. Returns
 * true when the id was found and updated, false otherwise.
 */
export function resolveConcernById(content, concernId, resolvedBy, resolvedAt) {
  const lists = collectConcernLists(content);
  for (const list of lists) {
    const concern = list.find((c) => c && c.id === concernId);
    if (concern) {
      concern.status = "resolved";
      concern.resolved_by = resolvedBy;
      concern.resolved_at = resolvedAt;
      return true;
    }
  }
  return false;
}

// Exported for the schema sync-check test (tests/concerns.test.mjs D7): the
// canonical word list single-sources both the write gate and the JSON schema.
export const STATUS_VALUES = ["open", "resolved", "deferred", "dismissed"];

// ── 读侧容错（issue !259）──
// status 词表只在写入路径强制（normalizeConcerns 上方 STATUS_VALUES 严格校验）；
// AI 用 Write/Edit 直改 concerns.json 可绕过门禁，产出 "fixed" 等非规范词。读取路径
// （advance.countOpenP0FromConcerns、daily-report collect-ai.js）用下面的同义词集
// 容错计为已关闭，避免日报 concern_stats 假阴性 + advance P0 误否决。
// 方向不能反：读侧容错 ≠ 写侧放宽（normalizeConcerns 词表一行不改）。
// 同义词集不含 wontfix（语义近 dismissed，不并入 resolved）；deferred/dismissed
// 维持不计 closed（推迟 ≠ 解决）。
// 注意：collect-ai.js 是 CJS、本文件是 ESM，无法共享 import——collect-ai 内联了
// 一份同集（其文件内有 keep-in-sync 注释），tests/collect-ai-status.test.mjs
// 做漂移对账。
export const RESOLVED_SYNONYMS = ["resolved", "fixed", "closed", "done", "已修复", "已解决", "已关闭"];

/** Read-side tolerant check: true when status is `resolved` or a close synonym of it. */
export function isResolvedStatus(status) {
  return RESOLVED_SYNONYMS.includes(String(status).trim().toLowerCase());
}

/**
 * Mark every open P1 concern as deferred, in place, across all schemas.
 * (change concerns-commit-gate D6: advance()'s tolerance paths — auto-promote
 * and P1<=2 conditional pass — write their decision back so pipeline-blessed
 * P1s stop showing as open in the commit gate and daily-report stats.)
 * P0s and non-open P1s are left untouched. Returns the deferred count.
 */
export function deferOpenP1s(content, reason, deferredBy, deferredAt) {
  const lists = [];
  if (Array.isArray(content)) {
    lists.push({ list: content, key: null });
  } else if (content && typeof content === "object") {
    if (Array.isArray(content.concerns)) lists.push({ list: content.concerns, key: null });
    // Grouped schema carries severity on the list key — inject it per item.
    if (Array.isArray(content.p0)) lists.push({ list: content.p0, key: "P0" });
    if (Array.isArray(content.p1)) lists.push({ list: content.p1, key: "P1" });
    if (Array.isArray(content.p2)) lists.push({ list: content.p2, key: "P2" });
  }
  let count = 0;
  for (const { list, key } of lists) {
    for (const c of list) {
      if (!c) continue;
      const sev = String(c.severity ?? key ?? "").toUpperCase();
      const isOpen = String(c.status ?? "open").trim().toLowerCase() === "open";
      if (sev === "P1" && isOpen) {
        c.status = "deferred";
        c.deferred_reason = reason;
        c.deferred_by = deferredBy;
        c.deferred_at = deferredAt;
        count++;
      }
    }
  }
  return count;
}

/**
 * Validate + normalize a concerns payload into the canonical grouped shape
 * `{ p0: [...], p1: [...] }` (the format shared-state.md declares canonical and
 * every consumer — advance, collect-ai, resolve-concern — reads). Accepts any
 * of the three shapes AI agents have produced (bare array, wrapped
 * `{concerns}`, grouped `{p0}/{p1}`), validates each item, and rejects
 * unusable input with an actionable message. This is the write-time gate so AI
 * output can no longer drift into ad-hoc formats.
 */
export function normalizeConcerns(content) {
  const items = [];
  if (Array.isArray(content)) {
    items.push(...content);
  } else if (content && typeof content === "object") {
    if (Array.isArray(content.concerns)) items.push(...content.concerns);
    // Grouped format carries severity on the list key; inject it per item so
    // downstream validation sees a uniform shape.
    if (Array.isArray(content.p0)) items.push(...content.p0.map((c) => ({ ...c, severity: c.severity || "P0" })));
    if (Array.isArray(content.p1)) items.push(...content.p1.map((c) => ({ ...c, severity: c.severity || "P1" })));
    if (Array.isArray(content.p2)) items.push(...content.p2.map((c) => ({ ...c, severity: c.severity || "P2" })));
  }
  if (items.length === 0 && !Array.isArray(content)) {
    throw new Error("concerns 必须是数组或包含 concerns/p0/p1/p2 数组的对象");
  }

  const p0 = [];
  const p1 = [];
  const p2 = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      throw new Error(`concern 项必须是对象，收到 ${JSON.stringify(item)}`);
    }
    // id 必填（契约要求）；title 仅作为分组格式无 description 时的正文兜底。
    const id = item.id ?? item.title;
    const severity = String(item.severity ?? "").toUpperCase();
    const description = item.description ?? item.title;
    if (!id || !description) {
      throw new Error(`concern 缺少必填字段 id/description：${JSON.stringify(item)}`);
    }
    if (severity !== "P0" && severity !== "P1" && severity !== "P2") {
      throw new Error(`concern severity 必须为 P0/P1/P2，收到 "${item.severity}"（id=${String(id)}）`);
    }
    // 责任人（author）必填：日报 collect-ai.js 按 author 过滤/落实到人，缺失会导致
    // 日报把他人问题算到自己头上、且问题无法落实到人。
    if (!item.author) {
      throw new Error(`concern 缺少责任人 author（id=${String(id)}）`);
    }
    const status = item.status ?? "open";
    if (!STATUS_VALUES.includes(status)) {
      throw new Error(`concern status 必须为 ${STATUS_VALUES.join("/")}，收到 "${status}"（id=${String(id)}）`);
    }
    const normalized = {
      id: String(id),
      severity,
      status,
      file: item.file ?? "",
      line: item.line ?? 0,
      type: item.type ?? "correctness",
      description,
      author: String(item.author),
      ...(item.raised_by ? { raised_by: item.raised_by } : {}),
      ...(item.created_at ? { created_at: item.created_at } : {}),
      ...(item.resolved_by ? { resolved_by: item.resolved_by } : {}),
      ...(item.resolved_at ? { resolved_at: item.resolved_at } : {}),
    };
    if (severity === "P0") p0.push(normalized);
    else if (severity === "P1") p1.push(normalized);
    else p2.push(normalized);
  }
  return { p0, p1, p2 };
}
