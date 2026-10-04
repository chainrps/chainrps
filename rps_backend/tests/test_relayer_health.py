"""
F1-05: Relayer 健康检测单元测试

测试场景：
1. RPC 不可达 -> healthy=False，触发 WS 降级通知
2. 余额不足 -> healthy=False，触发 WS 降级通知
3. nonce 不同步 -> healthy=False
4. 全部正常 -> healthy=True，触发 WS 恢复通知
5. relayer 未初始化 -> healthy=False
6. 健康状态未翻转时不广播
"""
import asyncio
import pytest

from rps_backend.tests.conftest import FakeAccount, FakeEth, FakeWeb3


@pytest.mark.asyncio
async def test_health_check_uninitialized_relayer(make_relayer_service):
    """未初始化的 relayer 应标记为不健康"""
    svc = make_relayer_service()  # w3/contract/account 全是 None
    status = await svc.check_health()
    assert status["healthy"] is False
    assert status["error"] == "Relayer 未初始化"
    assert svc.get_health_status()["available"] is False


@pytest.mark.asyncio
async def test_health_check_rpc_unreachable(make_relayer_service, monkeypatch):
    """RPC 不可达时 healthy=False，并通过 WS 广播降级通知"""
    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=False))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)
    # 模拟健康状态从健康变为不健康
    svc._health_status["healthy"] = True

    broadcast_calls = []

    async def _fake_broadcast(message):
        broadcast_calls.append(message)

    # mock ws_manager.broadcast
    import sys
    from rps_backend.websocket import manager as ws_manager_module
    monkeypatch.setattr(ws_manager_module.ws_manager, "broadcast", _fake_broadcast)

    status = await svc.check_health()
    assert status["healthy"] is False
    assert status["rpc_reachable"] is False
    assert "RPC 不可达" in status["error"]

    # 验证广播了降级通知
    assert len(broadcast_calls) == 1
    msg = broadcast_calls[0]
    assert msg.type == "relayer_status_changed"
    assert msg.data["gasless_available"] is False
    assert "降级" in msg.data["message"]


@pytest.mark.asyncio
async def test_health_check_balance_insufficient(make_relayer_service, monkeypatch):
    """余额不足时 healthy=False"""
    from rps_backend.service import relayer_service as rs_module
    # 用一个低于阈值的余额
    low_balance = rs_module.MIN_RELAYER_BALANCE_WEI - 1

    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True, balance=low_balance))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    broadcast_calls = []

    async def _fake_broadcast(message):
        broadcast_calls.append(message)

    from rps_backend.websocket import manager as ws_manager_module
    monkeypatch.setattr(ws_manager_module.ws_manager, "broadcast", _fake_broadcast)

    status = await svc.check_health()
    assert status["healthy"] is False
    assert status["rpc_reachable"] is True
    assert status["balance_sufficient"] is False
    assert "余额不足" in status["error"]
    # 状态翻转：初始 healthy=False，检测结果 healthy=False，无翻转，不广播
    assert len(broadcast_calls) == 0

    # 再测一次状态翻转场景：先把状态置为 healthy=True，再检测应广播降级
    svc._health_status["healthy"] = True
    await svc.check_health()
    assert len(broadcast_calls) == 1
    assert broadcast_calls[0].data["gasless_available"] is False


@pytest.mark.asyncio
async def test_health_check_nonce_out_of_sync(make_relayer_service, monkeypatch):
    """本地 nonce 落后于链上 nonce 时 healthy=False"""
    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True, balance=10 ** 18, chain_nonce=10))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)
    # 本地 nonce 落后
    svc._local_nonce = 5

    broadcast_calls = []

    async def _fake_broadcast(message):
        broadcast_calls.append(message)

    from rps_backend.websocket import manager as ws_manager_module
    monkeypatch.setattr(ws_manager_module.ws_manager, "broadcast", _fake_broadcast)

    status = await svc.check_health()
    assert status["healthy"] is False
    assert status["nonce_synced"] is False
    assert "Nonce 不同步" in status["error"]
    assert status["local_nonce"] == 5
    assert status["chain_nonce"] == 10


@pytest.mark.asyncio
async def test_health_check_all_good(make_relayer_service, monkeypatch):
    """全部正常时 healthy=True，并广播恢复通知"""
    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True, balance=10 ** 18, chain_nonce=0))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)
    # 初始为不健康，检测后应翻转为健康并广播
    svc._health_status["healthy"] = False

    broadcast_calls = []

    async def _fake_broadcast(message):
        broadcast_calls.append(message)

    from rps_backend.websocket import manager as ws_manager_module
    monkeypatch.setattr(ws_manager_module.ws_manager, "broadcast", _fake_broadcast)

    status = await svc.check_health()
    assert status["healthy"] is True
    assert status["rpc_reachable"] is True
    assert status["balance_sufficient"] is True
    assert status["nonce_synced"] is True
    assert status["error"] is None

    # 翻转：不健康 -> 健康，应广播恢复通知
    assert len(broadcast_calls) == 1
    assert broadcast_calls[0].data["gasless_available"] is True
    assert "恢复" in broadcast_calls[0].data["message"]


@pytest.mark.asyncio
async def test_health_check_no_broadcast_when_state_unchanged(make_relayer_service, monkeypatch):
    """健康状态未翻转时不广播"""
    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True, balance=10 ** 18, chain_nonce=0))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)
    # 初始不健康
    svc._health_status["healthy"] = False

    broadcast_calls = []

    async def _fake_broadcast(message):
        broadcast_calls.append(message)

    from rps_backend.websocket import manager as ws_manager_module
    monkeypatch.setattr(ws_manager_module.ws_manager, "broadcast", _fake_broadcast)

    # 第一次检测：不健康 -> 健康，广播一次
    await svc.check_health()
    assert len(broadcast_calls) == 1

    # 第二次检测：仍健康，不广播
    await svc.check_health()
    assert len(broadcast_calls) == 1


@pytest.mark.asyncio
async def test_health_check_balance_query_exception(make_relayer_service, monkeypatch):
    """余额查询抛异常时 healthy=False"""
    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(
        connected=True,
        raise_on_balance=Exception("RPC timeout"),
    ))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    status = await svc.check_health()
    assert status["healthy"] is False
    assert "余额查询失败" in status["error"]


@pytest.mark.asyncio
async def test_health_check_nonce_query_exception(make_relayer_service, monkeypatch):
    """nonce 查询抛异常时 healthy=False"""
    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(
        connected=True,
        balance=10 ** 18,
        raise_on_nonce=Exception("nonce RPC error"),
    ))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    status = await svc.check_health()
    assert status["healthy"] is False
    assert "nonce 查询失败" in status["error"]


@pytest.mark.asyncio
async def test_get_health_status_no_sensitive_data(make_relayer_service):
    """get_health_status 返回的字典中不应包含任何私钥相关字段"""
    svc = make_relayer_service()
    status = svc.get_health_status()
    # 确保没有私钥字段
    for forbidden_key in ("private_key", "relayer_private_key", "key", "secret"):
        assert forbidden_key not in status
    # 应包含公开字段
    assert "healthy" in status
    assert "rpc_reachable" in status
    assert "balance_wei" in status
