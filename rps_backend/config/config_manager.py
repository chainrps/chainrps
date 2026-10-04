"""
ChainRPS 配置管理器

统一管理配置的加载、缓存和保存，支持多数据源：
1. config_schema.json - 配置元数据（类型、默认值、描述）
2. .env 环境变量 - 环境相关的覆盖值
3. SQLite 数据库 - 运行时存储的配置值

配置加载优先级（从低到高）：
1. JSON schema 中的默认值
2. 环境变量 .env 中的值
3. 数据库 system_config 表中的值
"""
import json
import os
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Callable

logger = logging.getLogger(__name__)


class ConfigManager:
    """
    配置管理器
    
    提供统一的配置访问接口：
    - 从 config_schema.json 加载配置定义
    - 合并环境变量和数据库覆盖
    - 支持运行时配置修改和持久化
    """

    def __init__(self):
        self._schema_path = Path(__file__).parent / "config_schema.json"
        self._schema: Dict[str, Any] = {}
        self._configs: Dict[str, Any] = {}  # {config_name: value}
        self._callbacks: List[Callable] = []  # 配置变更回调
        self._loaded = False

    def load(self) -> None:
        """
        加载所有配置
        
        加载顺序：
        1. 从 config_schema.json 读取配置定义和默认值
        2. 用环境变量覆盖默认值
        3. 用数据库中的值覆盖（如果可用）
        """
        if self._loaded:
            return

        # 1. 加载 schema
        self._load_schema()

        # 2. 用默认值初始化
        for name, config_def in self._schema.get("configs", {}).items():
            self._configs[name] = self._convert_value(
                config_def.get("default"),
                config_def.get("type", "string")
            )

        # 3. 用环境变量覆盖
        for name, config_def in self._schema.get("configs", {}).items():
            env_key = config_def.get("env_key", "")
            if env_key:
                env_value = os.getenv(env_key)
                if env_value is not None:
                    self._configs[name] = self._convert_value(
                        env_value,
                        config_def.get("type", "string")
                    )

        # 4. 用数据库值覆盖（如果数据库已初始化）
        try:
            self._load_from_database()
        except Exception as e:
            logger.debug(f"Skipping database config load: {e}")

        self._loaded = True
        logger.info(f"Configuration loaded: {len(self._configs)} items")

    def _load_schema(self) -> None:
        """加载配置 schema JSON 文件"""
        if self._schema_path.exists():
            with open(self._schema_path, "r", encoding="utf-8") as f:
                self._schema = json.load(f)
        else:
            logger.warning(f"Config schema not found: {self._schema_path}")
            self._schema = {"configs": {}, "categories": {}}

    def _load_from_database(self) -> None:
        """从数据库加载配置覆盖"""
        try:
            from rps_backend.repository import get_system_config_value

            for name, config_def in self._schema.get("configs", {}).items():
                db_key = config_def.get("key", "")
                if db_key:
                    db_value = get_system_config_value(db_key)
                    if db_value is not None:
                        self._configs[name] = self._convert_value(
                            db_value,
                            config_def.get("type", "string")
                        )
        except ImportError:
            pass  # 数据库尚未初始化

    def _convert_value(self, value: Any, type_str: str) -> Any:
        """将值转换为指定类型"""
        if value is None:
            return None

        try:
            if type_str == "string":
                return str(value)
            elif type_str == "integer":
                return int(value)
            elif type_str == "float":
                return float(value)
            elif type_str == "boolean":
                if isinstance(value, bool):
                    return value
                return str(value).lower() in ("true", "1", "yes", "on")
            elif type_str == "json":
                if isinstance(value, (dict, list)):
                    return value
                return json.loads(str(value))
            else:
                return str(value)
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            logger.warning(f"Failed to convert value '{value}' to {type_str}: {e}")
            return value

    def get(self, name: str, default: Any = None) -> Any:
        """
        获取配置值
        
        Args:
            name: 配置名称（如 'HOST', 'PORT'）
            default: 如果配置不存在时的默认返回值
            
        Returns:
            配置值，如果不存在返回 default
        """
        if not self._loaded:
            self.load()
        return self._configs.get(name, default)

    def get_all(self) -> Dict[str, Any]:
        """获取所有配置值"""
        if not self._loaded:
            self.load()
        return dict(self._configs)

    def get_config_metadata(self, name: str) -> Optional[Dict[str, Any]]:
        """获取配置元数据（类型、分类、描述等）"""
        return self._schema.get("configs", {}).get(name)

    def get_configs_by_category(self, category: str) -> Dict[str, Dict[str, Any]]:
        """按分类获取配置列表"""
        result = {}
        for name, config_def in self._schema.get("configs", {}).items():
            if config_def.get("category") == category:
                result[name] = {
                    "value": self._configs.get(name),
                    "metadata": config_def,
                }
        return result

    def get_categories(self) -> Dict[str, str]:
        """获取所有分类定义"""
        return self._schema.get("categories", {})

    def set(self, name: str, value: Any, persist: bool = True, updated_by: str = None) -> bool:
        """
        设置配置值
        
        Args:
            name: 配置名称
            value: 新值
            persist: 是否持久化到数据库
            updated_by: 更新者
            
        Returns:
            是否设置成功
        """
        config_def = self._schema.get("configs", {}).get(name)
        if not config_def:
            logger.warning(f"Unknown config key: {name}")
            return False

        if config_def.get("readonly", False):
            logger.warning(f"Config key is readonly: {name}")
            return False

        # 转换并验证值
        converted_value = self._convert_value(value, config_def.get("type", "string"))
        self._configs[name] = converted_value

        # 持久化到数据库
        if persist:
            try:
                from rps_backend.repository import set_system_config
                db_key = config_def.get("key", "")
                set_system_config(db_key, str(converted_value), updated_by=updated_by)
            except ImportError:
                logger.debug(f"Cannot persist config {name}: database not available")

        # 触发回调
        self._fire_callbacks(name, converted_value)

        return True

    def batch_set(self, configs: Dict[str, Any], persist: bool = True, updated_by: str = None) -> Dict[str, bool]:
        """
        批量设置配置
        
        Args:
            configs: {name: value} 字典
            persist: 是否持久化
            updated_by: 更新者
            
        Returns:
            {name: success} 结果字典
        """
        results = {}
        for name, value in configs.items():
            results[name] = self.set(name, value, persist=persist, updated_by=updated_by)
        return results

    def get_schema(self) -> Dict[str, Any]:
        """获取完整的配置 schema"""
        return self._schema

    def register_callback(self, callback: Callable) -> None:
        """
        注册配置变更回调
        
        Args:
            callback: 回调函数，签名为 callback(name: str, value: Any)
        """
        self._callbacks.append(callback)

    def _fire_callbacks(self, name: str, value: Any) -> None:
        """触发所有回调"""
        for callback in self._callbacks:
            try:
                callback(name, value)
            except Exception as e:
                logger.error(f"Config callback error: {e}")

    def reset_to_defaults(self, name: str = None, updated_by: str = None) -> bool:
        """
        重置配置为默认值
        
        Args:
            name: 配置名称，None 表示重置所有
            updated_by: 更新者
            
        Returns:
            是否重置成功
        """
        configs = self._schema.get("configs", {})
        
        if name:
            if name not in configs:
                return False
            configs_to_reset = {name: configs[name]}
        else:
            configs_to_reset = configs

        for cfg_name, config_def in configs_to_reset.items():
            if not config_def.get("readonly", False):
                default_value = config_def.get("default")
                self.set(cfg_name, default_value, persist=True, updated_by=updated_by)

        return True

    def export_configs(self) -> Dict[str, Any]:
        """导出所有配置（包含元数据）"""
        result = {}
        for name, config_def in self._schema.get("configs", {}).items():
            result[name] = {
                "value": self._configs.get(name),
                "type": config_def.get("type"),
                "category": config_def.get("category"),
                "description": config_def.get("description"),
                "default": config_def.get("default"),
                "readonly": config_def.get("readonly", False),
            }
        return result


# 全局配置管理器实例
config_manager = ConfigManager()


def init_config() -> None:
    """初始化配置（在应用启动时调用）"""
    config_manager.load()


def get_config(name: str, default: Any = None) -> Any:
    """获取配置值的便捷函数"""
    return config_manager.get(name, default)


def get_all_configs() -> Dict[str, Any]:
    """获取所有配置的便捷函数"""
    return config_manager.get_all()
