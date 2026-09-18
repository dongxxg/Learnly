'use strict';

// taskboard-daily 简化版 person.js
//
// daily-report 的 collect-git.js 通过 fetchTeam() 调 GitLab team.json 拿
// commit author 的别名扩展（多账号归一化）。taskboard-daily 不走 GitLab
// 后端，直接返回空 team，让 collect-git.js 走它自己的 fallback 路径
// （严格匹配 commit.author === git_username）。

async function fetchTeam() {
  return { members: [] };
}

function findByUsername(team, username) {
  if (!team || !Array.isArray(team.members)) return null;
  return team.members.find((m) => m.git_username === username) || null;
}

function findByGroup(team, group) {
  if (!team || !Array.isArray(team.members)) return [];
  return team.members.filter((m) => m.group === group);
}

function resolve(team, input) {
  if (!input) return null;
  return findByUsername(team, input) || null;
}

module.exports = { fetchTeam, findByUsername, findByGroup, resolve };
