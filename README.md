# OurHome 后端

OurHome 的 Express 服务端。聊天、时光信差、记忆、日历、猫の金库、API 站点档案、Tavily 联网搜索和远程 MCP 都由这里接入 Supabase。

## 本地运行

```bash
npm ci
cp .env.example .env
npm start
```

建议使用 Node.js 22。把 `.env` 中的必填项补全后，访问 `http://localhost:3000/` 应返回健康状态。

## 必填环境变量

- `SUPABASE_URL`：Supabase 项目 URL。
- `SUPABASE_KEY`：仅服务端使用的 `service_role` key，绝不能放进前端。
- `APP_PASSWORD`：OurHome 登录密码。
- `APP_TOKEN_SECRET`：登录令牌签名密钥，建议至少 32 个随机字节。

API 密钥不再需要放入部署平台：登录 OurHome 后，在“设置 → API 站点档案”里保存即可。密钥正文存于 Supabase Vault，浏览器只能看到“已保存”状态。

推送通知默认会在首次启动时生成一对新的 VAPID 密钥，并加密保存到 Supabase Vault，后续部署会继续使用同一对密钥。也可以用环境变量 `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` 显式覆盖。手动生成方式：

```bash
npx web-push generate-vapid-keys
```

旧代码中曾出现过的私钥应视为已泄露，不能再使用。前端检测到公钥变化时会自动取消旧订阅并重新订阅。

## 数据库

新项目依次执行：

1. `database/ourhome_connections.sql`
2. `database/ourhome_search_and_security.sql`
3. `supabase/migrations/20260719084259_ourhome_runtime_secrets.sql`
4. `supabase/migrations/20260719115916_sync_cat_vault.sql`
5. `supabase/migrations/20260719121339_index_vault_account_groups.sql`

现有 OurHome 数据库已经应用过这些迁移。金库迁移会复用旧的 `vault_*` 表，补齐账户分组、流水快照、手机旧账本导入标记和原子记账函数；所有金库表都只允许服务端角色访问。

## OurHome 操作权限

- 页面和聊天助手通过同一个后端金库服务读写数据，新增/修改/删除后都会反映到 Supabase。
- 第一次打开猫の金库时，前端会把原有 `localStorage` 账本迁入云端，并继续保留一份本机副本。
- 聊天助手可以管理金库、记忆、信件、心情记录、日程、心愿和重要时刻。
- “设置”不会暴露为聊天工具；API 密钥、站点、模型、联网、MCP、人物设定和视觉设置只能由用户在设置页操作。

## Render 部署

仓库根目录的 `render.yaml` 可以直接作为 Blueprint 使用。已有 Render 服务则在 Dashboard 中补齐 `.env.example` 对应变量，再部署当前提交。推荐顺序：

1. 先部署后端并确认根地址返回 `status: ok`。
2. 再部署前端，并把前端 `VITE_BACKEND_URL` 指向这个 HTTPS 地址。
3. 登录设置页，测试当前 API 站点、Tavily 和 MCP。

## 联网与 MCP

- 联网搜索：设置页填写 Tavily API key，保存后点“测试搜索”。模型在需要实时资料时会获得 `web_search` 工具。
- MCP：只支持公网 HTTPS 的 Streamable HTTP endpoint，例如 `https://example.com/mcp`；当前认证方式是可选 Bearer Token。
- 为了避免模型意外写入外部系统，只会暴露声明了 `annotations.readOnlyHint: true` 的工具。
- 本机 `stdio` MCP 无法由云端 OurHome 直接连接，需要先部署成远程 HTTP 服务。

完整说明见 [MCP_DEPLOYMENT.md](./MCP_DEPLOYMENT.md)。
