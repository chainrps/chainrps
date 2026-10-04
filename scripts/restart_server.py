"""
服务重启脚本 —— 由后端 /api/admin/server/restart 触发

工作流程：
1. 等待当前 uvicorn 进程（PID 由参数传入）自然退出
2. 进程退出后，重新启动 uvicorn 服务
3. 本脚本以 detached 方式运行，不随主进程退出

使用方式（由后端自动调用）：
    python restart_server.py <old_pid> <project_root> <python_exe> [host] [port]
"""
import os
import sys
import time
import subprocess
import signal


def is_pid_alive(pid: int) -> bool:
    """检查 PID 是否存在"""
    try:
        if os.name == "nt":
            # Windows: 用 tasklist 检查
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True, text=True, timeout=5
            )
            return str(pid) in result.stdout
        else:
            # Unix: 发送信号 0 测试
            os.kill(pid, 0)
            return True
    except (ProcessLookupError, PermissionError, OSError):
        return False
    except Exception:
        return False


def wait_for_pid_exit(pid: int, timeout: int = 30) -> bool:
    """等待指定 PID 退出，超时返回 False"""
    elapsed = 0
    while elapsed < timeout:
        if not is_pid_alive(pid):
            return True
        time.sleep(0.5)
        elapsed += 0.5
    return not is_pid_alive(pid)


def restart_server(pid: int, project_root: str, python_exe: str, host: str = "0.0.0.0", port: int = 8000):
    """等待旧进程退出后重启服务"""
    print(f"[Restart] 等待旧进程 PID={pid} 退出...")

    # 等待旧进程退出（最多 30 秒）
    exited = wait_for_pid_exit(pid, timeout=30)
    if not exited:
        print(f"[Restart] ⚠️ 旧进程未在 30 秒内退出，尝试强制终止...")
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                               capture_output=True, timeout=5)
            else:
                os.kill(pid, signal.SIGKILL)
            time.sleep(2)
        except Exception as e:
            print(f"[Restart] 强制终止失败: {e}")

    print(f"[Restart] 旧进程已退出，等待 2 秒后重启...")
    time.sleep(2)

    # 重启 uvicorn
    try:
        # 恢复工作目录
        os.chdir(project_root)

        # 启动新的 uvicorn 进程（新的进程组）
        creationflags = 0
        if os.name == "nt":
            creationflags = (
                subprocess.CREATE_NEW_PROCESS_GROUP
                | subprocess.DETACHED_PROCESS
            )

        new_proc = subprocess.Popen(
            [
                python_exe, "-m", "uvicorn",
                "rps_backend.main:app",
                "--host", host,
                "--port", str(port),
            ],
            cwd=project_root,
            creationflags=creationflags,
            stdout=subprocess.DEVNULL if os.name == "nt" else None,
            stderr=subprocess.DEVNULL if os.name == "nt" else None,
        )

        print(f"[Restart] ✅ 新服务已启动 (host={host}, port={port}), PID={new_proc.pid}")
    except Exception as e:
        print(f"[Restart] ❌ 启动服务失败: {e}")
        # 也可以尝试用 main.py 启动
        try:
            print("[Restart] 尝试通过 main.py 启动...")
            main_py = os.path.join(project_root, "main.py")
            if os.path.exists(main_py):
                subprocess.Popen(
                    [python_exe, main_py],
                    cwd=project_root,
                    creationflags=creationflags if os.name == "nt" else 0,
                )
                print("[Restart] ✅ main.py 方式启动已触发")
        except Exception as e2:
            print(f"[Restart] ❌ main.py 也启动失败: {e2}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python restart_server.py <old_pid> <project_root> <python_exe> [host] [port]")
        sys.exit(1)

    old_pid = int(sys.argv[1])
    project_root = sys.argv[2]
    python_exe = sys.argv[3]
    host = sys.argv[4] if len(sys.argv) > 4 else "0.0.0.0"
    port = int(sys.argv[5]) if len(sys.argv) > 5 else 8000

    restart_server(old_pid, project_root, python_exe, host, port)
