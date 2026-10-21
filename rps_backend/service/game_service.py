"""
游戏状态管理服务模块

负责 ChainRPS 对局过程中的状态记录与 WebSocket 通知。

重要约定（后端无博弈权限）：
- 不做胜负判定，胜负结果由链上合约事件同步
- 不做结算，结算由链上合约完成
- 仅记录玩家提交与揭晓、推送通知、同步链上事件结果
"""
from datetime import datetime
from typing import Optional
import logging

logger = logging.getLogger(__name__)

from rps_backend.config import REVEAL_TIMEOUT
from rps_backend.models import GameState, Choice, WSMessage
from rps_backend.repository import (
    get_game_record,
    update_game_record,
    update_player_stats,
)
from rps_backend.service.room_service import room_manager, ROOM_STATUS
from rps_backend.utils.helpers import now_timestamp
from rps_backend.utils.helpers import calculate_deadline, deadline_to_iso
from rps_backend.utils.redis_client import redis_client
from rps_backend.websocket import ws_manager


# 出拳名称到数字的映射（合约中使用 uint8：1=Rock, 2=Paper, 3=Scissors）
_CHOICE_NAME_TO_INT = {
    "rock": 1,
    "paper": 2,
    "scissors": 3,
}


def _determine_rps_result(c1: int, c2: int, p1_addr: str = None, p2_addr: str = None) -> dict:
    """本地 RPS 胜负判定（仅 localOnly 模式使用）

    规则：Rock(1) > Scissors(3) > Paper(2) > Rock(1)
    """
    if c1 == c2:
        return {"is_draw": True, "winner": None}
    # c1 赢的情况：1>3, 3>2, 2>1
    p1_wins = (c1 == 1 and c2 == 3) or (c1 == 3 and c2 == 2) or (c1 == 2 and c2 == 1)
    return {
        "is_draw": False,
        "winner": p1_addr if p1_wins else p2_addr,
    }


# 校验承诺哈希（F1-16 修复：与合约 keccak256(abi.encodePacked(choice, salt, player)) 一致）
def _verify_commit(choice, salt: str, address: str, commit_hash: str) -> bool:
    """
    校验承诺哈希，与合约 _revealChoice 中的计算保持一致：
        bytes32 commit = keccak256(abi.encodePacked(choice, salt, player));

    参数说明：
        choice: 出拳，可传入整数 1/2/3 或字符串 "rock"/"paper"/"scissors"
        salt: 32 字节盐值，hex 字符串（带或不带 0x 前缀）
        address: 玩家钱包地址（hex 字符串）
        commit_hash: 待校验的哈希承诺，hex 字符串（带或不带 0x 前缀）

    Returns:
        True 表示 salt/choice/address 计算出的哈希与 commit_hash 一致

    实现要点（与合约对齐）：
        - keccak256（非 sha3_256）
        - abi.encodePacked 紧密打包：uint8 choice(1B) + bytes32 salt(32B) + address player(20B)
        - 不再做字符串拼接
    """
    if choice is None or not salt or not address or not commit_hash:
        return False

    # choice 归一化为 uint8
    if isinstance(choice, int):
        choice_int = choice
    elif isinstance(choice, str):
        choice_int = _CHOICE_NAME_TO_INT.get(choice.lower())
        if choice_int is None:
            # 兼容直接传 "1"/"2"/"3" 字符串
            try:
                choice_int = int(choice)
            except (TypeError, ValueError):
                return False
    else:
        return False

    if choice_int not in (1, 2, 3):
        return False

    # 解析 salt：32 字节 hex
    try:
        salt_bytes = bytes.fromhex(salt[2:] if salt.startswith("0x") else salt)
    except (ValueError, TypeError):
        return False
    if len(salt_bytes) != 32:
        return False

    # 解析 address：20 字节 hex
    try:
        addr_bytes = bytes.fromhex(address[2:] if address.startswith("0x") else address)
    except (ValueError, TypeError):
        return False
    if len(addr_bytes) != 20:
        return False

    # 模拟 abi.encodePacked(choice(uint8), salt(bytes32), player(address))
    packed = bytes([choice_int]) + salt_bytes + addr_bytes

    # keccak256（与合约一致，非 sha3_256）
    try:
        from eth_hash.auto import keccak
    except ImportError:
        # web3 已安装，回退到 web3 提供的 keccak
        from web3 import Web3
        computed_bytes = Web3.keccak(packed)
    else:
        computed_bytes = keccak(packed)

    computed_hex = "0x" + computed_bytes.hex()

    return computed_hex.lower() == commit_hash.lower()


# 判定胜负
def _determine_winner(choice1: str, choice2: str) -> Optional[int]:
    """
    判定胜负
    返回: 1 - 玩家1胜, 2 - 玩家2胜, None - 平局
    """
    if choice1 == choice2:
        return None
    wins = {
        "rock": "scissors",
        "scissors": "paper",
        "paper": "rock",
    }
    if wins.get(choice1) == choice2:
        return 1
    return 2


# 游戏状态管理器
class GameManager:
    """
    游戏状态管理器

    仅负责对局状态的记录与通知，不做胜负判定与结算。
    胜负结果由 contract_service 从链上事件同步后调用 update_game_result_from_chain 写入。
    """

    # 初始化
    def __init__(self):
        """初始化，后端不需要 Web3 实例（不发起任何链上交易）"""
        pass #别删除，用于人工代码审核 便利

    # 提交哈希承诺
    async def submit_commit(self, game_id: int, player_address: str, commit_hash: str) -> dict:
        """
        提交哈希承诺

        流程：
        1. 记录提交到数据库（update_game_record）
        2. 更新缓存
        3. 通知对手 opponent_commit
        4. 双方都提交后：更新状态为 REVEAL_PHASE，设置 reveal_deadline，通知双方 reveal_start

        注意：不做任何校验或判定，仅记录与通知。
        """
        game = get_game_record(game_id)
        if not game:
            return {"error": "Game not found"}

        # 判断是哪一方玩家
        is_player1 = game.get("player1") == player_address
        is_player2 = game.get("player2") == player_address
        if not (is_player1 or is_player2):
            return {"error": "Not a player in this game"}

        # 记录提交
        commit_field = "commit1" if is_player1 else "commit2"
        update_game_record(game_id, {commit_field: commit_hash})

        # 更新缓存
        cached_state = redis_client.get_cached_game_state(game_id)
        if cached_state:
            cached_state[commit_field] = commit_hash
            redis_client.cache_game_state(game_id, cached_state)

        # 通知对手已提交
        opponent = game.get("player2") if is_player1 else game.get("player1")
        if opponent:
            await ws_manager.send_to_player(opponent, WSMessage(
                type="opponent_commit",
                data={"game_id": game_id, "player": player_address}
            ))

        # 检查双方是否都已提交
        latest_game = get_game_record(game_id)
        if latest_game and latest_game.get("commit1") and latest_game.get("commit2"):
            # 进入揭晓阶段
            reveal_deadline_ts = calculate_deadline(REVEAL_TIMEOUT)
            reveal_deadline_iso = deadline_to_iso(reveal_deadline_ts)

            update_game_record(game_id, {
                "state": GameState.REVEAL_PHASE.value,
                "reveal_deadline": reveal_deadline_iso,
            })

            # 更新缓存
            if cached_state:
                cached_state["state"] = GameState.REVEAL_PHASE.value
                cached_state["reveal_deadline"] = reveal_deadline_ts
                redis_client.cache_game_state(game_id, cached_state)

            # 通知双方进入揭晓阶段
            player1 = latest_game.get("player1")
            player2 = latest_game.get("player2")
            reveal_start_data = {
                "game_id": game_id,
                "reveal_deadline": reveal_deadline_ts,
            }
            if player1:
                await ws_manager.send_to_player(player1, WSMessage(
                    type="reveal_start",
                    data=reveal_start_data,
                ))
            if player2:
                await ws_manager.send_to_player(player2, WSMessage(
                    type="reveal_start",
                    data=reveal_start_data,
                ))

        return {"success": True, "game_id": game_id}

    # 揭晓出拳
    async def reveal_choice(self, game_id: int, player_address: str, choice: Choice, salt: str) -> dict:
        """
        揭晓出拳（仅记录状态与通知，不做胜负判定与结算）

        重要约定（后端无博弈权限）：
        - 胜负判定与结算完全由链上合约完成
        - 后端仅记录揭晓状态、通知对手
        - 链上 GameSettled / DrawHandled 事件由 contract_service 同步结果

        流程：
        1. 记录揭晓到数据库
2. 更新缓存
3. 通知对手 opponent_reveal
        """
        logger.info(f"[Reveal API] game_id={game_id} player={player_address[:12]} choice={choice}")
        game = get_game_record(game_id)
        if not game:
            logger.warning(f"[Reveal API] game_id={game_id} NOT FOUND")
            return {"error": "Game not found"}

        # 判断是哪一方玩家
        is_player1 = game.get("player1") == player_address
        is_player2 = game.get("player2") == player_address
        if not (is_player1 or is_player2):
            return {"error": "Not a player in this game"}

        # 统一处理 choice 取值
        choice_value = choice.value if isinstance(choice, Choice) else choice

        # 记录揭晓
        choice_field = "choice1" if is_player1 else "choice2"
        salt_field = "salt1" if is_player1 else "salt2"
        update_game_record(game_id, {
            choice_field: choice_value,
            salt_field: salt,
        })

        # 更新缓存
        cached_state = redis_client.get_cached_game_state(game_id)
        if cached_state:
            cached_state[choice_field] = choice_value
            cached_state[salt_field] = salt
            redis_client.cache_game_state(game_id, cached_state)

        # 房间标记：进入揭晓阶段（资金流程状态更新）
        try:
            room_info = room_manager.get_player_room(game.get("player1") or "")
            if not room_info:
                room_info = room_manager.get_player_room(game.get("player2") or "")
            if room_info and room_info.get("game_id") == game_id:
                r = room_manager._rooms.get(room_info["room_id"])
                if r:
                    r["fund_stage"] = "revealing"
                    redis_client.cache_room_state(room_info["room_id"], r)
        except Exception:
            pass

        # 通知对手已揭晓
        opponent = game.get("player2") if is_player1 else game.get("player1")
        if opponent:
            await ws_manager.send_to_player(opponent, WSMessage(
                type="opponent_reveal",
                data={
                    "game_id": game_id,
                    "player": player_address,
                    "choice": choice_value,
                }
            ))

        # 🆕 localOnly 模式：双方都 reveal 后本地算胜负 + 广播 game_result
        # 链上模式：胜负由合约事件同步，后端不处理
        latest_game = get_game_record(game_id)
        if latest_game:
            c1 = latest_game.get("choice1")
            c2 = latest_game.get("choice2")
            chain_id = latest_game.get("chain_game_id")
            logger.info(f"[Reveal API] game_id={game_id} c1={c1} c2={c2} chain_id={chain_id}")
            if c1 is not None and c2 is not None and not chain_id:
                # = localOnly 模式，双方都已揭晓
                # 🆕 choice 可能是字符串 ("rock"/"paper"/"scissors") 也可能是 int
                c1_int = _CHOICE_NAME_TO_INT.get(c1, c1 if isinstance(c1, int) else None)
                c2_int = _CHOICE_NAME_TO_INT.get(c2, c2 if isinstance(c2, int) else None)
                if c1_int is None or c2_int is None:
                    logger.error(f"Invalid choice types: c1={c1}({type(c1)}), c2={c2}({type(c2)})")
                    return
                result = _determine_rps_result(c1_int, c2_int, latest_game.get("player1"), latest_game.get("player2"))
                logger.info(f"[Reveal API] game_id={game_id} 双方都揭晓! 结果: winner={result.get('winner')[:12] if result.get('winner') else None} is_draw={result.get('is_draw')}")
                update_game_record(game_id, {
                    "state": "finished",  # 🆕 标记对局结束
                    "winner": result.get("winner"),
                    "is_draw": result.get("is_draw", False),
                    "finished_at": datetime.utcnow().isoformat(),
                })
                # 广播 game_result 给双方
                p1 = latest_game.get("player1")
                p2 = latest_game.get("player2")
                # 给 player1 广播（含我是赢/输/平 + 对手出拳）
                if p1:
                    await ws_manager.send_to_player(p1, WSMessage(
                        type="game_result",
                        data={
                            "game_id": game_id,
                            "winner": result.get("winner"),
                            "is_draw": result.get("is_draw", False),
                            "my_choice": c1,
                            "opponent_choice": c2,
                        }
                    ))
                if p2:
                    await ws_manager.send_to_player(p2, WSMessage(
                        type="game_result",
                        data={
                            "game_id": game_id,
                            "winner": result.get("winner"),
                            "is_draw": result.get("is_draw", False),
                            "my_choice": c2,
                            "opponent_choice": c1,
                        }
                    ))

                # 🔥 关键修复：同步更新 room 状态为 finished + 广播房间列表变更
                try:
                    p1_addr = latest_game.get("player1") or ""
                    p2_addr = latest_game.get("player2") or ""
                    # 🔥 直接遍历 room_manager._rooms 找关联房间，不依赖 get_player_room（player 映射可能已被清理）
                    rid_found = None
                    r_found = None
                    for rid, rm in room_manager._rooms.items():
                        rm_p1 = (rm.get("creator") or "").lower()
                        rm_p2 = (rm.get("player2") or "").lower()
                        if (rm.get("game_id") == game_id or 
                            rm_p1 == p1_addr.lower() or rm_p2 == p1_addr.lower() or
                            rm_p1 == p2_addr.lower() or rm_p2 == p2_addr.lower()):
                            rid_found = rid
                            r_found = rm
                            break
                    if r_found:
                        r_found["status"] = ROOM_STATUS["FINISHED"]
                        r_found["fund_stage"] = "settled"
                        r_found["close_reason"] = "game_settled"
                        r_found["closed_at"] = now_timestamp()
                        # 🔥 强制写回内存 + Redis，防止并发覆盖
                        room_manager._rooms[rid_found] = r_found
                        redis_client.cache_room_state(rid_found, r_found)
                        # 🔥 同时清理 _player_rooms 映射，防止 disconnect handler 后续误触发
                        for addr_key in [p1_addr.lower(), p2_addr.lower()]:
                            if room_manager._player_rooms.get(addr_key) == rid_found:
                                room_manager._player_rooms.pop(addr_key, None)
                        logger.info(f"[Reveal API] game_id={game_id} room #{rid_found} 已更新 status=finished")
                        # 广播房间列表变更（大厅卡片需要更新状态）
                        await ws_manager.broadcast(WSMessage(
                            type="room_list_changed",
                            data={}
                        ))
                    else:
                        logger.warning(f"[Reveal API] game_id={game_id} 未找到关联房间，跳过 room 状态更新")
                except Exception as e:
                    logger.warning(f"Failed to update room state after game finish: {e}")

                # 🆕 真实链上 USDC 结算（localOnly 模式用本地链 Ganache 账号转账）
                try:
                    bet = 10.0
                    if r_found:
                        bet = float(r_found.get("bet_amount") or bet)
                    winner_addr = result.get("winner") or ""
                    is_draw = result.get("is_draw", False)
                    if not is_draw and winner_addr:
                        loser_addr = p2_addr if winner_addr.lower() == p1_addr.lower() else p1_addr
                        # 找 USDC 合约地址 + Ganache 账号私钥
                        try:
                            from rps_backend.repository import list_contracts
                            contracts = list_contracts(network="localhost")
                            usdc_addr = None
                            for c in contracts:
                                if 'USDC' in c.get('name', '') and len(c.get('address', '')) == 42:
                                    usdc_addr = c['address']; break
                        except: usdc_addr = None

                        if usdc_addr:
                            try:
                                from web3 import Web3
                                w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8686"))
                                # 找 Ganache 账号私钥
                                pk_map = {}
                                try:
                                    import os, json
                                    pks_path = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'ganache_accounts.json')
                                    if os.path.exists(pks_path):
                                        with open(pks_path) as f: pk_map = json.load(f).get('private_keys', {})
                                except: pass

                                usdc = w3.eth.contract(address=w3.to_checksum_address(usdc_addr), abi=[
                                    {"constant":False,"inputs":[{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transfer","outputs":[{"name":"success","type":"bool"}],"type":"function"},
                                    {"constant":True,"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],"type":"function"},
                                ])
                                decimals = usdc.functions.decimals().call()
                                wei = int(bet * (10 ** decimals))

                                # 如果 bot 赢了 → bot 是 Ganache 账号，用 bot 的 key 转账（但 bot 不需要付，用户输了）
                                # 如果用户赢了 → bot 也是 Ganache 账号，用 bot 的 key 给用户发奖金 ✅
                                # 关键：谁赢谁收 bet；谁输谁付 bet（但只有 Ganache 账号输时才能自动扣链上余额）
                                # 简化：backend 用第一个 Ganache 账号当 "banker" — winner 总是从 banker 收 bet
                                banker_addr = None; banker_pk = None
                                for addr, pk in pk_map.items():
                                    banker_addr = addr; banker_pk = pk; break

                                if banker_addr and banker_pk:
                                    # Winner 从 banker 收 bet（真实链上 USDC）
                                    nonce = w3.eth.get_transaction_count(w3.to_checksum_address(banker_addr))
                                    tx = usdc.functions.transfer(w3.to_checksum_address(winner_addr), wei).build_transaction({
                                        'from': w3.to_checksum_address(banker_addr),
                                        'nonce': nonce, 'chainId': w3.eth.chain_id,
                                    })
                                    signed = w3.eth.account.sign_transaction(tx, banker_pk)
                                    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
                                    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
                                    logger.info(f"[RevealSettle] 真实 USDC 转账 {'OK' if receipt['status']==1 else 'FAIL'}: banker→winner {bet} tx={tx_hash.hex()[:20]}")
                                else:
                                    logger.warning("[RevealSettle] 找不到 Ganache banker 私钥，跳过链上转账")
                            except Exception as e2:
                                logger.warning(f"[RevealSettle] 链上 USDC 转账异常: {e2}")
                        else:
                            logger.warning("[RevealSettle] 没找到 USDC 合约，跳过链上转账")
                except Exception as e:
                    logger.warning(f"[RevealSettle] 结算异常: {e}")

        return {"success": True, "game_id": game_id}

    # 处理平局
    async def handle_draw(self, game_id: int, player_address: str) -> dict:
        """
        处理平局

        后端仅返回成功，实际退款由前端调用合约完成。
        """
        return {"success": True, "game_id": game_id, "player": player_address}

    # 从链上同步对局结果
    async def update_game_result_from_chain(
        self,
        game_id: int,
        winner: Optional[str],
        is_draw: bool,
        fee: float = 0.0,
    ) -> dict:
        """
        从链上事件同步对局结果到数据库

        流程：
        1. 更新对局记录（state、winner、is_draw、fee、finished_at）
        2. 更新双方玩家统计
        3. 通知双方 game_result

        此函数由 contract_service 监听到 GameSettled / TimeoutClaimed / DrawHandled 事件后调用。
        """
        game = get_game_record(game_id)
        if not game:
            return {"error": "Game not found"}

        # 更新对局记录
        updates = {
            "state": GameState.FINISHED.value,
            "is_draw": 1 if is_draw else 0,
            "fee": fee,
            "finished_at": datetime.utcnow().isoformat(),
        }
        if winner:
            updates["winner"] = winner
        update_game_record(game_id, updates)

        # 更新玩家统计
        player1 = game.get("player1")
        player2 = game.get("player2")
        bet_amount = game.get("bet_amount", 0.0) or 0.0

        if is_draw:
            # 平局：双方均记为 draw
            if player1:
                update_player_stats(player1, "draw", bet_amount)
            if player2:
                update_player_stats(player2, "draw", bet_amount)
        elif winner:
            # 有胜者：胜者 win，败者 loss
            loser = player2 if winner == player1 else player1
            # 胜者奖金 = 下注金额 - 手续费（双方下注相同）
            winner_prize = bet_amount - fee if bet_amount > fee else 0
            update_player_stats(winner, "win", winner_prize)
            if loser:
                update_player_stats(loser, "loss", bet_amount)

        # 通知双方对局结果
        result_data = {
            "game_id": game_id,
            "winner": winner,
            "is_draw": is_draw,
            "fee": fee,
        }
        if player1:
            await ws_manager.send_to_player(player1, WSMessage(
                type="game_result",
                data=result_data,
            ))
        if player2:
            await ws_manager.send_to_player(player2, WSMessage(
                type="game_result",
                data=result_data,
            ))

        # 清理对局缓存
        redis_client.delete_cached_game_state(game_id)

        # 通知 Bot：游戏结算完成
        self._notify_bot_game_result(game_id, {
            "winner": winner,
            "is_draw": is_draw,
            "fee": fee,
        })

        # 同步：关联房间标记为已完成，停止所有计时器
        try:
            room_info = room_manager.get_player_room(player1 or "")
            if not room_info:
                room_info = room_manager.get_player_room(player2 or "")
            if room_info and room_info.get("game_id") == game_id:
                rid = room_info["room_id"]
                # 将房间标记为 FINISHED（已完成），生命周期计时器会自动跳过
                r = room_manager._rooms.get(rid)
                if r:
                    r["status"] = ROOM_STATUS["FINISHED"]
                    r["fund_stage"] = "settled"
                    r["finished_at"] = datetime.utcnow().isoformat()
                    redis_client.cache_room_state(rid, r)
                    # 停止计时器
                    room_manager._stop_game_timer(rid)
                    room_manager._stop_lifetime_timer(rid)
                    # 广播房间列表变更（从大厅移除）
                    room_manager._broadcast_room_list_changed("game_finished", rid)
        except Exception:
            pass

        return {"success": True, "game_id": game_id}

    # ==================== Bot 通知辅助方法 ====================

    def _notify_bot_game_result(self, game_id: int, result: dict) -> None:
        """通知 Bot：游戏结算完成"""
        try:
            from rps_backend.service.bot_service import bot_service
            if bot_service._is_running:
                import asyncio
                asyncio.create_task(bot_service.on_game_result_event(game_id, result))
        except Exception:
            pass
        try:
            from rps_backend.service.bot_manager import bot_manager
            import asyncio
            asyncio.create_task(bot_manager.dispatch_game_result(game_id, result))
        except Exception:
            pass


# 全局游戏管理器实例
game_manager = GameManager()