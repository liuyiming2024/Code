#!/usr/bin/env bash
# 把 Web 端的解释器源码拷进 Android assets。
#
# 为什么用「拷贝」而不是「复制一份代码维护」：
#   cpplite.js / pylite.js 是**同一份**解释器，手机和网页都跑它。
#   复制成两份的话，修一处 bug 就要同步两处 ——
#   而"手机和网页跑同一段代码结果不同"是最难查的一类 bug
#   （用户会以为是自己的代码错了）。
#   所以 Web 端是唯一真源，这里只做拷贝。
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../js"
dst="$here/app/src/main/assets"
mkdir -p "$dst"
for f in cpplite.js pylite.js; do
  if [ ! -f "$src/$f" ]; then
    echo "找不到 $src/$f —— 请确认在 Code 仓库里运行本脚本" >&2
    exit 1
  fi
  cp "$src/$f" "$dst/$f"
  echo "已拷贝 $f ($(wc -c < "$dst/$f") 字节)"
done
echo "完成。解释器已就位：$dst"
