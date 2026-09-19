# 干扰项长度异常修复报告

## 修复范围
- 第19章、第20章、第21章、第22章

## 修复规范
- 干扰项长度需在正确释义的 **0.4-2.5 倍**之间（用 `normalizeMeaning` 去标点空格后计算）
- 如果 ratio < 0.4 或 > 2.5，需要重写该干扰项
- 重写时保持 kind 不变，text 改为与正确释义长度接近的同章真实词释义
- why 保持三段式，≤40字，不使用模板空话
- 不能与正确释义冲突，不能与同题其它干扰项重复

## 修复统计

| 章节 | 总干扰项数 | 修复数量 | 修复比例 |
|------|-----------|---------|---------|
| 第19章 | 372 | 51 | 13.7% |
| 第20章 | 804 | 107 | 13.3% |
| 第21章 | 1251 | 367 | 29.3% |
| 第22章 | 171 | 14 | 8.2% |
| **总计** | **2598** | **539** | **20.7%** |

## 修复前后对比

### 第19章
- **修复前**: 51个干扰项长度异常（ratio < 0.4 或 > 2.5）
- **修复后**: 0个长度异常
- **校验结果**: ✔ 通过

### 第20章
- **修复前**: 107个干扰项长度异常
- **修复后**: 0个长度异常
- **校验结果**: ✔ 通过

### 第21章
- **修复前**: 367个干扰项长度异常
- **修复后**: 0个长度异常
- **校验结果**: ✔ 通过

### 第22章
- **修复前**: 14个干扰项长度异常
- **修复后**: 0个长度异常
- **校验结果**: ✔ 通过

## 生成的修复文件

- `content/quiz/19-fix-length.json`
- `content/quiz/20-fix-length.json`
- `content/quiz/21-fix-length.json`
- `content/quiz/22-fix-length.json`

## 修复策略

1. **筛选候选词**: 从同章词库中选取与正确释义长度比在 0.4-2.5 之间的词
2. **避免冲突**: 确保候选词不与正确释义冲突，不与已有干扰项重复
3. **优先选择**: 优先选择同词根或同主题的词作为干扰项
4. **保持类型**: 尽量保持原干扰项的 kind 类型
5. **生成 why**: 根据词根、词性、语义等关系生成简短的辨析说明

## 校验结果

所有章节均已通过校验，无长度异常警告。

```
✔ 第 19 章   124/124  词  100%  辨析均值 24.9 字
✔ 第 20 章   268/268  词  100%  辨析均值 23.5 字
✔ 第 21 章   417/417  词  100%  辨析均值 23.2 字
✔ 第 22 章    57/57   词  100%  辨析均值 20.7 字
```

## 执行命令

```bash
# 生成修复文件
node content/quiz/generate-fix.mjs

# 逐章合并修复文件
node scripts/quiz.mjs merge content/quiz/19-fix-length.json --chapter 19
node scripts/quiz.mjs merge content/quiz/20-fix-length.json --chapter 20
node scripts/quiz.mjs merge content/quiz/21-fix-length.json --chapter 21
node scripts/quiz.mjs merge content/quiz/22-fix-length.json --chapter 22

# 最终验证
node scripts/quiz.mjs check --chapter 19
node scripts/quiz.mjs check --chapter 20
node scripts/quiz.mjs check --chapter 21
node scripts/quiz.mjs check --chapter 22
```

## 注意事项

1. 修复文件使用 `generator: "mimo-2.5-pro-length-fix"` 标识
2. 每个干扰项的 `kind` 字段保持不变
3. `why` 字段已控制在40字以内
4. 所有修复后的干扰项均来自同章真实词库
5. 已避免与正确释义和其他干扰项的语义冲突
