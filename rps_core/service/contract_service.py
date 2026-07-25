"""
合约事件监听服务模块

负责监听 ChainRPS 链上合约事件并同步到本地数据库。

重要约定（后端无博弈权限）：
- 后端不发起任何链上交易，只读取事件
- 胜负结果由链上合约事件同步到本地
- 超时判负由玩家主动调用合约 claimTimeout() 触发，后端仅监听事件

监听的事件类型：
- GameCreated：对局创建
- CommitSubmitted：玩家提交哈希
- ChoiceRevealed：玩家揭晓出拳
- GameSettled：对局结算（有胜者）
- TimeoutClaimed：超时判负
- DrawHandled：平局处理
"""
import asyncio
from typing import List, Optional

from rps_core.config import CONTRACT_ADDRESS, RPC_URL


# ==================== 合约 ABI（待合约部署后填充） ====================
# 占位：等合约部署后从编译产物中加载真实 ABI
CONTRACT_ABI: List = []


class ContractService:
    """
    合约事件监听服务

    通过 Web3 provider 监听链上合约事件，将事件同步到本地数据库，
    并通过 game_manager 通知玩家对局结果。
    """

    def __init__(self):
        """
        初始化 Web3 provider 与合约对象

        若 CONTRACT_ADDRESS 为空或 Web3 初始化失败，则跳过合约初始化，
        事件监听功能将不可用（其他服务仍可正常运行）。
        """
        self.w3 = None
        self.contract = None
        self.listening = False
        self._listen_task: Optional[asyncio.Task] = None

        if CONTRACT_ADDRESS:
            try:
                from web3 import Web3
                self.w3 = Web3(Web3.HTTPProvider(RPC_URL))
                self.contract = self.w3.eth.contract(
                    address=CONTRACT_ADDRESS,
                    abi=CONTRACT_ABI,
                )
            except Exception as e:
                print(f"⚠️  Web3 初始化失败: {e}")
                self.w3 = None
                self.contract = None

    async def start_listening(self):
        """
        启动事件监听循环

        若 CONTRACT_ADDRESS 为空，打印警告并跳过。
        监听事件包括：GameCreated, CommitSubmitted, ChoiceRevealed,
        GameSettled, TimeoutClaimed, DrawHandled。
        """
        if not CONTRACT_ADDRESS:
            print("⚠️  CONTRACT_ADDRESS 未配置，跳过链上事件监听")
            return

        if not self.contract:
            print("⚠️  合约对象未初始化，跳过链上事件监听")
            return

        if self.listening:
            print("ℹ️  事件监听已在运行")
            return

        self.listening = True
        self._listen_task = asyncio.create_task(self._listen_loop())
        print("✅ 链上事件监听已启动")

    async def _listen_loop(self):
        """
        事件监听循环

        通过轮询合约事件日志实现事件订阅。
        待合约 ABI 就绪后补充具体事件 filter 与处理逻辑。
        """
        try:
            while self.listening:
                # TODO: 合约 ABI 就绪后实现事件轮询
                # 当前为占位逻辑，避免空循环占用 CPU
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            # 任务被取消，正常退出
            pass
        except Exception as e:
            print(f"⚠️  事件监听循环异常: {e}")

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

    async def _on_game_created(self, event_data: dict):
        """
        处理 GameCreated 事件

        当链上创建新对局时，同步对局信息到本地数据库。
        """
        # TODO: 合约 ABI 就绪后实现
        # 延迟导入以避免循环依赖
        from rps_core.repository import update_game_from_chain_event

        print(f"[GameCreated] {event_data}")
        # 示例（待 ABI 就绪后启用）：
        # args = event_data.get("args", {})
        # chain_game_id = args.get("gameId")
        # updates = {
        #     "player1": args.get("player1"),
        #     "player2": args.get("player2"),
        #     "token": args.get("token"),
        #     "bet_amount": args.get("betAmount"),
        #     "state": GameState.COMMIT_PHASE.value,
        # }
        # update_game_from_chain_event(chain_game_id, updates)

    async def _on_game_settled(self, event_data: dict):
        """
        处理 GameSettled 事件

        当链上完成对局结算时：
        1. 从事件参数提取 winner、is_draw、fee
        2. 调用 game_manager.update_game_result_from_chain 同步到本地
        3. 通知双方 game_result
        """
        # TODO: 合约 ABI 就绪后实现
        # 延迟导入以避免循环依赖
        from rps_core.service.game_service import game_manager
        from rps_core.repository import get_game_by_chain_id

        print(f"[GameSettled] {event_data}")
        # 示例（待 ABI 就绪后启用）：
        # args = event_data.get("args", {})
        # chain_game_id = args.get("gameId")
        # winner = args.get("winner")
        # is_draw = args.get("isDraw", False)
        # fee = args.get("fee", 0)
        # game = get_game_by_chain_id(chain_game_id)
        # if game:
        #     await game_manager.update_game_result_from_chain(
        #         game["id"], winner, is_draw, fee
        #     )

    async def _on_timeout_claimed(self, event_data: dict):
        """
        处理 TimeoutClaimed 事件

        当玩家调用合约 claimTimeout() 触发超时判负时：
        1. 从事件参数提取 winner（未超时方）
        2. 调用 game_manager.update_game_result_from_chain 同步到本地
        """
        # TODO: 合约 ABI 就绪后实现
        # 延迟导入以避免循环依赖
        from rps_core.service.game_service import game_manager
        from rps_core.repository import get_game_by_chain_id

        print(f"[TimeoutClaimed] {event_data}")
        # 示例（待 ABI 就绪后启用）：
        # args = event_data.get("args", {})
        # chain_game_id = args.get("gameId")
        # winner = args.get("winner")
        # game = get_game_by_chain_id(chain_game_id)
        # if game:
        #     await game_manager.update_game_result_from_chain(
        #         game["id"], winner, False, 0
        #     )

    async def _on_draw_handled(self, event_data: dict):
        """
        处理 DrawHandled 事件

        当链上处理平局退款时：
        1. 从事件参数提取对局 ID
        2. 调用 game_manager.update_game_result_from_chain 同步到本地（is_draw=True）
        """
        # TODO: 合约 ABI 就绪后实现
        # 延迟导入以避免循环依赖
        from rps_core.service.game_service import game_manager
        from rps_core.repository import get_game_by_chain_id

        print(f"[DrawHandled] {event_data}")
        # 示例（待 ABI 就绪后启用）：
        # args = event_data.get("args", {})
        # chain_game_id = args.get("gameId")
        # game = get_game_by_chain_id(chain_game_id)
        # if game:
        #     await game_manager.update_game_result_from_chain(
        #         game["id"], None, True, 0
        #     )

    async def sync_history_from_chain(
        self,
        address: str,
        page: int = 1,
        size: int = 20,
    ) -> List[dict]:
        """
        从链上同步玩家历史记录（降级查询方案）

        当本地数据库无记录或记录不全时，可从链上事件重建历史。
        当前合约 ABI 未就绪，暂时返回空列表，等合约部署后实现。

        Returns:
            历史对局列表，每项为对局信息字典
        """
        if not self.contract:
            return []

        # TODO: 合约 ABI 就绪后实现
        # 示例流程：
        # 1. 查询所有 GameCreated / GameSettled 事件
        # 2. 过滤出与 address 相关的对局
        # 3. 分页返回
        return []


# 全局合约服务实例
contract_service = ContractService()
