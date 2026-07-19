const dns = require('dns').promises;
const net = require('net');

const MCP_VERSION = '2025-11-25';
const SUPPORTED_MCP_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const MCP_TIMEOUT_MS = 20_000;
const MAX_TOOL_OUTPUT_CHARS = 30_000;

function isPrivateIp(address) {
  if (!address) return true;
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  if (!net.isIPv4(address)) return false;
  const parts = address.split('.').map(Number);
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

async function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('远程地址格式不正确'); }
  if (url.protocol !== 'https:') throw new Error('远程 MCP 必须使用 HTTPS');
  if (url.username || url.password) throw new Error('请把认证信息放在 Token 中，不要写进网址');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('不能连接本机或局域网地址');
  const addresses = net.isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateIp(item.address))) throw new Error('不能连接本机、局域网或云主机元数据地址');
  return url.toString();
}

function parseMcpBody(text, requestId) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const messages = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (!payload) return;
    try { messages.push(JSON.parse(payload)); } catch { /* ignore keep-alive events */ }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    else if (!line.trim()) flush();
  }
  flush();
  return messages.find(message => message.id === requestId) || messages.at(-1) || null;
}

function sanitizeToolName(value) {
  return String(value || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 44);
}

function truncateJson(value) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return value;
  return { truncated: true, content: serialized.slice(0, MAX_TOOL_OUTPUT_CHARS) };
}

function createIntegrationManager(runtimeConfig) {
  const mcpSessions = new Map();
  const mcpToolCache = new Map();
  let requestId = 1;

  async function mcpPost(connection, method, params, { notification = false, retry = true } = {}) {
    const endpoint = await validateRemoteUrl(connection.url);
    const session = mcpSessions.get(connection.id);
    const id = notification ? undefined : requestId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': method,
    };
    if ((method === 'tools/call' || method === 'resources/read' || method === 'prompts/get') && params?.name) {
      headers['Mcp-Name'] = params.name;
    }
    if (connection.secret) headers.Authorization = `Bearer ${connection.secret}`;
    if (session?.sessionId) headers['MCP-Session-Id'] = session.sessionId;
    if (session?.protocolVersion && method !== 'initialize') headers['MCP-Protocol-Version'] = session.protocolVersion;
    const payload = { jsonrpc: '2.0', method };
    if (!notification) payload.id = id;
    if (params !== undefined) payload.params = params;

    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      if (response.status === 404 && session?.sessionId && retry) {
        mcpSessions.delete(connection.id);
        await ensureMcpInitialized(connection);
        return mcpPost(connection, method, params, { notification, retry: false });
      }
      const text = await response.text();
      if (!response.ok && response.status !== 202) throw new Error(`MCP ${response.status}: ${text.slice(0, 500)}`);
      if (notification) return null;
      const message = parseMcpBody(text, id);
      if (!message) throw new Error('MCP 没有返回可读取的 JSON-RPC 响应');
      if (message.error) throw new Error(message.error.message || 'MCP 调用失败');
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) mcpSessions.set(connection.id, { ...(mcpSessions.get(connection.id) || {}), sessionId });
      return message.result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('MCP 连接超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ensureMcpInitialized(connection) {
    if (mcpSessions.get(connection.id)?.initialized) return mcpSessions.get(connection.id);
    const result = await mcpPost(connection, 'initialize', {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: 'OurHome', title: 'OurHome', version: '1.0.0' },
    });
    const protocolVersion = result?.protocolVersion || MCP_VERSION;
    if (!SUPPORTED_MCP_VERSIONS.has(protocolVersion)) throw new Error(`MCP 协议版本 ${protocolVersion} 暂不支持`);
    const previous = mcpSessions.get(connection.id) || {};
    mcpSessions.set(connection.id, { ...previous, protocolVersion, initialized: true });
    await mcpPost(connection, 'notifications/initialized', undefined, { notification: true });
    return mcpSessions.get(connection.id);
  }

  async function listMcpTools(connection, { fresh = false } = {}) {
    const cached = mcpToolCache.get(connection.id);
    if (!fresh && cached && cached.updatedAt === connection.updated_at && cached.expiresAt > Date.now()) return cached.tools;
    await ensureMcpInitialized(connection);
    const result = await mcpPost(connection, 'tools/list', {});
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    const exposed = connection.config?.read_only !== false
      ? tools.filter(tool => tool.annotations?.readOnlyHint === true)
      : tools;
    mcpToolCache.set(connection.id, { tools: exposed, updatedAt: connection.updated_at, expiresAt: Date.now() + 5 * 60 * 1000 });
    return exposed;
  }

  async function callMcpTool(connection, toolName, input) {
    await ensureMcpInitialized(connection);
    const result = await mcpPost(connection, 'tools/call', { name: toolName, arguments: input || {} });
    return truncateJson(result);
  }

  async function tavilySearch(connection, input) {
    if (!connection.secret) throw new Error('Tavily 密钥还没有配置');
    const query = String(input.query || '').trim().slice(0, 400);
    if (!query) throw new Error('搜索关键词不能为空');
    const maxResults = Math.min(10, Math.max(1, Number(input.max_results || connection.config?.max_results || 5)));
    const body = {
      query,
      topic: input.topic === 'news' ? 'news' : 'general',
      search_depth: connection.config?.search_depth || 'advanced',
      max_results: maxResults,
      include_answer: true,
      include_raw_content: false,
    };
    if (body.topic === 'news' && Number(input.days) > 0) body.days = Math.min(30, Number(input.days));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.secret}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Tavily ${response.status}: ${text.slice(0, 500)}`);
      const data = JSON.parse(text);
      return {
        answer: data.answer || null,
        results: (data.results || []).map(result => ({
          title: result.title,
          url: result.url,
          content: result.content,
          published_date: result.published_date || null,
          score: result.score,
        })),
      };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('联网搜索超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildDynamicTools() {
    const tools = [];
    const handlers = new Map();
    let connections = [];
    try { connections = await runtimeConfig.listEnabledConnectionRuntimes(); }
    catch (error) { console.error('读取联网配置失败:', error.message); }

    const web = connections.find(connection => connection.kind === 'web_search' && connection.secret);
    if (web) {
      const webTool = {
        name: 'web_search',
        description: '搜索实时互联网信息。遇到新闻、天气、价格、最新产品资料、当前人物或任何需要核实的新信息时使用，并在回答里保留来源网址。',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '清晰具体的搜索词，不超过400字' },
            topic: { type: 'string', enum: ['general', 'news'], description: '普通资料用general，新闻用news' },
            days: { type: 'integer', minimum: 1, maximum: 30, description: '新闻可限制最近天数' },
            max_results: { type: 'integer', minimum: 1, maximum: 10 },
          },
          required: ['query'],
        },
      };
      tools.push(webTool);
      handlers.set(webTool.name, input => tavilySearch(web, input));
    }

    for (const connection of connections.filter(item => item.kind === 'mcp')) {
      try {
        const remoteTools = await listMcpTools(connection);
        for (const tool of remoteTools) {
          const exposedName = `mcp_${connection.id.slice(0, 8)}_${sanitizeToolName(tool.name)}`.slice(0, 64);
          tools.push({
            name: exposedName,
            description: `[${connection.name} · 只读] ${tool.description || tool.name}`.slice(0, 900),
            input_schema: tool.inputSchema || { type: 'object', properties: {} },
          });
          handlers.set(exposedName, input => callMcpTool(connection, tool.name, input));
        }
      } catch (error) {
        console.error(`MCP ${connection.name} 读取工具失败:`, error.message);
      }
    }
    return { tools, handlers };
  }

  async function testConnection(id) {
    const connection = await runtimeConfig.getConnectionRuntime(id);
    if (!connection) throw new Error('找不到这个连接');
    if (connection.kind === 'web_search') {
      const result = await tavilySearch(connection, { query: 'OurHome connection test', max_results: 1 });
      return { ok: true, result_count: result.results.length };
    }
    if (connection.kind === 'mcp') {
      const tools = await listMcpTools(connection, { fresh: true });
      return { ok: true, tool_count: tools.length, tools: tools.map(tool => ({ name: tool.name, description: tool.description || '' })) };
    }
    throw new Error('不支持的连接类型');
  }

  return { buildDynamicTools, testConnection, validateRemoteUrl };
}

module.exports = { createIntegrationManager, validateRemoteUrl };
