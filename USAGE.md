# CodeGraph 使用说明

这是一份简短的本地使用指南，适合刚把项目拉下来后快速跑起来。

## 这个项目是做什么的

CodeGraph 会扫描一个代码仓库，用 tree-sitter 解析代码结构，并把文件、符号、调用关系、依赖关系存到本地 SQLite 数据库里。AI 编程工具可以通过 MCP 读取这些信息，从而更快理解项目。

简单说：它是给 Codex、Cursor、Claude Code、opencode 等 agent 用的本地代码知识图谱。

## 环境要求

- Node.js：`>=20.0.0 <25.0.0`
- npm
- Git

当前仓库使用 `package-lock.json`，所以推荐用 npm 安装依赖。

## 安装依赖

在项目根目录运行：

```bash
npm ci
```

如果只是日常开发，不要提交 `node_modules/`，它已经在 `.gitignore` 里。

## 构建项目

```bash
npm run build
```

构建成功后会生成 `dist/`。这个目录也是构建产物，通常不提交。

## 运行本地 CLI

构建后可以运行：

```bash
npm run cli
```

或者直接运行构建后的入口：

```bash
node dist/bin/codegraph.js --help
```

常见命令：

```bash
codegraph install   # 把 CodeGraph 接到支持的 agent
codegraph init      # 在当前项目生成 .codegraph/ 索引
codegraph status    # 查看索引和数据库状态
codegraph sync      # 手动同步索引
codegraph uninit    # 删除当前项目的 .codegraph/ 数据
codegraph uninstall # 从 agent 配置里移除 CodeGraph
```

如果你是在开发当前源码仓库，优先用 `npm run cli` 或 `node dist/bin/codegraph.js` 测本地构建。

## 开发常用命令

```bash
npm run dev          # TypeScript watch 模式
npm test             # 运行全部测试
npm run test:watch   # 测试 watch 模式
npm run test:eval    # 运行 evaluation 测试
npm run clean        # 删除 dist/
```

运行单个测试文件示例：

```bash
npx vitest run __tests__/installer-targets.test.ts
```

按测试名过滤：

```bash
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

## 正常使用流程

如果你是作为用户使用 CodeGraph，一般流程是：

1. 安装 CLI。
2. 运行 `codegraph install`，连接 Codex、Cursor、Claude Code 等 agent。
3. 进入你要分析的项目目录。
4. 运行 `codegraph init`。
5. 之后让 agent 正常工作，它会通过 MCP 使用 CodeGraph。

项目索引会放在目标项目的 `.codegraph/` 目录里。

## 修改代码时要注意

- 改 CLI、MCP、安装器后，记得补测试。
- 改 `src/installer/` 通常需要更新 `__tests__/installer-targets.test.ts`。
- 改 agent 工具说明时，主要改 `src/mcp/server-instructions.ts`。
- 不要提交 `node_modules/`、`dist/`、`.codegraph/`。

## 快速检查

开发完成后，至少跑：

```bash
npm run build
npm test
```

如果只改了很小的地方，也可以先跑相关测试文件，再视情况跑全量测试。
