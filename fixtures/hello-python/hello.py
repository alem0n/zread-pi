"""极简 Python Hello World —— 用于测试的最小可运行项目。"""

GREETING = "Hello, World!"


def greet(name: str = "World") -> str:
    """返回问候语，默认问候 World。"""
    return f"Hello, {name}!"


def main() -> None:
    """入口：打印问候语。"""
    print(greet())


if __name__ == "__main__":
    main()
