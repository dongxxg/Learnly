#!/usr/bin/env python3
"""ci-mr-comment — 通过 GitLab API 向 MR 发评论

用法: ci-mr-comment.py <mr_iid> [comment_file]
       echo "comment" | ci-mr-comment.py <mr_iid>
"""

import json
import os
import sys
import urllib.error
import urllib.request

GITLAB_URL = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
PROJECT_ID = os.environ.get("CI_PROJECT_ID", "")
TOKEN = os.environ.get("GITLAB_TOKEN", "")


def main():
    if not TOKEN:
        print("[ci-comment] Error: GITLAB_TOKEN is required", file=sys.stderr)
        raise SystemExit(1)

    if len(sys.argv) < 2:
        print("Usage: ci-mr-comment.py <mr_iid> [comment_file]", file=sys.stderr)
        raise SystemExit(1)

    mr_iid = sys.argv[1]
    comment_file = sys.argv[2] if len(sys.argv) > 2 else ""

    if comment_file and os.path.isfile(comment_file):
        with open(comment_file) as f:
            body = f.read()
    else:
        body = sys.stdin.read()

    if not body.strip():
        print("[ci-comment] Error: empty comment body", file=sys.stderr)
        raise SystemExit(1)

    url = f"{GITLAB_URL}/projects/{PROJECT_ID}/merge_requests/{mr_iid}/notes"
    payload = json.dumps({"body": body}).encode()

    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(url, data=payload)
            req.add_header("PRIVATE-TOKEN", TOKEN)
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                note_id = data.get("id", "unknown")
                print(f"[ci-comment] Posted note {note_id} to MR !{mr_iid}")
                return
        except urllib.error.HTTPError as e:
            if attempt >= 3:
                print(f"[ci-comment] Error: HTTP {e.code}", file=sys.stderr)
                raise SystemExit(1)
        except OSError:
            if attempt >= 3:
                raise SystemExit(1)


if __name__ == "__main__":
    main()
