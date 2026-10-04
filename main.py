"""
ChainRPS 后端服务入口（根目录启动）
"""
import sys
import os

# 将项目根目录添加到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rps_backend.main import main

if __name__ == "__main__":
    main()