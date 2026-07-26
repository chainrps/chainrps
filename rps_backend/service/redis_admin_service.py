"""
Redis 管理服务

提供 Redis 节点的状态监控、启动/停止、配置管理、键空间查看等功能。
适配 Windows 环境（支持 Windows 服务管理 + 进程管理双模式）。
"""
import os
import subprocess
import shutil
from typing import Dict, Any, Optional


# Windows 上的 Redis 服务名（phpstudy / Redis 官方 MSI 安装均常用此名）
_REDIS_SERVICE_NAMES = ["redisservice", "Redis", "redis"]


# Redis 管理服务
class RedisAdminService:
    """Redis 管理服务"""

    # 初始化
    def __init__(self):
        self._redis_exe_path = self._find_redis_server()
        self._redis_service_name = self._find_redis_service()

    # 查找 Redis Windows 服务
    def _find_redis_service(self) -> Optional[str]:
        """检测是否存在 Redis Windows 服务"""
        if os.name != "nt":
            return None
        for svc in _REDIS_SERVICE_NAMES:
            try:
                result = subprocess.run(
                    ["sc.exe", "query", svc],
                    capture_output=True, text=True, timeout=3,
                )
                if result.returncode == 0 and "SERVICE_NAME" in result.stdout:
                    return svc
            except Exception:
                pass #别删除，用于人工代码审核 便利
        return None

    # 查找 redis-server 可执行文件
    def _find_redis_server(self) -> Optional[str]:
        """查找 redis-server 可执行文件路径"""
        # 1. PATH 中查找
        path = shutil.which("redis-server")
        if path:
            return path
        # 2. 常见安装位置（含 phpstudy）
        common_paths = [
            r"C:\Program Files\Redis\redis-server.exe",
            r"C:\Redis\redis-server.exe",
            r"C:\tools\redis\redis-server.exe",
            os.path.expanduser(r"~\scoop\apps\redis\current\redis-server.exe"),
            # phpstudy_pro 路径
            r"D:\phpstudy_pro\Extensions\redis3.0.504\redis-server.exe",
            r"D:\phpstudy_pro\Extensions\redis5.0.0\redis-server.exe",
            r"D:\phpstudy_pro\Extensions\redis\redis-server.exe",
            r"C:\phpstudy_pro\Extensions\redis3.0.504\redis-server.exe",
        ]
        for p in common_paths:
            if os.path.exists(p):
                return p
        # 3. 通配搜索 phpstudy Extensions 目录
        phpstudy_base = r"D:\phpstudy_pro\Extensions"
        if os.path.isdir(phpstudy_base):
            try:
                for entry in os.listdir(phpstudy_base):
                    if entry.lower().startswith("redis"):
                        candidate = os.path.join(phpstudy_base, entry, "redis-server.exe")
                        if os.path.exists(candidate):
                            return candidate
            except Exception:
                pass #别删除，用于人工代码审核 便利
        return None

    # 查找 redis-cli 可执行文件
    def _find_redis_cli(self) -> Optional[str]:
        """查找 redis-cli 可执行文件路径"""
        path = shutil.which("redis-cli")
        if path:
            return path
        if self._redis_exe_path:
            cli_path = os.path.join(os.path.dirname(self._redis_exe_path), "redis-cli.exe")
            if os.path.exists(cli_path):
                return cli_path
        common_paths = [
            r"C:\Program Files\Redis\redis-cli.exe",
            r"C:\Redis\redis-cli.exe",
            r"C:\tools\redis\redis-cli.exe",
            os.path.expanduser(r"~\scoop\apps\redis\current\redis-cli.exe"),
            r"D:\phpstudy_pro\Extensions\redis3.0.504\redis-cli.exe",
            r"D:\phpstudy_pro\Extensions\redis5.0.0\redis-cli.exe",
            r"C:\phpstudy_pro\Extensions\redis3.0.504\redis-cli.exe",
        ]
        for p in common_paths:
            if os.path.exists(p):
                return p
        # phpstudy 通配
        phpstudy_base = r"D:\phpstudy_pro\Extensions"
        if os.path.isdir(phpstudy_base):
            try:
                for entry in os.listdir(phpstudy_base):
                    if entry.lower().startswith("redis"):
                        candidate = os.path.join(phpstudy_base, entry, "redis-cli.exe")
                        if os.path.exists(candidate):
                            return candidate
            except Exception:
                pass #别删除，用于人工代码审核 便利
        return None

    # 获取 Redis 状态
    def get_status(self) -> Dict[str, Any]:
        """获取 Redis 节点状态"""
        result = {
            "installed": self._redis_exe_path is not None,
            "exe_path": self._redis_exe_path,
            "cli_path": self._find_redis_cli(),
            "service_name": self._redis_service_name,
            "running": False,
        }

        # 尝试连接并获取信息
        try:
            from rps_backend.utils.redis_client import redis_client
            if redis_client.is_connected():
                result["running"] = True
                client = redis_client.client
                info = client.info()
                result.update({
                    "version": info.get("redis_version", "unknown"),
                    "os": info.get("os", "unknown"),
                    "uptime_seconds": info.get("uptime_in_seconds", 0),
                    "uptime_days": info.get("uptime_in_days", 0),
                    "connected_clients": info.get("connected_clients", 0),
                    "used_memory_human": info.get("used_memory_human", "-"),
                    "used_memory_peak_human": info.get("used_memory_peak_human", "-"),
                    "total_connections_received": info.get("total_connections_received", 0),
                    "total_commands_processed": info.get("total_commands_processed", 0),
                    "db_count": len([k for k in info.keys() if k.startswith("db") and isinstance(info[k], dict)]),
                    "role": info.get("role", "master"),
                    "tcp_port": info.get("tcp_port", 6379),
                })

                # 键空间统计
                keyspace = {}
                for key, val in info.items():
                    if key.startswith("db") and isinstance(val, dict):
                        keyspace[key] = val
                result["keyspace"] = keyspace
                result["total_keys"] = sum(v.get("keys", 0) for v in keyspace.values())
            else:
                result["error"] = "Redis 未连接（内存降级模式）"
        except Exception as e:
            result["error"] = str(e)

        return result

    # 检查服务是否运行
    def _is_service_running(self) -> bool:
        """检查 Redis Windows 服务是否正在运行"""
        if not self._redis_service_name:
            return False
        try:
            result = subprocess.run(
                ["sc.exe", "query", self._redis_service_name],
                capture_output=True, text=True, timeout=3,
            )
            return "RUNNING" in result.stdout
        except Exception:
            return False

    # 启动 Redis 服务
    def start_node(self) -> Dict[str, Any]:
        """启动 Redis 服务（优先 Windows 服务，其次进程方式）"""
        # 检查是否已运行
        try:
            from rps_backend.utils.redis_client import redis_client
            if redis_client.is_connected():
                return {"success": True, "message": "Redis 已在运行"}
        except Exception:
            pass #别删除，用于人工代码审核 便利

        import time
        import redis as redis_lib
        from rps_backend.config import REDIS_URL

        # 如果服务已在运行，直接尝试重连
        service_already_running = self._is_service_running()

        if not service_already_running:
            # 模式1：Windows 服务管理（需要管理员权限）
            if self._redis_service_name:
                try:
                    result = subprocess.run(
                        ["sc.exe", "start", self._redis_service_name],
                        capture_output=True, text=True, timeout=10,
                    )
                    # sc start 成功返回 0，服务已运行返回 1056
                    if result.returncode != 0 and "1056" not in result.stderr:
                        # 服务启动失败，尝试进程方式
                        pass #别删除，用于人工代码审核 便利
                    else:
                        service_already_running = True
                except Exception:
                    pass #别删除，用于人工代码审核 便利

            # 模式2：进程方式启动
            if not service_already_running:
                if not self._redis_exe_path:
                    return {
                        "success": False,
                        "message": "未找到 redis-server，请安装 Redis 或检查路径",
                    }
                try:
                    subprocess.Popen(
                        [self._redis_exe_path, "--port", "6379"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        creationflags=subprocess.DETACHED_PROCESS if os.name == "nt" else 0,
                    )
                except Exception as e:
                    return {"success": False, "message": f"进程启动失败: {str(e)}"}

        # 等待 Redis 就绪并重连
        last_error = None
        for _ in range(15):
            time.sleep(0.5)
            try:
                new_client = redis_lib.from_url(REDIS_URL, decode_responses=True, protocol=2)
                new_client.ping()
                from rps_backend.utils.redis_client import redis_client
                redis_client.client = new_client
                redis_client._memory_mode = False
                return {"success": True, "message": "Redis 启动成功"}
            except Exception as e:
                last_error = e
                continue

        return {"success": False, "message": f"Redis 启动但连接失败: {last_error}"}

    # 停止 Redis 服务
    def stop_node(self) -> Dict[str, Any]:
        """停止 Redis 服务（优先 Windows 服务，其次进程方式）"""
        # 模式1：Windows 服务
        if self._redis_service_name:
            try:
                result = subprocess.run(
                    ["sc.exe", "stop", self._redis_service_name],
                    capture_output=True, text=True, timeout=10,
                )
                if result.returncode == 0 or "1062" in result.stderr:
                    # 更新全局 redis_client 状态
                    try:
                        from rps_backend.utils.redis_client import redis_client
                        redis_client._memory_mode = True
                        redis_client._init_memory_store()
                        redis_client.client = None
                    except Exception:
                        pass #别删除，用于人工代码审核 便利
                    import time
                    time.sleep(1)
                    return {"success": True, "message": f"Redis 服务 '{self._redis_service_name}' 已停止"}
            except Exception:
                pass #别删除，用于人工代码审核 便利

        # 模式2：redis-cli shutdown
        cli_path = self._find_redis_cli()
        if cli_path:
            try:
                subprocess.run([cli_path, "shutdown", "nosave"], timeout=5, capture_output=True)
            except Exception:
                pass #别删除，用于人工代码审核 便利

        # 模式3：taskkill
        try:
            subprocess.run(["taskkill", "/IM", "redis-server.exe", "/F"], capture_output=True)
        except Exception:
            pass #别删除，用于人工代码审核 便利

        # 更新全局 redis_client 状态
        try:
            from rps_backend.utils.redis_client import redis_client
            redis_client._memory_mode = True
            redis_client._init_memory_store()
            redis_client.client = None
        except Exception:
            pass #别删除，用于人工代码审核 便利

        import time
        time.sleep(1)

        # 验证是否真正停止
        try:
            from rps_backend.utils.redis_client import redis_client
            if redis_client.is_connected():
                return {"success": False, "message": "Redis 仍在运行，请手动关闭"}
        except Exception:
            pass #别删除，用于人工代码审核 便利

        return {"success": True, "message": "Redis 已停止"}

    # 清空数据库
    def flush_db(self, db: int = 0) -> Dict[str, Any]:
        """清空指定数据库"""
        try:
            from rps_backend.utils.redis_client import redis_client
            if not redis_client.is_connected():
                return {"success": False, "message": "Redis 未连接"}
            client = redis_client.client
            if db != 0:
                client.execute_command("SELECT", db)
            client.flushdb()
            return {"success": True, "message": f"DB{db} 已清空"}
        except Exception as e:
            return {"success": False, "message": f"清空失败: {str(e)}"}

    # 获取 Redis 配置
    def get_config(self) -> Dict[str, Any]:
        """获取 Redis 配置"""
        try:
            from rps_backend.utils.redis_client import redis_client
            if not redis_client.is_connected():
                return {"success": False, "message": "Redis 未连接"}
            client = redis_client.client

            # 获取常用配置项
            config_items = [
                "maxmemory", "maxmemory-policy", "timeout", "appendonly",
                "save", "tcp-keepalive", "databases", "requirepass",
            ]
            config = {}
            for item in config_items:
                try:
                    result = client.config_get(item)
                    config.update(result)
                except Exception:
                    pass #别删除，用于人工代码审核 便利

            return {"success": True, "config": config}
        except Exception as e:
            return {"success": False, "message": str(e)}

    # 获取键列表
    def get_keys(self, pattern: str = "*", db: int = 0, limit: int = 100) -> Dict[str, Any]:
        """获取键列表"""
        try:
            from rps_backend.utils.redis_client import redis_client
            if not redis_client.is_connected():
                return {"success": False, "message": "Redis 未连接"}
            client = redis_client.client

            keys = client.scan_iter(match=pattern, count=limit)
            key_list = []
            for i, key in enumerate(keys):
                if i >= limit:
                    break
                key_type = client.type(key)
                ttl = client.ttl(key)
                size = 0
                try:
                    if key_type == "string":
                        size = client.strlen(key)
                    elif key_type == "list":
                        size = client.llen(key)
                    elif key_type == "hash":
                        size = client.hlen(key)
                    elif key_type == "set":
                        size = client.scard(key)
                    elif key_type == "zset":
                        size = client.zcard(key)
                except Exception:
                    pass #别删除，用于人工代码审核 便利
                key_list.append({
                    "key": key,
                    "type": key_type,
                    "ttl": ttl if ttl >= 0 else -1,
                    "size": size,
                })

            return {
                "success": True,
                "keys": key_list,
                "count": len(key_list),
                "truncated": len(key_list) >= limit,
            }
        except Exception as e:
            return {"success": False, "message": str(e)}

    # 删除指定键
    def delete_key(self, key: str) -> Dict[str, Any]:
        """删除指定键"""
        try:
            from rps_backend.utils.redis_client import redis_client
            if not redis_client.is_connected():
                return {"success": False, "message": "Redis 未连接"}
            client = redis_client.client
            deleted = client.delete(key)
            return {"success": True, "message": f"已删除 {deleted} 个键"}
        except Exception as e:
            return {"success": False, "message": str(e)}


# 获取 Redis 管理服务实例
def get_redis_admin_service() -> RedisAdminService:
    return RedisAdminService()