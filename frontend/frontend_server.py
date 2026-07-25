"""
前端开发服务器

用于在开发阶段直接预览前端页面，支持热重载。
运行方式: python frontend/frontend_server.py
"""
import http.server
import socketserver
import os
import sys

def main():
    # 设置工作目录为 frontend/static 文件夹
    web_dir = os.path.dirname(os.path.abspath(__file__))
    static_dir = os.path.join(web_dir, 'static')
    os.chdir(static_dir)
    
    PORT = 8080
    
    # 创建 HTTP 请求处理器，支持 CORS
    class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            super().end_headers()
        
        def translate_path(self, path):
            # 处理根路径，返回 html/index.html
            if path == '/':
                return os.path.join(os.getcwd(), 'html', 'index.html')
            return super().translate_path(path)
    
    # 设置端口复用
    socketserver.TCPServer.allow_reuse_address = True
    
    try:
        with socketserver.TCPServer(("", PORT), MyHTTPRequestHandler) as httpd:
            print(f"🚀 前端开发服务器启动")
            print(f"📡 访问地址: http://localhost:{PORT}")
            print(f"📁 静态文件目录: {os.path.join(web_dir, 'static')}")
            print(f"⏹️  按 Ctrl+C 停止服务")
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 前端开发服务器已停止")
        sys.exit(0)

if __name__ == "__main__":
    main()