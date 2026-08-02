"""
ChainRPS Bot 出拳策略模块

提供 5 种出拳策略：
- random: 随机策略，均匀概率选择石头/布/剪刀
- aggressive: 激进策略，倾向石头(40%)和布(40%)
- conservative: 保守策略，倾向剪刀(40%)和石头(35%)
- mimic: 模仿策略，固定选择某一出拳（默认石头）
- balanced: 均衡策略，动态调整，排除最近输过的类型

choice 映射: 1=石头(ROCK), 2=布(PAPER), 3=剪刀(SCISSORS)
"""
import secrets
from typing import List, Optional


VALID_STRATEGIES = ["random", "aggressive", "conservative", "mimic", "balanced"]


def generate_choice(strategy: str = "random", history: Optional[List[int]] = None,
                     mimic_choice: int = 1) -> int:
    """
    根据策略生成出拳

    Args:
        strategy: 策略名称 (random/aggressive/conservative/mimic/balanced)
        history: 最近出拳记录（用于 balanced 策略）
        mimic_choice: mimic 策略的固定出拳 (默认 1=石头)

    Returns:
        1=石头, 2=布, 3=剪刀
    """
    if strategy == "random":
        return _strategy_random()
    elif strategy == "aggressive":
        return _strategy_aggressive()
    elif strategy == "conservative":
        return _strategy_conservative()
    elif strategy == "mimic":
        return _strategy_mimic(mimic_choice)
    elif strategy == "balanced":
        return _strategy_balanced(history or [])
    else:
        return _strategy_random()


def get_strategy_info() -> List[dict]:
    """获取所有策略的描述信息"""
    return [
        {
            "id": "random",
            "name": "随机策略",
            "description": "均匀随机选择石头/布/剪刀，等概率",
            "style": "稳健",
        },
        {
            "id": "aggressive",
            "name": "激进策略",
            "description": "倾向石头(40%)和布(40%)，剪刀(20%)",
            "style": "高频大额",
        },
        {
            "id": "conservative",
            "name": "保守策略",
            "description": "倾向剪刀(40%)和石头(35%)，布(25%)",
            "style": "低频小额",
        },
        {
            "id": "mimic",
            "name": "模仿策略",
            "description": "固定选择某一出拳（可配置，默认石头）",
            "style": "固定出拳",
        },
        {
            "id": "balanced",
            "name": "均衡策略",
            "description": "动态调整，最近输了的出拳下次排除",
            "style": "学习型",
        },
    ]


# ==================== 策略实现 ====================

def _strategy_random() -> int:
    """随机策略: 均匀概率"""
    return secrets.randbelow(3) + 1


def _strategy_aggressive() -> int:
    """激进策略: 石头40%, 布40%, 剪刀20%"""
    r = secrets.randbelow(100)
    if r < 40:
        return 1  # 石头
    elif r < 80:
        return 2  # 布
    else:
        return 3  # 剪刀


def _strategy_conservative() -> int:
    """保守策略: 剪刀40%, 石头35%, 布25%"""
    r = secrets.randbelow(100)
    if r < 40:
        return 3  # 剪刀
    elif r < 75:
        return 1  # 石头
    else:
        return 2  # 布


def _strategy_mimic(fixed_choice: int = 1) -> int:
    """模仿策略: 固定出拳"""
    if fixed_choice not in [1, 2, 3]:
        fixed_choice = 1
    return fixed_choice


def _strategy_balanced(history: List[int]) -> int:
    """
    均衡策略: 排除最近输过的类型

    如果有历史记录，排除最近 3 次中出现过的出拳，
    从剩余选项中随机选择。
    """
    if len(history) >= 3:
        recent = history[-3:]
        candidates = [1, 2, 3]
        for h in recent:
            if h in candidates:
                candidates.remove(h)
        if candidates:
            return candidates[secrets.randbelow(len(candidates))]

    return secrets.randbelow(3) + 1