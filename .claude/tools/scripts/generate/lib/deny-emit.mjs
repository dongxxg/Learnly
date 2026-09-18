// lib/deny-emit.mjs — 把 .claude/settings.json 的 permissions.deny（glob 数组）
// 转成各 agent 的 deny 表示。CodeBuddy 直接用数组；Codex 转成 prefix_rule TOML。
import { loadClaudeSettings } from './common.mjs';

/**
 * 桶定义：每个桶对应一条 Codex prefix_rule。
 * test(pat) 判断源 deny 内部模式属于哪个桶；prefix/match/not_match/justification 直接产出。
 * 顺序与现有手写 .codex/rules/default.rules 保持一致（便于 diff 等价）。
 */
const BUCKETS = [
  {
    key: 'rm', test: (p) => p.startsWith('rm -rf'), prefix: ['rm', '-rf'],
    match: ['rm -rf /', 'rm -rf /var/log', 'rm -rf /tmp/build'],
    justification: 'Recursive deletion is dangerous. Use targeted paths and review before executing.',
  },
  { key: 'mkfs', test: (p) => p.startsWith('mkfs'), prefix: ['mkfs'],
    justification: 'Filesystem creation is destructive and not needed in this workspace.' },
  { key: 'dd', test: (p) => p.startsWith('dd'), prefix: ['dd'],
    justification: 'dd to raw devices can destroy the host OS.' },
  { key: 'chmod', test: (p) => p.startsWith('chmod'), prefix: ['chmod', '-R', '777', '/'],
    justification: 'World-writable permissions on root is a security risk.' },
  { key: 'chown', test: (p) => p.startsWith('chown'), prefix: ['chown'],
    justification: 'Ownership changes are not needed in this workspace.' },
  { key: 'shutdown', test: (p) => p.startsWith('shutdown'), prefix: ['shutdown'],
    justification: 'System shutdown is not allowed from the agent.' },
  { key: 'reboot', test: (p) => p.startsWith('reboot'), prefix: ['reboot'],
    justification: 'System reboot is not allowed from the agent.' },
  { key: 'init', test: (p) => p.startsWith('init'), prefix: ['init'],
    justification: 'Init system commands are not allowed from the agent.' },
  {
    key: 'push-force', test: (p) => p.includes('push') && p.includes('--force'),
    prefix: ['git', 'push', '--force'], match: ['git push --force', 'git push --force origin main'],
    not_match: ['git push origin main', 'git push --force-with-lease'],
    justification: 'Use `git push --force-with-lease` instead of --force.',
  },
  {
    key: 'push-f', test: (p) => p.includes('push') && p.includes('-f '),
    prefix: ['git', 'push', '-f'], match: ['git push -f', 'git push -f origin main'],
    not_match: ['git push origin main'],
    justification: 'Use `git push` without -f, or `git push --force-with-lease`.',
  },
  {
    key: 'reset-hard', test: (p) => p.includes('reset --hard'),
    prefix: ['git', 'reset', '--hard'],
    justification: 'Use `git reset --soft` or `git restore` instead of --hard.',
  },
  {
    key: 'checkout-dot', test: (p) => p.includes('checkout -- .'),
    prefix: ['git', 'checkout', '--', '.'], match: ['git checkout -- .'],
    justification: 'Use `git restore <file>` to undo specific files instead of discarding everything.',
  },
  {
    key: 'restore-dot', test: (p) => p.includes('restore .'),
    prefix: ['git', 'restore', '.'], match: ['git restore .'],
    justification: 'Use `git restore <file>` targeting specific files, not the whole tree.',
  },
  {
    key: 'clean', test: (p) => p.includes('clean'),
    prefix: ['git', 'clean'],
    justification: 'Use `git clean -n` for a dry-run preview, or escalate. Force-clean is not allowed from the agent.',
  },
  {
    key: 'merge', test: (p) => p.includes('merge'),
    prefix: ['git', 'merge'],
    justification: 'Use the web UI or perform the merge manually. The agent cannot merge branches.',
  },
];

/** 从 "Bash(rm -rf /)" 提取内部模式 "rm -rf /" */
function innerPattern(entry) {
  const m = /^Bash\((.*)\)$/.exec(entry);
  return m ? m[1] : entry;
}

function ruleBlock(b) {
  const lines = ['prefix_rule('];
  lines.push(`    pattern = ${JSON.stringify(b.prefix)},`);
  lines.push(`    decision = "forbidden",`);
  lines.push(`    justification = ${JSON.stringify(b.justification)},`);
  if (b.match) lines.push(`    match = ${JSON.stringify(b.match)},`);
  if (b.not_match) lines.push(`    not_match = ${JSON.stringify(b.not_match)},`);
  lines.push(')');
  return lines.join('\n');
}

/**
 * 生成 Codex prefix_rule TOML（.codex/rules/default.rules）。
 * 源 deny 数组 → 桶分类 → 有序 prefix_rule 块。
 *
 * 未匹配的 deny 条目（BUCKETS 未覆盖）会输出 stderr warning，不中断生成。
 * 这是防漂移守卫：新增 deny 类型必须同步更新 BUCKETS，否则这里会提醒。
 */
export function toCodexRulesToml() {
  const src = loadClaudeSettings();
  const deny = src.permissions?.deny ?? [];
  const used = new Set();   // 桶 key 去重（已产出规则的桶）
  const covered = new Set(); // 已被任意桶命中过的 deny entry（含 glob 同类）
  const unmatched = [];
  const blocks = [];
  for (const entry of deny) {
    const pat = innerPattern(entry);
    let matchedBucket = null;
    for (const b of BUCKETS) {
      if (b.test(pat)) {
        matchedBucket = b;
        break;
      }
    }
    if (!matchedBucket) {
      unmatched.push(entry);
      continue;
    }
    covered.add(entry);
    // 同桶首次出现才产出规则块（Codex prefix_rule 按 prefix 匹配，多条同类 deny 共享一条规则即可）
    if (!used.has(matchedBucket.key)) {
      used.add(matchedBucket.key);
      blocks.push(ruleBlock(matchedBucket));
    }
  }
  // 防漂移：完全无桶匹配的 deny 静默丢失会让 .codex/rules/default.rules 漏规则。
  // 输出 stderr warning 让 generator 调用方能发现（CI/手动跑都会看到）。
  if (unmatched.length) {
    console.warn(
      `[generate] ⚠️ deny-emit: ${unmatched.length} 条 deny 未被 BUCKETS 匹配，新增类型需同步更新 deny-emit.mjs:\n`
      + unmatched.map((e) => `  - ${e}`).join('\n'),
    );
  }
  const header = `# ── rd_harness execpolicy rules ──────────────────────────────────────────────
# Codex equivalent of .claude/settings.json deny list.
# Generated by .claude/tools/scripts/generate/ — do not edit by hand.
# Matches Claude's defaultMode: bypassPermissions – everything not forbidden
# is silently allowed without prompting. All deny patterns from the original
# are translated as forbidden.
`;
  return header + '\n' + blocks.join('\n\n') + '\n';
}

/** CodeBuddy/Claude 风格的 deny 数组（直接复用源数组） */
export function toDenyArray() {
  const src = loadClaudeSettings();
  return src.permissions?.deny ?? [];
}
