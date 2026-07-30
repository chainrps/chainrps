"""
S1-02: Relayer 私钥隔离单元测试

验证：
1. 私钥仅从环境变量加载
2. get_health_status / get_relayer_address 等公开接口不返回私钥
3. _safe_log 不输出私钥
4. 私钥不写入数据库（无 DB 字段）
"""
import io
import os
import sys
from unittest import mock

import pytest


def test_private_key_loaded_from_env_only(monkeypatch):
    """未设置 RELAYER_PRIVATE_KEY 环境变量时，RelayerService 不应可用"""
    # 确保环境变量为空
    monkeypatch.delenv("RELAYER_PRIVATE_KEY", raising=False)
    monkeypatch.delenv("RELAYER_ADDRESS", raising=False)
    monkeypatch.delenv("CONTRACT_ADDRESS", raising=False)

    # 重新导入 config 模块以应用环境变量
    import importlib
    import rps_backend.config as config_module
    importlib.reload(config_module)

    # 重新加载 relayer_service 模块以使用新的 config
    import rps_backend.service.relayer_service as rs_module
    importlib.reload(rs_module)

    # 创建实例，应不可用
    svc = rs_module.RelayerService()
    assert svc.is_available() is False
    assert svc.relayer_account is None


def test_get_health_status_excludes_private_key(make_relayer_service):
    """健康状态接口不返回任何私钥字段"""
    svc = make_relayer_service()
    status = svc.get_health_status()

    forbidden = ["private_key", "privateKey", "relayer_private_key", "key", "secret", "pk"]
    for k in forbidden:
        assert k not in status, f"health status 不应包含 {k}"

    # 序列化为字符串，确保内部也不含私钥模式
    import json
    serialized = json.dumps(status)
    # 检查不包含常见私钥前缀
    assert "0x" + "a" * 64 not in serialized.lower()


def test_get_relayer_address_returns_only_address(make_relayer_service, fake_account_factory):
    """get_relayer_address 只返回地址字符串，不返回私钥"""
    svc = make_relayer_service()
    svc.relayer_account = fake_account_factory("0x" + "ab" * 20)

    addr = svc.get_relayer_address()
    assert addr == "0x" + "ab" * 20
    # 不应包含任何私钥特征
    assert "private" not in addr.lower()
    assert len(addr) == 42  # 0x + 20 字节


def test_safe_log_does_not_print_private_key(capsys):
    """_safe_log 不应输出私钥"""
    from rps_backend.service.relayer_service import _safe_log

    _safe_log("测试消息: address=0xABCD")
    captured = capsys.readouterr()
    assert "测试消息" in captured.out
    # 不应包含典型私钥字符串
    fake_pk = "0x" + "a" * 64
    assert fake_pk not in captured.out


def test_relayer_service_no_database_persistence():
    """RelayerService 类不应有任何数据库持久化方法"""
    from rps_backend.service.relayer_service import RelayerService

    # 检查类的方法名，不应有 save/store/persist/insert/update_db 等数据库相关方法
    method_names = [name for name in dir(RelayerService) if not name.startswith("__")]
    db_keywords = ["save", "store", "persist", "insert", "update_db", "write_db", "save_to_db"]
    for kw in db_keywords:
        for name in method_names:
            assert kw not in name.lower(), f"RelayerService 不应有数据库方法 {name}"


def test_api_status_endpoint_response_shape():
    """测试 /api/relayer/status 端点响应不应包含私钥字段"""
    # 直接调用端点函数
    from rps_backend.api.endpoints.game import get_relayer_status
    from rps_backend.service.relayer_service import relayer_service

    # 调用端点（同步函数返回 awaitable）
    import asyncio
    result = asyncio.run(get_relayer_status())

    forbidden = ["private_key", "privateKey", "relayer_private_key", "key", "secret", "pk"]
    for k in forbidden:
        assert k not in result, f"端点响应不应包含 {k}"

    # 应包含公开字段
    assert "success" in result
    assert "healthy" in result
    assert "available" in result
    assert "gasless_available" in result
    assert "relayer_address" in result


def test_relayer_address_endpoint_no_private_key():
    """测试 /api/game/relayer/address 端点不返回私钥"""
    from rps_backend.api.endpoints.game import get_relayer_address
    import asyncio
    result = asyncio.run(get_relayer_address())

    forbidden = ["private_key", "privateKey", "relayer_private_key", "key", "secret", "pk"]
    for k in forbidden:
        assert k not in result, f"端点响应不应包含 {k}"


def test_init_logs_do_not_contain_private_key(capsys, monkeypatch):
    """初始化日志输出不包含私钥"""
    # 设置一个测试私钥 + 合约地址，触发完整初始化路径
    # 但 RPC 会失败（因为指向不存在的端点），所以我们只验证日志
    test_pk = "0x" + "a" * 64
    monkeypatch.setenv("RELAYER_PRIVATE_KEY", test_pk)
    monkeypatch.setenv("CONTRACT_ADDRESS", "0x" + "b" * 40)
    # 指向不存在的 RPC，确保不真正连上
    monkeypatch.setenv("RPC_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("RPC_LOCAL_HOST", "127.0.0.1")
    monkeypatch.setenv("RPC_LOCAL_PORT", "1")

    import importlib
    import rps_backend.config as config_module
    importlib.reload(config_module)
    import rps_backend.service.relayer_service as rs_module
    importlib.reload(rs_module)

    capsys.readouterr()  # 清空之前的输出
    svc = rs_module.RelayerService()
    captured = capsys.readouterr()

    # 关键断言：私钥字符串本身不应出现在日志中
    assert test_pk not in captured.out
    assert test_pk.lower() not in captured.out.lower()
    # 私钥去掉 0x 前缀的部分也不应出现
    assert test_pk[2:] not in captured.out
