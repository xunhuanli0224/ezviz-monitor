#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包「干净可移植副本」为 zip。

用法：
    python portable.py                  # 不含凭证与历史报告（推荐，可安全分发）
    python portable.py --with-config    # 连同本机 config.json 一起打包（仅限自有设备间迁移）
    python portable.py --out D:/tmp     # 指定输出目录

只依赖 Python 标准库。
"""
from __future__ import annotations

import argparse
import os
import sys
import zipfile
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")

# 与打包产物无关的目录 / 文件（build_exe.py 保留，便于目标机具备 Python 时自行构建）
SKIP_DIRS = {"dist", "dist_exe", "build", "__pycache__", "reports", ".git", ".idea", ".vscode"}
SKIP_NAMES = {".DS_Store", "Thumbs.db", "portable.py"}
SKIP_SUFFIX = (".pyc", ".pyo", ".log", ".tmp", ".spec")
SKIP_PREFIX = (".chrome", ".c1", ".c2", ".c9", ".c10", ".c11", ".c12", "_")


def collect(with_config: bool) -> list[str]:
    out = []
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(SKIP_PREFIX)]
        for name in files:
            if name in SKIP_NAMES or name.startswith(SKIP_PREFIX):
                continue
            if name.endswith(SKIP_SUFFIX):
                continue
            if name == "config.json" and not with_config:
                continue
            full = os.path.join(base, name)
            out.append(os.path.relpath(full, ROOT))
    return sorted(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="打包萤石云监控墙的可移植副本")
    ap.add_argument("--with-config", action="store_true",
                    help="同时打包 config.json（含 AppSecret，勿对外分发）")
    ap.add_argument("--out", default=DIST, help="输出目录，默认 ./dist")
    args = ap.parse_args()

    files = collect(args.with_config)
    if not files:
        print("[ERROR] 没有可打包的文件，请确认脚本位于项目根目录。")
        return 1

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    os.makedirs(args.out, exist_ok=True)
    zip_path = os.path.join(args.out, "ezviz_monitor_portable_%s.zip" % stamp)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for rel in files:
            # 统一放在顶层目录里，解压即得完整工程
            zf.write(os.path.join(ROOT, rel), os.path.join("ezviz_monitor", rel.replace(os.sep, "/")))

    size_kb = os.path.getsize(zip_path) / 1024.0
    print("打包完成：%s" % zip_path)
    print("文件数：%d    体积：%.0f KB" % (len(files), size_kb))
    print("凭证：%s" % ("已包含 config.json（注意保密）" if args.with_config else "未包含（目标机需重新填写）"))
    print("\n内容清单：")
    for rel in files:
        print("  " + rel)

    if not args.with_config:
        print("\n[提示] 目标主机首次运行请点击「添加监控 → 设置凭证」重新填写 AppKey/AppSecret，"
              "\n       或直接使用直链（m3u8）方式，无需凭证。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
