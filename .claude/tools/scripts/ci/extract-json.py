#!/usr/bin/env python3
"""ci-extract-json — 从 claude --output-format json 的 stdout 中提取评审结果

用法: echo "$CLAUDE_OUTPUT" | ci-extract-json.py <output_file> [default_score] [default_verdict]
"""

import json
import re
import sys


def main():
    output_file = sys.argv[1] if len(sys.argv) > 1 else "result.json"
    default_score = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    default_verdict = sys.argv[3] if len(sys.argv) > 3 else "rework"

    raw = sys.stdin.read()
    review = {
        "score": default_score,
        "p0_count": 0,
        "verdict": default_verdict,
        "details": "no output",
    }

    try:
        d = json.loads(raw)
        t = d.get("result", "")

        patterns = [
            r'\{[^{}]*"score"\s*:\s*\d+[^{}]*\}',
            r'\{[^{}]+\}',
        ]
        for pat in patterns:
            m = re.search(pat, t)
            if m:
                try:
                    parsed = json.loads(m.group())
                    if "score" in parsed:
                        review = parsed
                        break
                except (json.JSONDecodeError, ValueError):
                    continue

        if review["verdict"] == "rework":
            if re.search(r"(?i)approved|verdict.*pass|评审通过|PASS", t):
                review["verdict"] = "approved"
    except Exception as e:
        review["details"] = f"parse error: {e}"

    json.dump(review, open(output_file, "w"), ensure_ascii=False)
    print(f"Extracted to {output_file}: {review}")


if __name__ == "__main__":
    main()
