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
    # ⚠ 端口被占时不能崩（S-030）。
    #   真机实证：用户访问 http://localhost:8000/ 返回的是 EShare 投屏软件页面，
    #   而 Code 这边早已因 Address already in use 直接退出、且无提示 ——
    #   用户看到的是"别的东西占了这个端口"，完全不知道 Code 根本没起来。
    #   改法：占用则自动 +1 重试，并把实际端口打出来。
    httpd = None
    tried = 0
    while tried < 20:
        try:
            httpd = socketserver.TCPServer(('', port), Handler)
            break
        except OSError as e:
            if getattr(e, 'errno', None) not in (98, 48, 10013):
                raise
            print('端口 %d 已被占用（%s），改用 %d' % (port, e.strerror or e, port + 1))
            port += 1
            tried += 1
    if httpd is None:
        print('连续 20 个端口都被占用，放弃。请用 python3 server.py <端口> 指定。')
        sys.exit(1)
    with httpd:
        print('服务已启动：http://localhost:%d/' % port)
        if port != (int(sys.argv[1]) if len(sys.argv) > 1 else 8000):
            print('注意：实际端口与请求的端口不同，请用上面这个地址。')
        print('根目录：%s' % ROOT)
        print('按 Ctrl+C 停止')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')


if __name__ == '__main__':
    main()
