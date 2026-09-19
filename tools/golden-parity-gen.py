#!/usr/bin/env python3
"""
黄金值生成器：用 lecture-to-notes 的 Python 参考实现在固定输入上跑出基准值。

供 zread-pi 的 test/golden-parity.ts 对照（plan.md §5.5 一致性校验）。
TS 实现必须在**同一输入**上复现这些值，否则判定语义发生了漂移。

可复现：python3 tools/golden-parity-gen.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, r"C:\Users\user\Desktop\code\lecture-to-notes\scripts")

from verify_notes import CJK  # noqa: E402  （源：scripts/verify_notes.py:38）
from extract_claims import numbers_in, flatten_tex  # noqa: E402

# 与 test/golden-parity.ts 逐字一致的样本（任何改动必须两边同步）
SAMPLES = {
    "s1_pure_ascii": "Hello world 42",
    "s2_pure_cjk": "读者优先写作纪律",
    "s3_mixed": "Agent 封装了用户意图，协调 AI 与设备操作",
    "s4_ext_bmp": "𠀀 罕见扩展区汉字",
    "s5_emoji_punct": "🎉 重要提示：100%",
    "s6_code_like": "const x = createAgent({ model: 'gpt' });  // 创建 Agent",
}

# flatten_tex 的可比口径：剥离后「数学定界符 / 宏 / 空白」的归一化文本
FLATTEN_INPUT = r"\begin{document}裸文本 \SI{100}{\percent} 与 $x^2$ 公式\end{document}"

out = {
    "cjk_counts": {key: len(CJK.findall(text)) for key, text in SAMPLES.items()},
    "flatten_tex": flatten_tex(FLATTEN_INPUT),
    "flatten_numbers": numbers_in(flatten_tex(FLATTEN_INPUT)),
    "source_files": {
        "verify_notes.py::CJK": "re.compile(r'[一-鿿]')  # U+4E00..U+9FFF",
        "extract_claims.py::flatten_tex": "剥离 LaTeX 宏 / 数学定界符 / 空白归一化",
        "extract_claims.py::numbers_in": r"re.findall(r'\d+(?:[.,]\d+)*', value)",
    },
}

print(json.dumps(out, ensure_ascii=False, indent=2))
