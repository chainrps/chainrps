"""
服务层模块

集中暴露 ChainRPS 后端的业务服务实例，供 API 层调用。
本层仅负责业务编排（匹配撮合、状态记录、事件同步），
不参与胜负判定与结算（由链上合约完成）。

模块组成：
- matching_service：匹配撮合与超时提醒
- game_service：对局状态记录与通知
- contract_service：链上合约事件监听与同步
"""
from rps_core.service.matching_service import match_manager, MatchManager
from rps_core.service.game_service import game_manager, GameManager
from rps_core.service.contract_service import contract_service, ContractService

__all__ = [
    "match_manager",
    "MatchManager",
    "game_manager",
    "GameManager",
    "contract_service",
    "ContractService",
]
