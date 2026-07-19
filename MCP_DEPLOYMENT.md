# OurHome 连接 MCP

OurHome 在云端充当 MCP Host。它能连接远程 MCP，但不能直接启动你电脑上的 `stdio` 进程。

## MCP 服务端需要满足

1. 部署成公网可访问的 HTTPS 地址，例如 `https://your-mcp.example.com/mcp`。
2. 使用 Streamable HTTP；支持 JSON-RPC 初始化、`tools/list` 与 `tools/call`。
3. 若需要认证，当前 OurHome 支持手动填写 Bearer Token。
4. 需要给可用工具声明只读注解：

```json
{
  "annotations": {
    "readOnlyHint": true
  }
}
```

没有这个注解的工具不会显示给模型。这是刻意的安全限制，不是连接失败。

## 部署与接入顺序

1. 把 MCP 服务部署到支持长连接/流式响应的平台，得到完整 `/mcp` HTTPS 地址。
2. 在服务端配置认证、允许 OurHome 后端访问，并确认 DNS 指向公网地址。
3. 打开 OurHome → 设置 → 联网与 MCP → 添加远程 MCP。
4. 填名称、地址和可选 Token，保存。
5. 点“测试并读取工具”。返回的只读工具数量大于 0 即接入成功。
6. 回聊天中自然提出需要该工具完成的问题，模型会按需调用。

## 当前限制

- 不支持局域网地址、`localhost`、HTTP 明文地址或云主机元数据地址。
- 不支持自动 OAuth 登录流程；需要 OAuth 的服务应先提供固定的后端 Token，或增加一层你自己的授权网关。
- 只接工具（tools），暂不把 MCP resources/prompts 直接展示到 UI。
- 搜索词、工具参数和结果会经过对应的第三方服务，只连接你信任的 MCP。

协议依据：MCP `2025-11-25` Streamable HTTP，并兼容 `2025-06-18` 与 `2025-03-26` 的初始化版本。
