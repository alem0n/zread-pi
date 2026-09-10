# hello-python

极简 Python Hello World 项目，是 `open-zread-pi` 的最小测试夹具（fixture），用于验证文档生成流水线：
目录扫描 → AST 解析 → 蓝图 `wiki.json` → 并行页面生成。

## 结构

| 文件 | 作用 |
| --- | --- |
| `hello.py` | 入口：`greet()` 返回问候语，`main()` 打印 |
| `calculator.py` | 最小计算模块：`add()` / `multiply()` |
| `test_hello.py` | 无依赖自测（assert + 打印） |
| `pyproject.toml` | 最小项目元数据 |

## 运行

```bash
python hello.py        # 输出：Hello, World!
python test_hello.py   # 输出：all checks passed
```

## 作为文档生成流水线的测试靶子

```bash
cd ../..                # 回到 open-zread-pi 工程根

# 1) 离线全链路（mock LLM，不需要 API Key）——默认目标就是本夹具
bun run mock:wiki

# 2) 只验证扫描 + AST 解析（Tree-sitter Python）
bun run test:analyzer

# 3) 真机生成 Wiki（先在 ~/.zread/config.yaml 配置 LLM）
bun run cli
```

已验证的预期结果：

- **扫描**：识别 `hello.py` / `calculator.py` / `test_hello.py` 为 `python`；
- **解析**：提取 `greet(name: str = "World") -> str`、`main() -> None`、`add(a: int, b: int) -> int`、`multiply(...)` 等签名；
- **生成**：`.open-zread/wiki/wiki.json` + `.open-zread/wiki/模块/*.md`（离线试跑为 4 页）。
