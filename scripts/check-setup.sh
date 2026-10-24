#!/usr/bin/env bash
# 新手自检：检查整理版是否已填好占位符、语法是否通过、关键文件是否齐全。
# 注意：刚下载时占位符还没填，本脚本会如实列出未填项——这不是报错，是待办清单。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

echo "== 占位符检查（模板文件，只列文件和行号） =="
if grep -rn -o '"<BOT_ACCOUNT>"\|"<OWNER_ID>"\|<USER_NAME>\|<ASSISTANT_NAME>\|机器人 BOT_ACCOUNT\|机主本人 OWNER_ID' \
    "$ROOT/bridge/wechat-ilink-poll.sh" "$ROOT/bridge/wechat-ilink-poll.json" \
    "$ROOT/bridge/watchman-health.py" "$ROOT/bridge/patches" \
    "$ROOT/codex-host/verify_window.py" 2>/dev/null; then
  echo "上面这些占位符还没填（按 README 第 1 步填完再跑一次）"
  fail=1
else
  echo "占位符已全部填好"
fi

echo "== 语法检查 =="
bash -n "$ROOT/bridge/wechat-ilink-poll.sh" && echo "轮询脚本语法通过" || fail=1
python3 -m json.tool "$ROOT/bridge/wechat-ilink-poll.json" > /dev/null && echo "hook 定义 JSON 通过" || fail=1
for f in "$ROOT/bridge/watchman-health.py" "$ROOT/codex-host/verify_window.py"; do
  python3 -c "compile(open('$f').read(), '$f', 'exec')" && echo "通过 $f" || fail=1
done

echo "== 关键文件 =="
for f in bridge/wechat-ilink-poll.sh bridge/wechat-ilink-poll.json bridge/watchman-health.py codex-host/verify_window.py; do
  if [ -f "$ROOT/$f" ]; then echo "有 $f"; else echo "缺 $f"; fail=1; fi
done

exit $fail
