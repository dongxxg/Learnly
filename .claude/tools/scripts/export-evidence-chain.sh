#!/usr/bin/env bash
# 合规证据链打包：从 pipeline-state.json 提取六字段，输出 CSV + Markdown
# 用法: bash export-evidence-chain.sh [--output <dir>] [--since <YYYY-MM-DD>]
set -euo pipefail

OUTPUT_DIR="${PWD}/evidence-export"
SINCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --since) SINCE="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

TASKS_DIR=".harness/tasks"
[ -d "$TASKS_DIR" ] || { echo "No $TASKS_DIR directory"; exit 0; }

mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date -Iseconds)
CSV_FILE="$OUTPUT_DIR/evidence-chain.csv"
MD_FILE="$OUTPUT_DIR/evidence-chain.md"

# 提取逻辑写到独立 python 脚本，shell 仅负责调用
EXTRACTOR=$(mktemp)
cat > "$EXTRACTOR" <<'PYEOF'
import json, os, sys, glob

tasks_dir = sys.argv[1]
since = sys.argv[2] if len(sys.argv) > 2 else ""
csv_path = sys.argv[3]
md_path = sys.argv[4]
timestamp = sys.argv[5]

rows = []
files = sorted(glob.glob(os.path.join(tasks_dir, '*/pipeline-state.json')))

for ps in files:
    try:
        with open(ps) as f:
            d = json.load(f)
    except Exception:
        continue

    change_name = d.get('change_name', os.path.basename(os.path.dirname(ps)))
    created = (d.get('created_at', '') or '')[:10]
    if since and created < since:
        continue

    intent = d.get('intent') or {}
    trigger_source = (intent.get('raw_input', '') or '?')[:120]
    caller = d.get('caller', '') or '?'

    gates = d.get('quality_gates') or {}
    gate_str = ', '.join(f'{k}:{v}' for k, v in sorted(gates.items())) or '?'

    title = d.get('title', change_name) or change_name
    criteria = d.get('acceptance_criteria') or []
    summary = title[:100]
    if criteria:
        summary += ' | ' + '; '.join(str(c)[:60] for c in criteria[:2])

    metrics = d.get('quality_metrics') or {}
    test_report = 'FPR:{} rework:{} phases:{}/{}'.format(
        metrics.get('first_pass_rate', '?'),
        metrics.get('total_rework_loops', '?'),
        metrics.get('phases_completed', '?'),
        metrics.get('phases_total', '?'),
    )

    scores = d.get('scores') or {}
    review_score = scores.get('reviewer', '-') or '-'

    tokens = d.get('token_summary') or {}
    token_total = tokens.get('total_tokens', 0) or 0

    completed = (d.get('completed_at') or d.get('updated_at') or '')[:10]

    rows.append({
        'change_name': change_name,
        'trigger_source': trigger_source,
        'caller': caller,
        'gate_str': gate_str,
        'summary': summary,
        'test_report': test_report,
        'review_score': review_score,
        'token_total': token_total,
        'completed': completed,
    })

# CSV
with open(csv_path, 'w') as f:
    f.write('变更名称,触发来源,调用者,意图门禁,变更摘要,测试报告,Review评分,Token消费,完成时间\n')
    for r in rows:
        f.write('"{}","{}","{}","{}","{}","{}",{},{},"{}"\n'.format(
            r['change_name'], r['trigger_source'], r['caller'], r['gate_str'],
            r['summary'], r['test_report'], '', r['review_score'], r['token_total'], r['completed']))

# Markdown
with open(md_path, 'w') as f:
    f.write('# 合规证据链报告\n\n')
    f.write('> 生成时间: {}\n'.format(timestamp))
    f.write('> 数据源: `.harness/tasks/*/pipeline-state.json`\n\n')
    f.write('## 六字段证据链\n\n')
    f.write('| # | 变更名称 | 触发来源 | 意图门禁 | 变更摘要 | 测试报告 | Review | Token | 时间 |\n')
    f.write('|---|---------|---------|---------|---------|---------|--------|-------|------|\n')
    for i, r in enumerate(rows, 1):
        f.write('| {} | {} | {} | {} | {} | {} | {} | {} | {} |\n'.format(
            i, r['change_name'], r['trigger_source'][:60], r['gate_str'][:50],
            r['summary'][:80], r['test_report'], r['review_score'], r['token_total'], r['completed']))

    total_tokens = sum(r['token_total'] for r in rows)
    f.write('\n## 汇总\n\n')
    f.write('| 指标 | 值 |\n')
    f.write('|------|-----|\n')
    f.write('| 变更总数 | {} |\n'.format(len(rows)))
    f.write('| Token 总消费 | {} |\n'.format(total_tokens))
    f.write('| 生成时间 | {} |\n'.format(timestamp))
    f.write('\n> 六字段定义见 SPEC §11.1 H4 治理可证。\n')

print('合规证据链导出完成:')
print('  CSV: {}  ({} 条)'.format(csv_path, len(rows)))
print('  MD:  {}  ({} 条)'.format(md_path, len(rows)))
print('  Token 总消费: {}'.format(total_tokens))
PYEOF

python3 "$EXTRACTOR" "$TASKS_DIR" "$SINCE" "$CSV_FILE" "$MD_FILE" "$TIMESTAMP"
rm -f "$EXTRACTOR"