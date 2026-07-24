# 微信 AI Bot

一个仅供个人使用的微信 iLink 文本机器人。服务通过 `wechat-ilink-client` 长轮询接收微信消息，调用 OpenAI-compatible Chat Completions API，并用 SQLite 保存所有者和最近对话。它不开放 HTTP 端口，也不包含工具调用、联网搜索或管理后台。

## 架构

```text
微信 iLink Bot
  -> wechat-ilink-client
  -> Node.js 22 + TypeScript
  -> OpenAI-compatible API
  -> SQLite + 本地微信凭据
```

## 环境要求

- Node.js 22；或 Docker 27+ 与 Docker Compose v2
- 可访问微信 iLink 和所配置模型 API 的网络
- 一个 OpenAI-compatible API Key、Base URL（可选）和模型名

## 本地安装

```bash
cd services/wechat-ai-bot
npm install
cp .env.example .env
npm run typecheck
npm test
npm run dev
```

首次运行会在终端打印二维码。扫码并确认后，登录凭据写入 `credentials/session.json`，长轮询游标写入 `credentials/sync.buf`。

## 环境变量

| 变量 | 必填 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | 是 | - | 模型 API Key |
| `OPENAI_BASE_URL` | 否 | OpenAI SDK 默认地址 | OpenAI-compatible API 地址 |
| `OPENAI_MODEL` | 是 | - | 模型名称 |
| `SYSTEM_PROMPT_FILE` | 否 | `./persona.md` | 人格提示词路径 |
| `DATABASE_PATH` | 否 | `./data/bot.db` | SQLite 路径 |
| `WECHAT_CREDENTIALS_DIR` | 否 | `./credentials` | 微信凭据和轮询游标目录 |
| `BOOTSTRAP_OWNER_ON_FIRST_MESSAGE` | 否 | `true` | 无所有者时绑定首位文本消息发送者 |
| `ALLOWED_USER_ID` | 否 | 空 | 明确指定唯一允许用户，优先级最高 |
| `LLM_TIMEOUT_MS` | 否 | `60000` | 单次模型请求超时 |
| `LLM_MAX_RETRIES` | 否 | `2` | 网络错误、429、5xx 的最大重试次数 |
| `CONTEXT_MAX_MESSAGES` | 否 | `30` | 最近上下文消息上限 |
| `CONTEXT_MAX_CHARS` | 否 | `30000` | 上下文字符粗略上限 |
| `OUTGOING_MESSAGE_MAX_CHARS` | 否 | `1800` | 单条微信回复字符上限 |

`persona.md` 不存在或为空时，服务会记录警告并使用简短的内置提示词。

## 首次绑定

默认情况下，数据库没有 `owner_user_id` 时，第一位发来文本消息的人会被永久绑定为所有者。完成扫码后，请立即由本人向 Bot 发送第一条文本消息。不要在绑定完成前把 Bot 暴露给其他人；否则他人可能先完成绑定。

设置 `ALLOWED_USER_ID` 可以跳过首次抢占风险。环境变量存在时，它始终优先于数据库中的所有者。普通聊天消息无法更换所有者，非所有者消息不会调用模型。

## Docker 首次启动与扫码

```bash
cd services/wechat-ai-bot
cp .env.example .env
docker compose up --build
```

保持前台日志可见并扫码。若服务已在后台运行：

```bash
docker compose logs -f wechat-ai-bot
```

二维码有时会因日志窗口宽度不足而变形，请扩大终端宽度后重新查看。二维码过期时客户端会自动生成新的二维码。扫码成功后按 `Ctrl+C` 停止前台进程，再执行：

```bash
docker compose up -d
docker compose logs --tail=100 wechat-ai-bot
```

Compose 使用 `restart: unless-stopped`，服务器或 Docker 重启后会自动恢复。无需开放公网端口。

## 聊天命令

- `/help`：显示命令列表
- `/status`：显示模型名、已保存的上下文消息数和运行状态，不显示密钥
- `/reset`：清空所有者的对话历史，保留所有权与微信登录

命令会忽略首尾空格，不会发送给模型。

## 数据与安全

- `data/bot.db`：所有者绑定、消息历史和去重记录
- `credentials/session.json`：微信 token、账户 ID 和 API 基址
- `credentials/sync.buf`：长轮询游标
- `.env`：模型 API 配置
- `persona.md`：system prompt

`.env`、SQLite 文件和微信凭据均被 Git 忽略。日志只记录脱敏用户 ID和消息字符数，不记录正文、API Key、微信 token、cookie 或二维码 URL。请把远程目录权限限制为当前用户，不要共享 `.env`、`data/` 或 `credentials/`。

## 更新部署

将新代码同步到服务器后执行：

```bash
cd /home/ubuntu/zxlab/wechat-ai-bot
docker compose build --pull
docker compose up -d
docker compose logs --tail=100 wechat-ai-bot
```

数据和凭据使用宿主机目录挂载，重建容器不会丢失登录和对话。

## 重置登录与更换所有者

重置微信登录会删除当前凭据和游标，随后需要重新扫码：

```bash
cd /home/ubuntu/zxlab/wechat-ai-bot
docker compose down
rm credentials/session.json credentials/sync.buf
docker compose up
```

更换所有者有两种方式：

1. 推荐：在 `.env` 设置明确的 `ALLOWED_USER_ID`，然后 `docker compose up -d --force-recreate`。
2. 删除数据库中的绑定：先停止容器，备份 `data/bot.db`，用 SQLite 删除 `settings` 表中 `key='owner_user_id'` 的记录，再启动并由本人立即发送第一条消息。

不要通过聊天内容尝试覆盖所有者；代码不会接受这种操作。

## 故障排查

- 没出现二维码：检查 `credentials/session.json` 是否已存在；如需重新登录，按上节步骤删除凭据。
- 二维码无法识别：扩大终端宽度，执行 `docker compose restart` 后重新跟随日志。
- 模型服务不可用：检查 `.env` 中的 Key、Base URL、模型名，以及远程机到 API 的网络。
- 收到消息但没有回复：检查首位所有者是否绑定错误，以及 `ALLOWED_USER_ID` 是否与发送者一致。
- 会话过期：服务会清理旧凭据并在日志中生成新二维码；执行 `docker compose logs -f` 完成扫码。
- 原生 SQLite 构建失败：使用提供的 Dockerfile；构建阶段已包含 `python3`、`make` 和 `g++`。

## 已知限制

第一版仅处理一位用户的文本消息。图片、语音、文件和视频被安全忽略；不支持群聊治理、流式回复、工具调用、联网搜索、向量检索或 Web 管理。微信 iLink 是持续演进的协议，升级 `wechat-ilink-client` 前应重新检查其 README 和类型定义并完成扫码、收发消息回归测试。
