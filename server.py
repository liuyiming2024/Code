#!/usr/bin/env python3
"""本地静态服务。

为什么需要它：用 file:// 双击打开时，浏览器会以"来源为空"处理，
从而拒绝创建 Worker —— 按需下载的那几种语言（SQLite / Python / PHP…）
会直接跑不起来。起个本地服务就有了正常的 http:// 来源。

用法：
    python3 server.py            # 默认 8000 端口
    python3 server.py 8080       # 指定端口
然后浏览器打开 http://localhost:8000/

只做静态托管，不代理、不上传、不写日志。
"""
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        # Worker 与 WASM 相关的现代特性在部分浏览器下需要安全上下文；
        # localhost 本身算安全上下文，这里只是禁用缓存方便调试。
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', port), Handler) as httpd:
        print('服务已启动：http://localhost:%d/' % port)
        print('根目录：%s' % ROOT)
        print('按 Ctrl+C 停止')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')


if __name__ == '__main__':
    main()
