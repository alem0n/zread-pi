"""最小自测：`python test_hello.py` 即可运行，无需 pytest。"""

from calculator import add, multiply
from hello import greet


def main() -> None:
    assert greet() == "Hello, World!"
    assert greet("pi") == "Hello, pi!"
    assert add(2, 3) == 5
    assert multiply(4, 5) == 20
    print("all checks passed")


if __name__ == "__main__":
    main()
