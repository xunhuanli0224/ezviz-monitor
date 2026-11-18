#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用 PyInstaller 把本项目打包成单文件可执行程序（免安装 Python）。

用法：
    python build_exe.py                 # 生成 dist_exe/EzvizWall.exe（或同名二进制）
    python build_exe.py --name 监控墙    # 自定义产物名
    python build_exe.py --onedir        # 改为目录模式（启动更快，但不是一个文件）

前置条件：目标机器需先安装 PyInstaller
    pip install pyinstaller

产物说明：
    单文件 exe 会把 web/ 打进包内，运行时解压到临时目录；
    config.json 与 reports/ 会自动创建在 exe 所在目录，因此可以把 exe 单独拷到任意位置使用。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist_exe")
BUILD = os.path.join(ROOT, "build")


def check_pyinstaller() -> bool:
    try:
        import PyInstaller  # noqa: F401
        return True
    except ImportError:
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="打包萤石云监控墙为单文件可执行程序")
    ap.add_argument("--name", default="EzvizWall", help="产物名称，默认 EzvizWall")
    ap.add_argument("--onedir", action="store_true", help="使用目录模式（启动更快）")
    ap.add_argument("--icon", default="", help="可选：.ico 图标路径")
    args = ap.parse_args()

    if not check_pyinstaller():
        print("[ERROR] 未安装 PyInstaller。请先执行：")
        print("        %s -m pip install pyinstaller" % sys.executable)
        return 1

    web_src = os.path.join(ROOT, "web")
    if not os.path.isfile(os.path.join(web_src, "index.html")):
        print("[ERROR] 未找到 web/index.html，请在项目根目录执行本脚本。")
        return 1
    if not os.path.isfile(os.path.join(web_src, "vendor", "hls.min.js")):
        print("[WARN] 缺少 web/vendor/hls.min.js，产物将无法离线播放（会退回 CDN）。")

    for d in (DIST, BUILD):
        shutil.rmtree(d, ignore_errors=True)

    # --add-data 的分隔符：Windows 用 ';'，其他平台用 ':'（os.pathsep 正好对应）
    add_data = "%s%s%s" % (web_src, os.pathsep, "web")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--onedir" if args.onedir else "--onefile",
        "--console",
        "--name", args.name,
        "--add-data", add_data,
        "--distpath", DIST,
        "--workpath", BUILD,
        "--specpath", BUILD,
    ]
    if args.icon:
        if os.path.isfile(args.icon):
            cmd += ["--icon", os.path.abspath(args.icon)]
        else:
            print("[WARN] 图标文件不存在，已忽略：%s" % args.icon)
    cmd.append(os.path.join(ROOT, "server.py"))

    print("执行：")
    print("  " + " ".join(cmd))
    print()
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print("\n[ERROR] 打包失败，退出码 %d" % result.returncode)
        return result.returncode

    exe_name = args.name + (".exe" if os.name == "nt" else "")
    if args.onedir:
        target = os.path.join(DIST, args.name, exe_name)
    else:
        target = os.path.join(DIST, exe_name)

    if not os.path.isfile(target):
        print("[ERROR] 未找到产物：%s" % target)
        return 1

    size_mb = os.path.getsize(target) / (1024.0 * 1024.0)
    print()
    print("=" * 60)
    print(" 打包完成：%s" % target)
    print(" 体积：%.1f MB" % size_mb)
    print("=" * 60)
    print(" 使用方式：双击运行，或命令行 %s --port 8770" % exe_name)
    print(" config.json 与 reports/ 会在 exe 同级目录自动创建。")
    print(" 目标机无需安装 Python，也无需拷贝 web 目录。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
