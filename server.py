# -*- coding: utf-8 -*-
"""
萤石云监控墙 · 本地服务端
------------------------------------------------------------
职责：
  1. 代理萤石开放平台 OpenAPI（规避浏览器 CORS，避免 AppSecret 暴露在前端）
  2. AccessToken 自动获取与续期（服务端缓存，剩余 <120s 自动刷新）
  3. 设备/通道枚举、直播地址（HLS / ezopen / RTMP）获取
  4. 批量巡检（供访问失败报告使用）
  5. 访问失败报告落盘（JSON / CSV / Markdown）

仅依赖 Python 标准库。默认监听 127.0.0.1，不对外暴露。
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "萤石云监控墙"
APP_VERSION = "1.0.0"

def _resolve_dirs() -> tuple[str, str]:
    """返回 (静态资源目录, 数据目录)。

    - 源码运行：两者都是脚本所在目录。
    - PyInstaller 单文件运行：静态资源被解压到临时目录 sys._MEIPASS，
      而 config.json / reports 必须落在 exe 同级目录，否则进程一退出就全部丢失。
    """
    if getattr(sys, "frozen", False):
        res_dir = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(sys.executable))
        data_dir = os.path.dirname(os.path.abspath(sys.executable))
        return res_dir, data_dir
    here = os.path.dirname(os.path.abspath(__file__))
    return here, here


RES_DIR, DATA_DIR = _resolve_dirs()
ROOT = DATA_DIR                                  # 可写数据根目录（config / reports）
WEB_DIR = os.path.join(RES_DIR, "web")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
REPORT_DIR = os.path.join(DATA_DIR, "reports")
DEFAULT_API_BASE = "https://open.ys7.com"

_LOCK = threading.RLock()
_CONFIG: dict = {}
_HTTP_TIMEOUT = 15


# --------------------------------------------------------------------------- #
# 错误模型
# --------------------------------------------------------------------------- #
class ApiError(Exception):
    """统一的接口错误，携带萤石业务码与出错阶段。"""

    def __init__(self, code: str, message: str, stage: str = "api"):
        super().__init__(message)
        self.code = str(code)
        self.message = message
        self.stage = stage

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "stage": self.stage}


# --------------------------------------------------------------------------- #
# 配置读写
# --------------------------------------------------------------------------- #
def load_config() -> dict:
    global _CONFIG
    with _LOCK:
        data = {}
        if os.path.isfile(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                    data = json.load(fh) or {}
            except Exception as exc:  # 配置损坏时不阻塞启动
                sys.stderr.write("[warn] config.json 解析失败：%s\n" % exc)
                data = {}
        data.setdefault("appKey", "")
        data.setdefault("appSecret", "")
        data.setdefault("apiBase", "")
        data.setdefault("token", "")
        data.setdefault("tokenExpireAt", 0)
        _CONFIG = data
        return _CONFIG


def save_config() -> bool:
    """写回配置。目录只读时返回 False 而不是让进程崩掉。"""
    with _LOCK:
        tmp = CONFIG_PATH + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(_CONFIG, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, CONFIG_PATH)
            return True
        except OSError as exc:
            sys.stderr.write("[warn] 配置无法写入（%s）：%s\n" % (CONFIG_PATH, exc))
            try:
                if os.path.isfile(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            return False


def api_base() -> str:
    base = (_CONFIG.get("apiBase") or os.environ.get("EZVIZ_API_BASE") or DEFAULT_API_BASE).strip()
    return base.rstrip("/")


def mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 6:
        return value[:2] + "***"
    return value[:4] + "***" + value[-2:]


# --------------------------------------------------------------------------- #
# 萤石 OpenAPI 调用
# --------------------------------------------------------------------------- #
def api_post(path: str, params: dict, timeout: int = _HTTP_TIMEOUT):
    url = api_base() + path
    payload = urllib.parse.urlencode(
        {k: v for k, v in params.items() if v is not None}
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            "User-Agent": "EzvizWall/%s" % APP_VERSION,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raise ApiError("HTTP_%d" % exc.code, "萤石接口返回 HTTP %d" % exc.code, "network")
    except urllib.error.URLError as exc:
        raise ApiError("NETERR", "无法连接萤石开放平台（%s），请检查本机网络或代理设置" % exc.reason, "network")
    except socket.timeout:
        raise ApiError("NETERR", "请求萤石接口超时（%d 秒）" % timeout, "network")

    try:
        body = json.loads(raw)
    except Exception:
        raise ApiError("BAD_JSON", "接口返回非 JSON 内容：%s" % raw[:160], "network")

    code = str(body.get("code", "")).strip()
    if code != "200":
        raise ApiError(code or "UNKNOWN", body.get("msg") or "接口调用失败")
    return body.get("data")


def ensure_token(force: bool = False) -> tuple[str, int]:
    """返回 (accessToken, 过期时间秒级时间戳)。必要时自动刷新。"""
    with _LOCK:
        now = time.time()
        token = _CONFIG.get("token") or ""
        expire_at = float(_CONFIG.get("tokenExpireAt") or 0)
        if not force and token and expire_at - now > 120:
            return token, int(expire_at)

        app_key = (_CONFIG.get("appKey") or "").strip()
        app_secret = (_CONFIG.get("appSecret") or "").strip()
        if not app_key or not app_secret:
            raise ApiError("NO_CRED", "尚未配置 AppKey / AppSecret，请先在「设置凭证」中填写", "config")

        data = api_post("/api/lapp/token/get", {"appKey": app_key, "appSecret": app_secret}) or {}
        token = data.get("accessToken") or ""
        raw_exp = data.get("expireTime") or 0
        try:
            raw_exp = float(raw_exp)
        except Exception:
            raw_exp = 0.0
        # 萤石返回毫秒时间戳
        expire_at = raw_exp / 1000.0 if raw_exp > 1e11 else raw_exp
        if not token:
            raise ApiError("NO_TOKEN", "接口未返回 accessToken", "api")

        _CONFIG["token"] = token
        _CONFIG["tokenExpireAt"] = expire_at
        save_config()
        return token, int(expire_at)


# --------------------------------------------------------------------------- #
# 业务动作
# --------------------------------------------------------------------------- #
PROTOCOL_MAP = {1: "ezopen", 2: "hls", 3: "rtmp"}


def action_live(serial: str, channel: int, protocol: int, quality: int, expire: int = 7200) -> dict:
    token, _ = ensure_token()
    protocol = int(protocol or 2)
    quality = int(quality or 2)
    params = {
        "accessToken": token,
        "source": "%s:%d" % (serial, int(channel or 1)),
        "protocol": protocol,
        "quality": quality,
    }
    if expire:
        params["expireTime"] = int(expire)
    data = api_post("/api/lapp/live/address/get", params)

    url = ""
    expire_at = 0
    if isinstance(data, list) and data:
        url = data[0].get("url") or ""
        expire_at = data[0].get("expireTime") or 0
    elif isinstance(data, dict):
        url = data.get("url") or ""
        expire_at = data.get("expireTime") or 0

    if not url:
        raise ApiError("EMPTY_URL", "接口未返回可用的直播地址", "api")

    try:
        expire_at = float(expire_at)
        expire_at = expire_at / 1000.0 if expire_at > 1e11 else expire_at
    except Exception:
        expire_at = 0

    return {
        "url": url,
        "protocol": PROTOCOL_MAP.get(protocol, str(protocol)),
        "expireAt": int(expire_at),
        "channel": int(channel or 1),
        "serial": serial,
        "quality": quality,
    }


def action_devices(page_start: int = 0, page_size: int = 50) -> list:
    token, _ = ensure_token()
    data = api_post(
        "/api/lapp/device/list",
        {"accessToken": token, "pageStart": int(page_start), "pageSize": int(page_size)},
    )
    return data or []


def action_cameras(serial: str) -> list:
    token, _ = ensure_token()
    data = api_post("/api/lapp/camera/list", {"accessToken": token, "deviceSerial": serial})
    return data or []


def _as_int(value, default: int) -> int:
    """宽松转整数：非法值回落默认值，避免单条脏数据打断整批巡检。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def action_probe(items: list, protocol: int, quality: int) -> dict:
    """批量巡检：逐路获取直播地址，记录耗时与失败原因。"""
    results = []
    for item in items or []:
        if not isinstance(item, dict):
            item = {}
        serial = str(item.get("serial") or "").strip()
        channel = _as_int(item.get("channel"), 1)
        proto = _as_int(item.get("protocol"), protocol or 2)
        qual = _as_int(item.get("quality"), quality or 2)
        name = item.get("name") or serial
        started = time.time()
        record = {
            "name": name,
            "serial": serial,
            "channel": channel,
            "protocol": PROTOCOL_MAP.get(proto, str(proto)),
            "quality": qual,
            "ok": False,
            "code": "",
            "message": "",
            "stage": "",
            "url": "",
            "expireAt": 0,
            "latencyMs": 0,
            "checkedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        try:
            info = action_live(serial, channel, proto, qual)
            record.update(
                ok=True,
                url=info["url"],
                expireAt=info["expireAt"],
                message="地址获取成功",
                stage="ok",
            )
        except ApiError as exc:
            record.update(code=exc.code, message=exc.message, stage=exc.stage)
        except Exception as exc:  # 兜底，避免单路异常中断整批
            record.update(code="UNEXPECTED", message=str(exc), stage="client")
        finally:
            record["latencyMs"] = int((time.time() - started) * 1000)
        results.append(record)
        time.sleep(0.25)  # 控制调用频率，规避平台限流

    ok_count = sum(1 for r in results if r["ok"])
    return {
        "total": len(results),
        "ok": ok_count,
        "fail": len(results) - ok_count,
        "items": results,
    }


# --------------------------------------------------------------------------- #
# 报告落盘
# --------------------------------------------------------------------------- #
def _fmt_seconds(ms: int) -> str:
    try:
        ms = int(ms or 0)
    except Exception:
        return "-"
    if ms < 1000:
        return "%d ms" % ms
    return "%.2f s" % (ms / 1000.0)


def _md_cell(value) -> str:
    """Markdown 表格单元格转义：竖线与换行会破坏表格结构。"""
    return str(value if value is not None else "").replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def _write_text(path: str, text: str, encoding: str = "utf-8") -> None:
    """写文本文件，失败时抛出带明确阶段信息的 ApiError。"""
    try:
        with open(path, "w", encoding=encoding, newline="") as fh:
            fh.write(text)
    except OSError as exc:
        raise ApiError("REPORT_WRITE", "报告写入失败：%s（%s）" % (os.path.basename(path), exc), "report")


def write_report(report: dict, dry_run: bool = False) -> dict:
    """渲染并落盘报告。dry_run=True 时仅渲染返回文本，不产生文件（供预览用）。"""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = os.path.join(REPORT_DIR, "access_report_%s" % stamp)
    if not dry_run:
        try:
            os.makedirs(REPORT_DIR, exist_ok=True)
        except OSError as exc:
            raise ApiError("REPORT_DIR", "报告目录不可写：%s（%s）" % (REPORT_DIR, exc), "report")
        # 同一秒内多次保存时追加序号，避免覆盖上一份
        seq = 1
        while os.path.exists(base + ".json") or os.path.exists(base + ".md"):
            seq += 1
            base = os.path.join(REPORT_DIR, "access_report_%s_%d" % (stamp, seq))

    meta = report.get("meta") or {}
    failures = report.get("failures") or []
    categories = report.get("categories") or []
    conclusion = report.get("conclusion") or ""
    generated_at = report.get("generatedAt") or datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # ---- JSON ----
    json_path = base + ".json"
    json_text = json.dumps(report, ensure_ascii=False, indent=2)
    if not dry_run:
        _write_text(json_path, json_text)

    # ---- CSV ----
    csv_path = base + ".csv"
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["序号", "通道名称", "设备序列号", "通道号", "协议", "错误码",
                     "错误描述", "失败阶段", "失败归类", "重试次数", "最后尝试时间", "处理建议"])
    for idx, row in enumerate(failures, 1):
        writer.writerow([
            idx, row.get("name", ""), row.get("serial", ""), row.get("channel", ""),
            row.get("protocol", ""), row.get("code", ""), row.get("message", ""),
            row.get("stage", ""), row.get("category", ""), row.get("attempts", 0),
            row.get("lastTry", ""), row.get("advice", ""),
        ])
    csv_text = buf.getvalue()
    if not dry_run:
        _write_text(csv_path, csv_text, "utf-8-sig")

    # ---- Markdown ----
    md_path = base + ".md"
    lines = []
    lines.append("# 萤石云监控访问失败总结报告")
    lines.append("")
    lines.append("> 生成工具：%s v%s　｜　生成时间：%s" % (APP_NAME, APP_VERSION, generated_at))
    lines.append("")
    lines.append("## 一、总体情况")
    lines.append("")
    lines.append("| 指标 | 数值 |")
    lines.append("| --- | --- |")
    lines.append("| 检测通道总数 | %s |" % meta.get("total", "-"))
    lines.append("| 访问成功 | %s |" % meta.get("ok", "-"))
    lines.append("| 访问失败 | %s |" % meta.get("fail", "-"))
    rate = meta.get("successRate", "-")
    evaluated = meta.get("evaluated")
    if evaluated is not None and not evaluated:
        rate_text = "未检测"
    else:
        rate_text = "%s%%" % rate
    lines.append("| 成功率 | %s |" % rate_text)
    if meta.get("demo"):
        lines.append("| 其中演示通道 | %s |" % meta.get("demo"))
    lines.append("| 检测总耗时 | %s |" % _fmt_seconds(meta.get("durationMs", 0)))
    lines.append("| 默认协议 / 清晰度 | %s / %s |" % (meta.get("protocol", "-"), meta.get("qualityLabel", "-")))
    lines.append("| 开放平台地址 | %s |" % meta.get("apiBase", "-"))
    lines.append("| AppKey | %s |" % (meta.get("appKeyMasked") or "未配置"))
    lines.append("")

    lines.append("## 二、失败归类统计")
    lines.append("")
    if categories:
        lines.append("| 失败归类 | 数量 | 涉及错误码 |")
        lines.append("| --- | --- | --- |")
        for cat in categories:
            lines.append("| %s | %s | %s |" % (
                _md_cell(cat.get("name", "-")), cat.get("count", 0),
                _md_cell("、".join(cat.get("codes") or []) or "-")))
    else:
        lines.append("本次检测未出现访问失败。")
    lines.append("")

    lines.append("## 三、失败明细")
    lines.append("")
    if failures:
        lines.append("| # | 通道名称 | 序列号 | 通道 | 协议 | 错误码 | 错误描述 | 归类 | 重试 | 最后尝试 |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for idx, row in enumerate(failures, 1):
            lines.append("| %d | %s | %s | %s | %s | `%s` | %s | %s | %s | %s |" % (
                idx, _md_cell(row.get("name", "-")), _md_cell(row.get("serial", "-")),
                _md_cell(row.get("channel", "-")), _md_cell(row.get("protocol", "-")),
                _md_cell(row.get("code", "-")), _md_cell(row.get("message", "-")),
                _md_cell(row.get("category", "-")), row.get("attempts", 0), _md_cell(row.get("lastTry", "-"))))
        lines.append("")
        lines.append("### 逐条处理建议")
        lines.append("")
        for idx, row in enumerate(failures, 1):
            lines.append("%d. **%s**（%s:%s）—— `%s` %s　→　%s" % (
                idx, _md_cell(row.get("name", "-")), _md_cell(row.get("serial", "-")),
                _md_cell(row.get("channel", "-")), _md_cell(row.get("code", "-")),
                _md_cell(row.get("message", "-")), _md_cell(row.get("advice", "-"))))
    else:
        lines.append("无失败记录。")
    lines.append("")

    lines.append("## 四、结论与建议")
    lines.append("")
    lines.append(conclusion or "（未填写结论）")
    lines.append("")
    lines.append("## 五、说明")
    lines.append("")
    lines.append("1. 本报告基于萤石开放平台 `live/address/get` 接口的实际返回结果生成，"
                 "「地址获取成功」仅代表平台侧下发地址成功，最终出画仍依赖设备推流与网络状况。")
    lines.append("2. 错误码含义以萤石开放平台官方文档为准，本工具内置映射仅供参考。")
    lines.append("3. 直播地址具有时效性（默认有效期 7200 秒），过期后需重新获取。")
    lines.append("")
    md_text = "\n".join(lines)
    if not dry_run:
        _write_text(md_path, md_text)

    if dry_run:
        # 预览模式：不落盘，直接把渲染结果回传
        return {"stamp": stamp, "json": json_text, "csv": csv_text, "md": md_text, "saved": False}

    return {
        "stamp": stamp,
        "json": os.path.relpath(json_path, ROOT),
        "csv": os.path.relpath(csv_path, ROOT),
        "md": os.path.relpath(md_path, ROOT),
        "saved": True,
        "urls": {
            "json": "/reports/" + os.path.basename(json_path),
            "csv": "/reports/" + os.path.basename(csv_path),
            "md": "/reports/" + os.path.basename(md_path),
        },
    }


# --------------------------------------------------------------------------- #
# HTTP 服务
# --------------------------------------------------------------------------- #
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "EzvizWall/" + APP_VERSION
    protocol_version = "HTTP/1.1"

    # -- 基础输出 ---------------------------------------------------------- #
    def _send(self, status: int, body, ctype: str, extra: dict | None = None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, val in (extra or {}).items():
            self.send_header(key, val)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, payload: dict, status: int = 200):
        self._send(status, json.dumps(payload, ensure_ascii=False), MIME[".json"])

    def _ok(self, data=None, **extra):
        payload = {"ok": True, "data": data}
        payload.update(extra)
        self._json(payload)

    def _err(self, exc: ApiError):
        self._json({"ok": False, "error": exc.to_dict()})

    def log_message(self, fmt, *args):
        if os.environ.get("EZVIZ_WALL_QUIET") == "1":
            return
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    # -- 请求解析 ---------------------------------------------------------- #
    def _query(self) -> tuple[dict, str]:
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        return {k: v[0] for k, v in qs.items()}, parsed.path

    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except Exception:
            length = 0
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8", "replace")) or {}
        except Exception:
            return {}

    # -- 静态资源 ---------------------------------------------------------- #
    def _serve_static(self, path: str):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"

        if rel.startswith("reports/"):
            target = os.path.normpath(os.path.join(ROOT, rel))
            root = os.path.normpath(REPORT_DIR)
        else:
            target = os.path.normpath(os.path.join(WEB_DIR, rel))
            root = os.path.normpath(WEB_DIR)

        # 必须按路径边界比较：字符串 startswith 会让 web/../web_evil 绕过校验
        target_abs = os.path.abspath(target)
        root_abs = os.path.abspath(root)
        if target_abs != root_abs and not target_abs.startswith(root_abs + os.sep):
            self._send(403, "Forbidden", "text/plain; charset=utf-8")
            return

        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            self._send(404, "404 Not Found: %s" % rel, "text/plain; charset=utf-8")
            return

        ext = os.path.splitext(target)[1].lower()
        if ext in (".csv", ".md"):
            ctype = "text/csv; charset=utf-8" if ext == ".csv" else "text/markdown; charset=utf-8"
            with open(target, "rb") as fh:
                data = fh.read()
            name = os.path.basename(target)
            self._send(200, data, ctype, {"Content-Disposition": 'attachment; filename="%s"' % name})
            return

        with open(target, "rb") as fh:
            data = fh.read()
        self._send(200, data, MIME.get(ext, "application/octet-stream"))

    # -- GET --------------------------------------------------------------- #
    def do_GET(self):
        _, path = self._query()
        try:
            if path == "/api/state":
                self._ok({
                    "appName": APP_NAME,
                    "version": APP_VERSION,
                    "apiBase": api_base(),
                    "hasCreds": bool((_CONFIG.get("appKey") or "").strip() and (_CONFIG.get("appSecret") or "").strip()),
                    "appKeyMasked": mask((_CONFIG.get("appKey") or "").strip()),
                    "tokenValid": bool(_CONFIG.get("token")) and float(_CONFIG.get("tokenExpireAt") or 0) > time.time(),
                    "tokenExpireAt": int(_CONFIG.get("tokenExpireAt") or 0),
                    "reportDir": REPORT_DIR,
                    "protocols": [{"id": 2, "name": "HLS"}, {"id": 1, "name": "ezopen"}, {"id": 3, "name": "RTMP"}],
                })
                return
            if path == "/api/token":
                token, expire_at = ensure_token()
                self._ok({"accessToken": token, "expireAt": expire_at})
                return
            if path == "/api/reports":
                items = []
                if os.path.isdir(REPORT_DIR):
                    for name in sorted(os.listdir(REPORT_DIR), reverse=True)[:50]:
                        if name.endswith(".md"):
                            items.append({
                                "name": name,
                                "md": "/reports/" + name,
                                "csv": "/reports/" + name.replace(".md", ".csv"),
                                "json": "/reports/" + name.replace(".md", ".json"),
                            })
                self._ok(items)
                return
            if path == "/api/health":
                self._ok({"status": "ok"})
                return
            self._serve_static(path)
        except ApiError as exc:
            self._err(exc)
        except Exception as exc:
            self._err(ApiError("UNEXPECTED", str(exc), "server"))

    # -- POST -------------------------------------------------------------- #
    def do_POST(self):
        _, path = self._query()
        body = self._body()
        try:
            # ---- 凭证 ----
            if path == "/api/config":
                with _LOCK:
                    old_key = _CONFIG.get("appKey")
                    if "appKey" in body:
                        _CONFIG["appKey"] = str(body.get("appKey") or "").strip()
                    if "appSecret" in body:
                        _CONFIG["appSecret"] = str(body.get("appSecret") or "").strip()
                    if "apiBase" in body:
                        _CONFIG["apiBase"] = str(body.get("apiBase") or "").strip()
                    if _CONFIG.get("appKey") != old_key or "appSecret" in body:
                        _CONFIG["token"] = ""
                        _CONFIG["tokenExpireAt"] = 0
                    save_config()
                # 只修改平台地址、或凭证暂时不可用时，不应把整次保存判为失败
                try:
                    token, expire_at = ensure_token()
                    token_masked = mask(token)
                except ApiError as exc:
                    if exc.code != "NO_CRED":
                        raise
                    token_masked, expire_at = "", 0
                self._ok({
                    "appKeyMasked": mask(_CONFIG.get("appKey", "")),
                    "token": token_masked,
                    "tokenExpireAt": expire_at,
                    "apiBase": api_base(),
                    "tokenVerified": bool(token_masked),
                })
                return

            if path == "/api/config/clear":
                with _LOCK:
                    _CONFIG["token"] = ""
                    _CONFIG["tokenExpireAt"] = 0
                    save_config()
                self._ok({"cleared": True})
                return

            # ---- 业务 ----
            if path == "/api/live":
                info = action_live(
                    str(body.get("serial") or "").strip(),
                    int(body.get("channel") or 1),
                    int(body.get("protocol") or 2),
                    int(body.get("quality") or 2),
                    int(body.get("expireTime") or 7200),
                )
                self._ok(info)
                return

            if path == "/api/devices":
                self._ok(action_devices(int(body.get("pageStart") or 0), int(body.get("pageSize") or 50)))
                return

            if path == "/api/cameras":
                self._ok(action_cameras(str(body.get("serial") or "").strip()))
                return

            if path == "/api/probe":
                self._ok(action_probe(
                    body.get("items") or [],
                    int(body.get("protocol") or 2),
                    int(body.get("quality") or 2),
                ))
                return

            if path == "/api/report/save":
                report = body.get("report") or {}
                if not isinstance(report, dict) or "meta" not in report:
                    raise ApiError("BAD_REPORT", "报告数据格式不正确", "report")
                self._ok(write_report(report))
                return

            if path == "/api/report/preview":
                report = body.get("report") or {}
                if not isinstance(report, dict) or "meta" not in report:
                    raise ApiError("BAD_REPORT", "报告数据格式不正确", "report")
                # 预览只渲染不落盘，避免每次预览都在 reports/ 留下垃圾文件
                self._ok(write_report(report, dry_run=True))
                return

            raise ApiError("NOT_FOUND", "未知接口：%s" % path, "router")
        except ApiError as exc:
            self._err(exc)
        except (ValueError, TypeError) as exc:
            self._err(ApiError("BAD_PARAM", "参数不合法：%s" % exc, "param"))
        except Exception as exc:
            self._err(ApiError("UNEXPECTED", str(exc), "server"))


# --------------------------------------------------------------------------- #
# 启动
# --------------------------------------------------------------------------- #
def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="%s 本地服务" % APP_NAME)
    parser.add_argument("--port", type=int, default=8770, help="监听端口（默认 8770）")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    args = parser.parse_args()

    load_config()
    if not os.path.isfile(CONFIG_PATH):
        save_config()  # 首次运行生成空模板，便于手工填写凭证
    try:
        os.makedirs(REPORT_DIR, exist_ok=True)
    except OSError as exc:
        # 只读介质（U 盘、Program Files）下不阻塞启动，仅报告保存会失败
        sys.stderr.write("[warn] 报告目录不可创建（%s）：%s\n" % (REPORT_DIR, exc))

    port = args.port
    if not port_free(port):
        for candidate in range(port + 1, port + 20):
            if port_free(candidate):
                port = candidate
                break
        else:
            sys.stderr.write("端口 %d~%d 均被占用，请用 --port 指定其他端口\n" % (args.port, args.port + 19))
            return 1

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    url = "http://127.0.0.1:%d/" % port

    print("=" * 62)
    print(" %s v%s" % (APP_NAME, APP_VERSION))
    print(" 服务地址：%s" % url)
    print(" 报告目录：%s" % REPORT_DIR)
    print(" 凭证状态：%s" % ("已配置 AppKey" if (_CONFIG.get("appKey") or "").strip() else "未配置（可在界面内填写）"))
    print(" 停止服务：Ctrl+C")
    print("=" * 62)

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
