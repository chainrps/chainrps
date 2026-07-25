"""
通用工具函数

提供项目各模块共用的工具函数，包括时间处理、地址校验、ID 生成等。
"""
import time
import uuid
from datetime import datetime


def now_timestamp() -> int:
    """获取当前时间的整数时间戳（秒）"""
    return int(time.time())


def now_iso() -> str:
    """获取当前 UTC 时间的 ISO 格式字符串"""
    return datetime.utcnow().isoformat()


def calculate_deadline(timeout: int) -> float:
    """根据超时时长（秒）计算截止时间戳"""
    return time.time() + timeout


def deadline_to_iso(timestamp: float) -> str:
    """将时间戳转换为 UTC 的 ISO 格式字符串"""
    return datetime.utcfromtimestamp(timestamp).isoformat()


def validate_address(address: str) -> bool:
    """简单校验以太坊地址格式：以 0x 开头且总长度为 42 字符"""
    if not isinstance(address, str):
        return False
    if not address.startswith("0x"):
        return False
    if len(address) != 42:
        return False
    # 校验 0x 后续部分是否为合法十六进制
    try:
        int(address[2:], 16)
    except ValueError:
        return False
    return True


def generate_match_id() -> str:
    """生成唯一的匹配 ID（基于 uuid4）"""
    return str(uuid.uuid4())


def safe_float(value, default: float = 0.0) -> float:
    """安全地将任意值转换为 float，转换失败时返回默认值"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def paginate(page: int, size: int) -> tuple[int, int]:
    """根据页码和每页大小计算分页的 (offset, limit)"""
    # 页码从 1 开始，小于 1 时按 1 处理
    if page < 1:
        page = 1
    # 每页大小至少为 1
    if size < 1:
        size = 1
    offset = (page - 1) * size
    limit = size
    return offset, limit
