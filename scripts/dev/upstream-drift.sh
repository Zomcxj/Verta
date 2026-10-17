#!/usr/bin/env bash
# Verta 相对上游 terax-ai 的漂移检查：比对两个仓库 index 的 mode + blob + 路径。
# 上游是 depth-1 浅克隆（git fetch 会被拒），所以不取 ref，直接读它的 index。
set -uo pipefail

# comm 要求两边按整行排序，且排序规则与 comm 自身的 strcoll 一致，所以整个脚本固定 C locale。
export LC_ALL=C

UPSTREAM="${UPSTREAM_REPO:-/f/VibeCoding_workspace/GitProject/terax-ai}"

up_index() { git -C "$UPSTREAM" ls-files -s | sort; }
vt_index() { git ls-files -s | sort; }

echo "上游 HEAD: $(git -C "$UPSTREAM" rev-parse --short HEAD)  ($UPSTREAM)"

drift="$(comm -23 <(up_index) <(vt_index))"
extra="$(comm -13 <(up_index) <(vt_index))"

if [ -n "$drift" ]; then
  echo "漂移（上游有、Verta 没有，或 mode/hash 不同）:"
  echo "$drift" | sed 's/^/  /'
else
  echo "漂移: 无"
fi

if [ -n "$extra" ]; then
  echo "Verta 独有:"
  echo "$extra" | sed 's/^/  /'
fi

[ -z "$drift" ]