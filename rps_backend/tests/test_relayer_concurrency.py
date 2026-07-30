"""
P1-01 / P1-02: Relayer 并发队列与 Stuck 交易重发单元测试

测试场景：
1. 同一玩家的交易按入队顺序串行执行
2. 不同玩家的交易可并行执行
3. 服务不可用时直接返回失败，不进队列
4. Stuck 交易超时后会 bump gas 重发
5. Stuck 交易已被确认的不重发
6. Stuck 重发次数达上限后放弃
"""
import asyncio
import time
import pytest

from rps_backend.tests.conftest import FakeAccount, FakeEth, FakeWeb3


@pytest.mark.asyncio
async def test_same_player_transactions_serialized(make_relayer_service):
    """同一玩家的多个交易必须按入队顺序串行执行"""
    svc = make_relayer_service()
    svc._available = True

    execution_order = []

    async def make_task(label: str, delay: float = 0.05):
        async def _coro():
            execution_order.append(f"{label}-start")
            await asyncio.sleep(delay)
            execution_order.append(f"{label}-end")
            return {"success": True, "label": label}
        return _coro

    player = "0xPlayerA"
    # 投递 3 个任务到同一玩家队列
    tasks = [
        svc._enqueue_and_wait(player, await make_task("t1")),
        svc._enqueue_and_wait(player, await make_task("t2")),
        svc._enqueue_and_wait(player, await make_task("t3")),
    ]
    results = await asyncio.gather(*tasks)

    assert [r["label"] for r in results] == ["t1", "t2", "t3"]
    # 严格串行：每个任务的 start 和 end 都成对出现，无交错
    assert execution_order == [
        "t1-start", "t1-end",
        "t2-start", "t2-end",
        "t3-start", "t3-end",
    ]


@pytest.mark.asyncio
async def test_different_players_run_in_parallel(make_relayer_service):
    """不同玩家的交易可以并行执行"""
    svc = make_relayer_service()
    svc._available = True

    # 用一个共享的"执行中"集合来验证并行
    concurrent_count = 0
    max_concurrent = 0
    lock = asyncio.Lock()

    async def make_task(label: str, delay: float = 0.1):
        async def _coro():
            nonlocal concurrent_count, max_concurrent
            async with lock:
                concurrent_count += 1
                if concurrent_count > max_concurrent:
                    max_concurrent = concurrent_count
            await asyncio.sleep(delay)
            async with lock:
                concurrent_count -= 1
            return {"success": True, "label": label}
        return _coro

    # 3 个不同玩家，并发执行
    tasks = [
        svc._enqueue_and_wait("0xPlayerA", await make_task("a")),
        svc._enqueue_and_wait("0xPlayerB", await make_task("b")),
        svc._enqueue_and_wait("0xPlayerC", await make_task("c")),
    ]
    await asyncio.gather(*tasks)

    # 不同玩家并行：应有至少 2 个任务同时执行
    assert max_concurrent >= 2, f"期望并行执行，max_concurrent={max_concurrent}"


@pytest.mark.asyncio
async def test_unavailable_service_returns_immediately(make_relayer_service):
    """服务不可用时直接返回失败，不进队列"""
    svc = make_relayer_service()
    svc._available = False

    invoked = []

    async def _coro():
        invoked.append(True)
        return {"success": True}

    result = await svc._enqueue_and_wait("0xPlayerA", _coro)
    assert result["success"] is False
    assert "不可用" in result["message"]
    # 不应执行 coro
    assert invoked == []


@pytest.mark.asyncio
async def test_queue_task_exception_does_not_block_subsequent(make_relayer_service):
    """队列中任务异常不会阻塞后续任务"""
    svc = make_relayer_service()
    svc._available = True

    async def _coro_fail():
        raise RuntimeError("boom")

    async def _coro_ok():
        return {"success": True, "ok": True}

    # 第一个任务抛异常
    task1 = asyncio.ensure_future(svc._enqueue_and_wait("0xPlayerA", _coro_fail))
    # 第二个任务应正常执行
    task2 = asyncio.ensure_future(svc._enqueue_and_wait("0xPlayerA", _coro_ok))

    # task1 因异常 future.set_exception 会抛出
    with pytest.raises(RuntimeError):
        await task1
    result2 = await task2
    assert result2["ok"] is True


# ==================== Stuck 交易重发测试 ====================


@pytest.mark.asyncio
async def test_stuck_tx_no_resend_when_already_confirmed(make_relayer_service, monkeypatch):
    """stuck 交易已被确认的不重发"""
    from rps_backend.service import relayer_service as rs_module

    svc = make_relayer_service()
    svc._available = True
    # receipt 正常返回（已确认），不抛异常
    svc.w3 = FakeWeb3(FakeEth(connected=True, receipt_status=1, receipt_raise=False))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    tx_hash = "0xdeadbeef"
    async with svc._pending_lock:
        svc._pending_txs[tx_hash] = {
            "submit_time": time.time() - rs_module.STUCK_TX_TIMEOUT - 1,  # 已超时
            "nonce": 5,
            "gas_price": 1000,
            "tx_data": {"from": "0x11", "to": "0x22"},
            "bump_count": 0,
        }

    send_raw_calls = []

    # 直接 patch FakeEth.send_raw_transaction 来记录调用（不应被调用）
    original_send = svc.w3.eth.send_raw_transaction

    def _spy_send(raw):
        send_raw_calls.append(raw)
        return original_send(raw)

    svc.w3.eth.send_raw_transaction = _spy_send

    await svc._handle_stuck_tx(tx_hash, svc._pending_txs[tx_hash])

    # 应从 pending 列表移除（已确认）
    assert tx_hash not in svc._pending_txs
    # 不应调用 send_raw_transaction
    assert send_raw_calls == []


@pytest.mark.asyncio
async def test_stuck_tx_bumps_gas_and_resends(make_relayer_service, monkeypatch):
    """stuck 交易超时未确认时 bump gas 重发"""
    from rps_backend.service import relayer_service as rs_module

    svc = make_relayer_service()
    svc._available = True
    # receipt 查询抛异常（视为未确认）
    svc.w3 = FakeWeb3(FakeEth(connected=True, receipt_raise=True))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    tx_hash = "0xdeadbeef"
    old_gas_price = 1000
    async with svc._pending_lock:
        svc._pending_txs[tx_hash] = {
            "submit_time": time.time() - rs_module.STUCK_TX_TIMEOUT - 1,  # 已超时
            "nonce": 5,
            "gas_price": old_gas_price,
            "tx_data": {
                "from": "0x" + "11" * 20,
                "to": "0x" + "22" * 20,
                "gas": 300000,
                "gasPrice": old_gas_price,
                "nonce": 5,
            },
            "bump_count": 0,
        }

    send_raw_calls = []

    # 记录 send_raw_transaction 调用
    original_send = svc.w3.eth.send_raw_transaction

    def _spy_send(raw):
        send_raw_calls.append(raw)
        return original_send(raw)

    svc.w3.eth.send_raw_transaction = _spy_send

    await svc._handle_stuck_tx(tx_hash, svc._pending_txs[tx_hash])

    # 验证：旧 tx 已被移除，新 tx 已登记
    assert tx_hash not in svc._pending_txs
    new_keys = list(svc._pending_txs.keys())
    assert len(new_keys) == 1
    new_info = svc._pending_txs[new_keys[0]]
    # gas price 应增加 20%
    expected_new_gas = int(old_gas_price * rs_module.STUCK_TX_GAS_BUMP_RATIO)
    assert new_info["gas_price"] == expected_new_gas
    # bump_count 增加
    assert new_info["bump_count"] == 1
    # 应调用了 send_raw_transaction
    assert len(send_raw_calls) == 1


@pytest.mark.asyncio
async def test_stuck_tx_gives_up_after_max_bumps(make_relayer_service, monkeypatch):
    """stuck 交易重发次数达上限后放弃"""
    from rps_backend.service import relayer_service as rs_module

    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True, receipt_raise=True))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    tx_hash = "0xdeadbeef"
    async with svc._pending_lock:
        svc._pending_txs[tx_hash] = {
            "submit_time": time.time() - rs_module.STUCK_TX_TIMEOUT - 1,
            "nonce": 5,
            "gas_price": 1000,
            "tx_data": {"from": "0x11"},
            "bump_count": 3,  # 已达上限
        }

    send_raw_calls = []

    original_send = svc.w3.eth.send_raw_transaction

    def _spy_send(raw):
        send_raw_calls.append(raw)
        return original_send(raw)

    svc.w3.eth.send_raw_transaction = _spy_send

    await svc._handle_stuck_tx(tx_hash, svc._pending_txs[tx_hash])

    # 应从 pending 列表移除，不再重发
    assert tx_hash not in svc._pending_txs
    # 不应执行 send_raw_transaction
    assert send_raw_calls == []


@pytest.mark.asyncio
async def test_stuck_tx_missing_tx_data_drops(make_relayer_service, monkeypatch):
    """stuck 交易缺少 tx_data 时直接移除，不重发"""
    from rps_backend.service import relayer_service as rs_module

    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True, receipt_raise=True))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    tx_hash = "0xdeadbeef"
    async with svc._pending_lock:
        svc._pending_txs[tx_hash] = {
            "submit_time": time.time() - rs_module.STUCK_TX_TIMEOUT - 1,
            "nonce": 5,
            "gas_price": 1000,
            "tx_data": None,  # 缺失
            "bump_count": 0,
        }

    send_raw_calls = []
    original_send = svc.w3.eth.send_raw_transaction

    def _spy_send(raw):
        send_raw_calls.append(raw)
        return original_send(raw)

    svc.w3.eth.send_raw_transaction = _spy_send

    await svc._handle_stuck_tx(tx_hash, svc._pending_txs[tx_hash])
    assert tx_hash not in svc._pending_txs
    assert send_raw_calls == []


@pytest.mark.asyncio
async def test_check_stuck_txs_skips_non_expired(make_relayer_service):
    """未超时的 pending 交易不被处理"""
    from rps_backend.service import relayer_service as rs_module

    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    tx_hash = "0xfresh"
    async with svc._pending_lock:
        svc._pending_txs[tx_hash] = {
            "submit_time": time.time(),  # 刚提交，未超时
            "nonce": 1,
            "gas_price": 1000,
            "tx_data": {"from": "0x11"},
            "bump_count": 0,
        }

    # mock _handle_stuck_tx 确保不被调用
    handle_calls = []
    monkeypatch_async_handle = False

    async def _fake_handle(tx_hash, info):
        handle_calls.append(tx_hash)

    svc._handle_stuck_tx = _fake_handle

    await svc._check_stuck_txs()
    assert handle_calls == []
    # 仍在 pending 列表
    assert tx_hash in svc._pending_txs


@pytest.mark.asyncio
async def test_check_stuck_txs_handles_expired(make_relayer_service):
    """超时的 pending 交易被处理"""
    from rps_backend.service import relayer_service as rs_module

    svc = make_relayer_service()
    svc._available = True
    svc.w3 = FakeWeb3(FakeEth(connected=True))
    svc.relayer_account = FakeAccount("0x" + "11" * 20)

    tx_hash = "0xexpired"
    async with svc._pending_lock:
        svc._pending_txs[tx_hash] = {
            "submit_time": time.time() - rs_module.STUCK_TX_TIMEOUT - 1,
            "nonce": 1,
            "gas_price": 1000,
            "tx_data": {"from": "0x11"},
            "bump_count": 0,
        }

    handle_calls = []

    async def _fake_handle(tx_hash, info):
        handle_calls.append(tx_hash)
        # 模拟 _handle_stuck_tx 移除条目
        async with svc._pending_lock:
            svc._pending_txs.pop(tx_hash, None)

    svc._handle_stuck_tx = _fake_handle

    await svc._check_stuck_txs()
    assert tx_hash in handle_calls
    assert tx_hash not in svc._pending_txs
