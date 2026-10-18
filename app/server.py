#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""信号实验室 · 本地服务（只用 Python 标准库，不装任何依赖）

它干两件事：

  1. 把 app/ 当静态站点发出去，页面于是有了真正的 http:// 源
  2. 提供 /api/chat，把浏览器的请求转发给上游模型服务

为什么非要第 2 件？
  上游中转站不响应 CORS 预检（OPTIONS 直接回 405）。浏览器从 file:// 打开时
  源是 "null"，带 Authorization 头的 fetch 会先发预检，然后被拒。
  由本机服务转发，这个问题整个消失，顺带让 API Key 不必进浏览器。

  而且本服务对 /api/* 开了 Access-Control-Allow-Origin: *，
  所以就算你直接双击 index.html（file://），只要这个服务在跑，AI 面板照样能用
 ，它会自己去 127.0.0.1 上找。

用法：
    python server.py                     # 默认 8770，被占用就往后找
    python server.py --port 9000
    python server.py --no-browser
    python server.py --verbose           # 打印每个请求

配置（可选）：
    在 em-signal-lab/llm.local.json 里写
        {"baseUrl": "...", "apiKey": "sk-...", "model": "..."}
    该文件已被 .gitignore 排除，不会进公开仓库。
    也可以完全不配，界面上有「接入模型」入口，填了就用你填的。
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:                                    # Windows 控制台默认可能是 GBK
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = Path(__file__).resolve().parent          # .../em-signal-lab/app
ROOT = HERE                                     # 静态根目录
PROJECT = HERE.parent                           # .../em-signal-lab
CONFIG_PATH = PROJECT / 'llm.local.json'        # 故意放在 app/ 外面，绝不可能被静态服务发出去

DEFAULT_CONFIG = {
    'baseUrl': 'http://127.0.0.1:7863/v1',
    'apiKey': '',
    'model': 'cn:deepseek-v4.1-flash',
    'temperature': 0.3,
}

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
}

CONFIG: dict = {}
VERBOSE = False


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            loaded = json.loads(CONFIG_PATH.read_text('utf-8'))
            if isinstance(loaded, dict):
                cfg.update(loaded)
        except Exception as exc:
            print(f'[警告] {CONFIG_PATH.name} 读不出来，用默认配置：{exc}')
    return cfg


def pick_port(start: int, tries: int = 20) -> int:
    """从 start 开始找一个能真正绑上的端口。

    注意这里故意不设 SO_REUSEADDR：Windows 上它会让 bind() 抢走别的进程
    正在监听的端口，看起来成功，实际是把人家的服务顶掉。
    """
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(('127.0.0.1', port))
                return port
            except OSError:
                continue
    raise SystemExit(f'{start}–{start + tries - 1} 全被占用了，换个 --port 吧')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'        # 流式响应靠连接关闭来收尾，简单可靠
    server_version = 'SignalLab/1.0'

    def log_message(self, fmt, *args):
        if VERBOSE:
            sys.stderr.write('  %s\n' % (fmt % args))

    # ------------------------------------------------------------------ 工具

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'authorization,content-type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    def _send_json(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_text(self, status, msg):
        raw = msg.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _read_body(self) -> bytes:
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            n = 0
        return self.rfile.read(n) if n > 0 else b''

    # ------------------------------------------------------------------ 路由

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/health':
            return self._send_json({
                'ok': True,
                'service': 'signal-lab',
                'baseUrl': CONFIG.get('baseUrl'),
                'model': CONFIG.get('model'),
                'hasKey': bool(CONFIG.get('apiKey')),
                'configFile': CONFIG_PATH.name if CONFIG_PATH.exists() else None,
            })
        if path == '/api/config':
            # 故意不回 apiKey：密钥留在本机，不进浏览器
            return self._send_json({
                'baseUrl': CONFIG.get('baseUrl'),
                'model': CONFIG.get('model'),
                'hasKey': bool(CONFIG.get('apiKey')),
                'temperature': CONFIG.get('temperature'),
            })
        return self._serve_static(path)

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/chat':
            return self._proxy_chat()
        return self._send_json({'error': '没有这个接口：' + path}, 404)

    # ------------------------------------------------------------------ 静态

    def _serve_static(self, path):
        rel = urllib.parse.unquote(path)
        if rel in ('', '/'):
            rel = '/index.html'

        parts = [p for p in rel.split('/') if p not in ('', '.')]
        if any(p == '..' or p.startswith('.') or p.endswith('.local.json') for p in parts):
            return self._send_text(403, '不提供这个文件')

        target = (ROOT / Path(*parts)).resolve()
        try:
            target.relative_to(ROOT.resolve())
        except ValueError:
            return self._send_text(403, '路径越界了')

        if not target.is_file():
            return self._send_text(404, '没有这个文件：' + rel)

        try:
            raw = target.read_bytes()
        except OSError as exc:
            return self._send_text(500, '读不出来：%s' % exc)

        self.send_response(200)
        self.send_header('Content-Type', MIME.get(target.suffix.lower(), 'application/octet-stream'))
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ------------------------------------------------------------------ 转发

    def _proxy_chat(self):
        try:
            payload = json.loads(self._read_body().decode('utf-8'))
        except Exception:
            return self._send_json({'error': '请求体不是合法 JSON'}, 400)

        cfg = dict(CONFIG)
        # 浏览器上填的配置优先于本机文件，这样别人 clone 下来也能用
        for key in ('apiKey', 'baseUrl', 'model'):
            if payload.get(key):
                cfg[key] = payload[key]

        if not cfg.get('apiKey'):
            return self._send_json({
                'error': '没有可用的 API Key',
                'hint': '点界面右上角「接入模型」填一个，或写进 em-signal-lab/llm.local.json',
            }, 400)

        stream = bool(payload.get('stream'))
        body = {
            'model': cfg['model'],
            'messages': payload.get('messages') or [],
            'stream': stream,
        }
        if payload.get('temperature') is not None:
            body['temperature'] = payload['temperature']
        if payload.get('max_tokens'):
            body['max_tokens'] = payload['max_tokens']

        url = str(cfg['baseUrl']).rstrip('/') + '/chat/completions'
        req = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + str(cfg['apiKey']),
                'Accept': 'text/event-stream' if stream else 'application/json',
            },
            method='POST',
        )

        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', 'replace')[:800]
            return self._send_json({'error': f'上游返回 HTTP {exc.code}', 'detail': detail}, 502)
        except Exception as exc:
            return self._send_json({
                'error': f'连不上上游：{exc}',
                'hint': f'确认 {url} 是通的',
            }, 502)

        ctype = resp.headers.get('Content-Type') or (
            'text/event-stream; charset=utf-8' if stream else 'application/json; charset=utf-8')
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self._cors()
        self.end_headers()

        try:
            if stream:
                for line in resp:               # SSE 一行一行来，来一行转一行
                    self.wfile.write(line)
                    self.wfile.flush()
            else:
                self.wfile.write(resp.read())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass                                # 用户把页面关了，正常
        finally:
            resp.close()


class Server(ThreadingHTTPServer):
    allow_reuse_address = False                 # 见 pick_port 的注释
    daemon_threads = True


def main():
    global CONFIG, VERBOSE

    ap = argparse.ArgumentParser(description='信号实验室 · 本地服务')
    ap.add_argument('--port', type=int, default=8770, help='起始端口（默认 8770）')
    ap.add_argument('--no-browser', action='store_true', help='不要自动打开浏览器')
    ap.add_argument('--verbose', action='store_true', help='打印每个请求')
    args = ap.parse_args()

    VERBOSE = args.verbose
    CONFIG = load_config()

    port = pick_port(args.port)
    httpd = Server(('127.0.0.1', port), Handler)
    url = f'http://127.0.0.1:{port}/'

    print('')
    print('  信号实验室 · Signal Lab')
    print('  ' + '-' * 46)
    print(f'  地址      {url}')
    print(f'  模型      {CONFIG.get("model")}')
    print(f'  上游      {CONFIG.get("baseUrl")}')
    print(f'  API Key   {"已配置（来自 " + CONFIG_PATH.name + "）" if CONFIG.get("apiKey") else "未配置，可在界面右上角「接入模型」里填"}')
    print('  ' + '-' * 46)
    print('  Ctrl+C 停止')
    print('')

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  [停止] 服务已关闭')
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
