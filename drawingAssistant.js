'use strict';

const crypto = require('node:crypto');
const {
  listDrawingHistory,
  generateDrawing,
  deleteDrawing,
} = require('./drawingService');

const CHAT_DEDUP_MS = 2 * 60 * 1000;
const recentGenerations = new Map();

const DRAWING_ASSISTANT_TOOLS = Object.freeze([
  {
    name: 'read_drawing_room',
    description: '读取 OurHome「画画」里的小画册，查看最近真实生成过的画、提示词和时间。用户问最近画了什么、那张画还在不在、想让你参考小画册时使用。画室和光影相册彼此独立，不要把画室内容说成已经进入相册。',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '读取最近多少张，默认12' },
      },
      required: [],
    },
  },
  {
    name: 'create_drawing',
    description: '在 OurHome「画画」里真实生成一张图片并保存到小画册。只有两种情况可以调用：①叶檀当前明确要求你画、生成图片或说“画吧/可以画”等明确授权；②你此前主动提出想画，她随后明确同意。若只是你自己突然产生画画念头，先在聊天里自然问她，得到同意前绝对不要调用。一次授权默认只生成一张，不要为了“试试看”或追求更好效果擅自重复调用。',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '实际送给生图模型的完整中文提示词，忠实保留叶檀指定的人物、风格、构图、比例和限制' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'delete_drawing',
    description: '从画室小画册中永久删除一张真实画作和对应私有图片。只有叶檀明确要求删除某张画时调用；不确定是哪张时先读取小画册并在聊天中确认，不能凭自己审美删除。',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '小画册画作编号' },
      },
      required: ['id'],
    },
  },
]);

function cleanPrompt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function createDrawingAssistant() {
  async function readRoom(input = {}) {
    const limit = Math.max(1, Math.min(30, Number.parseInt(input.limit, 10) || 12));
    return { ok: true, room: '画画', drawings: await listDrawingHistory(limit) };
  }

  async function create(input = {}) {
    const prompt = cleanPrompt(input.prompt);
    if (!prompt) throw new Error('画画提示词不能为空');
    const now = Date.now();
    const previous = recentGenerations.get(prompt);
    if (previous && previous.expiresAt > now) return previous.promise;
    const requestId = `chat-${crypto.createHash('sha256').update(`${prompt}:${Math.floor(now / CHAT_DEDUP_MS)}`).digest('hex').slice(0, 24)}`;
    const promise = generateDrawing({ prompt, requestId, source: 'chat' })
      .then(drawing => ({
        ok: true,
        message: '已经画好并放进画室的小画册。',
        drawing,
      }));
    recentGenerations.set(prompt, { expiresAt: now + CHAT_DEDUP_MS, promise });
    try { return await promise; }
    catch (error) {
      recentGenerations.delete(prompt);
      throw error;
    }
  }

  async function remove(input = {}) {
    const result = await deleteDrawing(input.id);
    return { ...result, message: '这张画已经从小画册里删掉了。' };
  }

  async function handleTool(name, input = {}) {
    if (name === 'read_drawing_room') return readRoom(input);
    if (name === 'create_drawing') return create(input);
    if (name === 'delete_drawing') return remove(input);
    return { ok: false, error: '未知的画室工具' };
  }

  function getToolBridge() {
    const handlers = new Map();
    DRAWING_ASSISTANT_TOOLS.forEach(tool => handlers.set(tool.name, input => handleTool(tool.name, input)));
    return { tools: [...DRAWING_ASSISTANT_TOOLS], handlers };
  }

  return { getToolBridge, readRoom, create, remove };
}

module.exports = { DRAWING_ASSISTANT_TOOLS, createDrawingAssistant };
