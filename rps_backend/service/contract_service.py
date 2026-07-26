"""
合约事件监听服务模块

负责监听 ChainRPS 链上合约事件并同步到本地数据库。

重要约定（后端无博弈权限）：
- 后端不发起任何链上交易，只读取事件
- 胜负结果由链上合约事件同步到本地
- 超时判负由玩家主动调用合约 claimTimeout() 触发，后端仅监听事件

监听的事件类型：
- GameCreated：对局创建
- PlayerJoined：玩家加入对局
- CommitSubmitted：玩家提交哈希
- ChoiceRevealed：玩家揭晓出拳
- GameSettled：对局结算（有胜者）
- TimeoutClaimed：超时判负
- DrawHandled：平局处理
- MatchCancelled：对局取消
"""
import asyncio
import json
import os
from typing import List, Optional

from rps_backend.config import CONTRACT_ADDRESS, RPC_URL


# ==================== 合约 ABI 加载 ====================
# 从编译产物中加载真实 ABI
_ABI_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
    "contracts", "abi", "ChainRPS.json"
)

CONTRACT_ABI: List = []
try:
    with open(_ABI_PATH, "r", encoding="utf-8") as f:
        CONTRACT_ABI = json.load(f)
except FileNotFoundError:
    print(f"⚠️  合约 ABI 文件未找到: {_ABI_PATH}")
except json.JSONDecodeError as e:
    print(f"⚠️  合约 ABI 文件解析失败: {e}")


# 合约事件监听服务
class ContractService:
    """
    合约事件监听服务

    通过 Web3 provider 监听链上合约事件，将事件同步到本地数据库，
    并通过 game_manager 通知玩家对局结果。
    """

    # 初始化
    def __init__(self):
        """
        初始化 Web3 provider 与合约对象

        优先使用 .env 中的 CONTRACT_ADDRESS；若为空，则尝试从数据库
        查找 localhost 网络的最新已部署合约。
        若两者都没有，或 Web3 初始化失败，则跳过合约初始化，
        事件监听功能将不可用（其他服务仍可正常运行）。
        """
        self.w3 = None
        self.contract = None
        self.listening = False
        self._listen_task: Optional[asyncio.Task] = None
        # 记录最后处理的区块号，用于增量同步事件
        self._last_block = 0
        # 实际使用的合约地址（可能来自 .env 或数据库）
        self._contract_address = CONTRACT_ADDRESS

        if not CONTRACT_ABI or not isinstance(CONTRACT_ABI, list) or len(CONTRACT_ABI) == 0:
            print("⚠️  合约 ABI 无效，跳过合约初始化")
            return

        # 如果 .env 中没有配置合约地址，尝试从数据库加载
        if not self._contract_address:
            self._contract_address = self._load_contract_from_db()
            if self._contract_address:
                print(f"ℹ️  从数据库加载合约地址: {self._contract_address}")

        if not self._contract_address:
            print("ℹ️  未配置合约地址，跳过链上事件监听（可在管理面板部署合约）")
            return

        try:
            from web3 import Web3

            # 验证合约地址格式
            if not Web3.is_address(self._contract_address):
                print(f"⚠️  无效的合约地址格式: {self._contract_address}")
                return

            # 验证 RPC 连接
            self.w3 = Web3(Web3.HTTPProvider(RPC_URL))
            if not self.w3.is_connected():
                print(f"⚠️  无法连接到 RPC 节点: {RPC_URL}")
                self.w3 = None
                return

            self.contract = self.w3.eth.contract(
                address=self._contract_address,
                abi=CONTRACT_ABI,
            )
            # 初始化为当前区块号
            self._last_block = self.w3.eth.block_number
            print(f"✅ Web3 初始化成功，合约:[{self._contract_address}] 链 ID: {self.w3.eth.chain_id}")
        except Exception as e:
            print(f"⚠️  Web3 初始化失败: {e}")
            self.w3 = None
            self.contract = None

    # 从数据库加载合约地址
    def _load_contract_from_db(self) -> Optional[str]:
        """从数据库加载 localhost 网络的最新合约地址"""
        try:
            from rps_backend.repository import list_contracts
            contracts = list_contracts(network="localhost", status="active")
            if contracts:
                latest = max(contracts, key=lambda c: c.get("id", 0))
                return latest.get("address")
        except Exception as e:
            print(f"⚠️  从数据库加载合约地址失败: {e}")
        return None

    # 动态更新合约地址
    async def update_contract_address(self, new_address: str) -> bool:
        """
        动态更新合约地址并重启事件监听

        当用户在管理面板部署新合约后，可调用此方法让后端
        切换到新合约地址并开始监听事件。

        Args:
            new_address: 新的合约地址

        Returns:
            是否更新成功
        """
        if not new_address:
            return False

        try:
            from web3 import Web3

            if not Web3.is_address(new_address):
                print(f"⚠️  无效的合约地址格式: {new_address}")
                return False

            if self.listening:
                await self.stop_listening()

            self._contract_address = new_address

            if not self.w3:
                self.w3 = Web3(Web3.HTTPProvider(RPC_URL))
                if not self.w3.is_connected():
                    print(f"⚠️  无法连接到 RPC 节点: {RPC_URL}")
                    self.w3 = None
                    return False

            self.contract = self.w3.eth.contract(
                address=new_address,
                abi=CONTRACT_ABI,
            )
            self._last_block = self.w3.eth.block_number

            print(f"✅ 合约地址已更新: {new_address[:10]}..., 链 ID: {self.w3.eth.chain_id}")

            await self.start_listening()
            return True

        except Exception as e:
            print(f"⚠️  更新合约地址失败: {e}")
            self.w3 = None
            self.contract = None
            return False

    # 启动事件监听
    async def start_listening(self):
        """
        启动事件监听循环

        若合约地址未配置，打印信息并跳过。
        监听事件包括：GameCreated, PlayerJoined, CommitSubmitted,
        ChoiceRevealed, GameSettled, TimeoutClaimed, DrawHandled, MatchCancelled。
        """
        if not self._contract_address:
            print("ℹ️  未配置合约地址，跳过链上事件监听")
            return

        if not self.contract:
            print("ℹ️  合约对象未初始化，跳过链上事件监听")
            return

        if not CONTRACT_ABI:
            print("ℹ️  合约 ABI 为空，跳过链上事件监听")
            return

        if self.listening:
            print("ℹ️  事件监听已在运行")
            return

        self.listening = True
        self._listen_task = asyncio.create_task(self._listen_loop())
        print("✅ 链上事件监听已启动")

    # 事件监听循环
    async def _listen_loop(self):
        """
        事件监听循环

        通过轮询合约事件日志实现事件订阅。
        每 5 秒拉取一次新增区块中的合约事件。
        """
        poll_interval = 5  # 轮询间隔（秒）

        try:
            while self.listening:
                try:
                    current_block = self.w3.eth.block_number

                    # 增量同步：从上次处理的区块+1 到当前区块
                    from_block = self._last_block + 1

                    if from_block <= current_block:
                        await self._process_events(from_block, current_block)
                        self._last_block = current_block

                except Exception as e:
                    print(f"⚠️  事件轮询异常: {e}")

                await asyncio.sleep(poll_interval)

        except asyncio.CancelledError:
            # 任务被取消，正常退出
            pass
        except Exception as e:
            print(f"⚠️  事件监听循环异常: {e}")

    # 处理区块范围内事件
    async def _process_events(self, from_block: int, to_block: int):
        """
        处理指定区块范围内的所有合约事件

        依次查询各类事件并分发到对应的处理回调。
        """
        if not self.contract:
            return

        # 定义事件名与处理函数的映射
        event_handlers = {
            "GameCreated": self._on_game_created,
            "PlayerJoined": self._on_player_joined,
            "CommitSubmitted": self._on_commit_submitted,
            "ChoiceRevealed": self._on_choice_revealed,
            "GameSettled": self._on_game_settled,
            "TimeoutClaimed": self._on_timeout_claimed,
            "DrawHandled": self._on_draw_handled,
            "MatchCancelled": self._on_match_cancelled,
        }

        for event_name, handler in event_handlers.items():
            try:
                # 获取合约事件对象
                event_obj = getattr(self.contract.events, event_name, None)
                if event_obj is None:
                    continue

                # 查询事件日志
                logs = event_obj.get_logs(from_block=from_block, to_block=to_block)

                for log in logs:
                    try:
                        # 解析事件参数
                        event_data = {
                            "args": dict(log.args),
                            "transaction_hash": log.transaction_hash.hex(),
                            "block_number": log.block_number,
                            "log_index": log.log_index,
                        }
                        await handler(event_data)
                    except Exception as e:
                        print(f"⚠️  处理事件 {event_name} 异常: {e}")

            except Exception as e:
                # 单类事件查询失败不影响其他事件
                print(f"⚠️  查询事件 {event_name} 异常: {e}")

    # 停止事件监听
    async def stop_listening(self):
        """停止事件监听"""
        self.listening = False
        if self._listen_task and not self._listen_task.done():
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
        self._listen_task = None
        print("👋 链上事件监听已停止")

    # ==================== 事件处理回调 ====================

    # 处理GameCreated事件
    async def _on_game_created(self, event_data: dict):
        """
        处理 GameCreated 事件

        当链上创建新对局时，同步对局信息到本地数据库。
        """
        from rps_backend.repository import update_game_from_chain_event
        from rps_backend.models import GameState

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")
        creator = args.get("creator")
        amount = args.get("amount")
        token = args.get("token")

        if chain_game_id is None:
            return

        # token 地址转换为符号（简化处理，实际可维护地址映射）
        token_symbol = "UNKNOWN"
        token_lower = str(token).lower() if token else ""
        
        if token_lower == "0x0000000000000000000000000000000000000000":
            token_symbol = "ETH"
            decimals = 18
        else:
            token_symbol = "USDC"
            decimals = 6

        updates = {
            "player1": creator,
            "token": token_symbol,
            "bet_amount": float(amount) / (10 ** decimals) if amount else 0.0,
            "state": GameState.WAITING.value,
        }
        update_game_from_chain_event(chain_game_id, updates)
        print(f"[GameCreated] gameId={chain_game_id}, creator={creator}")

    # 处理PlayerJoined事件
    async def _on_player_joined(self, event_data: dict):
        """
        处理 PlayerJoined 事件

        当玩家加入对局时，更新本地对局记录。
        """
        from rps_backend.repository import update_game_from_chain_event
        from rps_backend.models import GameState

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")
        player = args.get("player")

        if chain_game_id is None:
            return

        updates = {
            "player2": player,
            "state": GameState.COMMIT_PHASE.value,
        }
        update_game_from_chain_event(chain_game_id, updates)
        print(f"[PlayerJoined] gameId={chain_game_id}, player={player}")

    # 处理CommitSubmitted事件
    async def _on_commit_submitted(self, event_data: dict):
        """
        处理 CommitSubmitted 事件

        当玩家提交哈希承诺时，更新本地对局记录。
        """
        from rps_backend.repository import get_game_by_chain_id, update_game_record

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")
        player = args.get("player")
        commit = args.get("commit")

        if chain_game_id is None:
            return

        game = get_game_by_chain_id(chain_game_id)
        if not game:
            return

        # 判断是哪一方玩家
        if player == game.get("player1"):
            update_game_record(game["id"], {"commit1": str(commit) if commit else None})
        elif player == game.get("player2"):
            update_game_record(game["id"], {"commit2": str(commit) if commit else None})

        print(f"[CommitSubmitted] gameId={chain_game_id}, player={player}")

    # 处理ChoiceRevealed事件
    async def _on_choice_revealed(self, event_data: dict):
        """
        处理 ChoiceRevealed 事件

        当玩家揭晓出拳时，更新本地对局记录。
        """
        from rps_backend.repository import get_game_by_chain_id, update_game_record

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")
        player = args.get("player")
        choice_uint8 = args.get("choice", 0)

        if chain_game_id is None:
            return

        # uint8 转换为 Choice 枚举字符串（合约：1=石头, 2=布, 3=剪刀）
        choice_map = {1: "rock", 2: "paper", 3: "scissors"}
        choice_str = choice_map.get(choice_uint8, "unknown")

        game = get_game_by_chain_id(chain_game_id)
        if not game:
            return

        if player == game.get("player1"):
            update_game_record(game["id"], {"choice1": choice_str})
        elif player == game.get("player2"):
            update_game_record(game["id"], {"choice2": choice_str})

        print(f"[ChoiceRevealed] gameId={chain_game_id}, player={player}, choice={choice_str}")

    # 处理GameSettled事件
    async def _on_game_settled(self, event_data: dict):
        """
        处理 GameSettled 事件

        当链上完成对局结算时：
        1. 从事件参数提取 winner、fee
        2. 调用 game_manager.update_game_result_from_chain 同步到本地
        3. 通知双方 game_result
        """
        from rps_backend.service.game_service import game_manager
        from rps_backend.repository import get_game_by_chain_id

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")
        winner = args.get("winner")
        amount = args.get("amount", 0)
        fee = args.get("fee", 0)

        if chain_game_id is None:
            return

        game = get_game_by_chain_id(chain_game_id)
        if not game:
            return

        # 根据代币类型确定小数位：ETH=18，USDC/USDT=6
        token_symbol = (game.get("token") or "ETH").upper()
        decimals = 18 if token_symbol == "ETH" else 6
        fee_float = float(fee) / (10 ** decimals) if fee else 0.0

        await game_manager.update_game_result_from_chain(
            game["id"], winner, False, fee_float
        )
        print(f"[GameSettled] gameId={chain_game_id}, winner={winner}, fee={fee_float}")

    # 处理TimeoutClaimed事件
    async def _on_timeout_claimed(self, event_data: dict):
        """
        处理 TimeoutClaimed 事件

        当玩家调用合约 claimTimeout() 触发超时判负时：
        1. 从链上查询对局获取 winner（未超时方）
        2. 调用 game_manager.update_game_result_from_chain 同步到本地
        """
        from rps_backend.service.game_service import game_manager
        from rps_backend.repository import get_game_by_chain_id

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")
        claimer = args.get("claimer")

        if chain_game_id is None:
            return

        game = get_game_by_chain_id(chain_game_id)
        if not game:
            return

        # 从链上查询对局状态获取 winner
        winner = None
        try:
            if self.contract:
                chain_game = self.contract.functions.getGame(chain_game_id).call()
                # getGame 返回元组：(player1, player2, amount, token, status, commitDeadline, revealDeadline, winner, isDraw)
                winner = chain_game[7] if len(chain_game) > 7 else None
        except Exception as e:
            print(f"⚠️  查询链上对局状态失败: {e}")

        await game_manager.update_game_result_from_chain(
            game["id"], winner, False, 0.0
        )
        print(f"[TimeoutClaimed] gameId={chain_game_id}, claimer={claimer}")

    # 处理DrawHandled事件
    async def _on_draw_handled(self, event_data: dict):
        """
        处理 DrawHandled 事件

        当链上处理平局退款时：
        1. 从事件参数提取对局 ID
        2. 调用 game_manager.update_game_result_from_chain 同步到本地（is_draw=True）
        """
        from rps_backend.service.game_service import game_manager
        from rps_backend.repository import get_game_by_chain_id

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")

        if chain_game_id is None:
            return

        game = get_game_by_chain_id(chain_game_id)
        if not game:
            return

        # 平局：合约全额退款，无手续费
        await game_manager.update_game_result_from_chain(
            game["id"], None, True, 0
        )
        print(f"[DrawHandled] gameId={chain_game_id}")

    # 处理MatchCancelled事件
    async def _on_match_cancelled(self, event_data: dict):
        """
        处理 MatchCancelled 事件

        当 Owner 取消对局时，更新本地对局状态为已取消。
        """
        from rps_backend.repository import get_game_by_chain_id, update_game_record
        from rps_backend.models import GameState

        args = event_data.get("args", {})
        chain_game_id = args.get("gameId")

        if chain_game_id is None:
            return

        game = get_game_by_chain_id(chain_game_id)
        if not game:
            return

        update_game_record(game["id"], {
            "state": GameState.CANCELLED.value,
        })
        print(f"[MatchCancelled] gameId={chain_game_id}")

    # 从链上同步玩家历史记录
    async def sync_history_from_chain(
        self,
        address: str,
        page: int = 1,
        size: int = 20,
    ) -> List[dict]:
        """
        从链上同步玩家历史记录（降级查询方案）

        当本地数据库无记录或记录不全时，可从链上事件重建历史。
        通过查询玩家的 playerGames 映射获取所有对局 ID。

        Returns:
            历史对局列表，每项为对局信息字典
        """
        if not self.contract:
            return []

        try:
            # 查询玩家参与的所有对局 ID
            game_ids = self.contract.functions.getPlayerGames(address).call()

            # 分页
            total = len(game_ids)
            start = max(0, total - page * size)
            end = max(0, start + size)
            page_ids = list(reversed(game_ids[start:end]))

            results = []
            for gid in page_ids:
                try:
                    game_data = self.contract.functions.getGame(gid).call()
                    
                    token_address = str(game_data[3]).lower()
                    if token_address == "0x0000000000000000000000000000000000000000":
                        token_symbol = "ETH"
                        decimals = 18
                    else:
                        token_symbol = "USDC"
                        decimals = 6
                    
                    results.append({
                        "chain_game_id": gid,
                        "player1": game_data[0],
                        "player2": game_data[1],
                        "bet_amount": float(game_data[2]) / (10 ** decimals) if game_data[2] else 0.0,
                        "token": token_symbol,
                        "state": int(game_data[4]),
                        "winner": game_data[7],
                        "is_draw": game_data[8],
                    })
                except Exception:
                    continue

            return results

        except Exception as e:
            print(f"⚠️  链上历史记录查询失败: {e}")
            return []


# 全局合约服务实例
contract_service = ContractService()