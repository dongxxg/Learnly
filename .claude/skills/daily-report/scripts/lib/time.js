'use strict';

// lib/time.js — CST (UTC+8) 时区工具函数
//
// 中国标准时间（CST）不实行夏令时，固定 UTC+8 偏移。
// 所有日报脚本的日期计算统一走这里，避免魔法数字散落。

const CST_OFFSET_MS = 8 * 3600 * 1000;

/** 将任意 Date 转换为 CST 时间的 Date 对象（不修改原对象） */
function toCST(date = new Date()) {
  return new Date(date.getTime() + CST_OFFSET_MS);
}

/** 获取当前 CST 日期字符串（YYYY-MM-DD） */
function todayCST() {
  return formatDate(toCST());
}

/** 将 CST Date 对象格式化为 YYYY-MM-DD */
function formatDate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 判断 UTC 时间戳在 CST 时区下是否等于目标日期 */
function isDateMatch(utcTimestamp, targetDate) {
  const d = new Date(utcTimestamp);
  if (isNaN(d.getTime())) return false;
  return formatDate(toCST(d)) === targetDate;
}

module.exports = { toCST, todayCST, formatDate, isDateMatch, CST_OFFSET_MS };
