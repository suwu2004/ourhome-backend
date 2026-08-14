const { outputTokenCapForModel } = require('./modelTokenLimits');

const HIGH_OUTPUT_PURPOSES = new Set(['chat']);

function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string' || typeof content === 'number') return String(content);
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        return contentText(block.text ?? block.content ?? block.value ?? '');
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    return contentText(content.text ?? content.content ?? content.value ?? '');
  }
  return '';
}

function requestText(body = {}) {
  const system = contentText(body.system);
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .map(message => contentText(message?.content))
    .filter(Boolean)
    .join('\n');
  return `${system}\n${messages}`;
}

function detectRoomScene(body = {}, purpose = '') {
  if (HIGH_OUTPUT_PURPOSES.has(String(purpose || '').trim().toLowerCase())) return 'chat';

  const text = requestText(body);
  if (!text) return null;

  if (/悄悄话|write_whisper/u.test(text)) return 'whisper';

  if (/幸福日记/u.test(text)
    || (/[<＜]日记正文[>＞]/u.test(text) && /陆泽|叶檀|今天|这一天/u.test(text))) {
    return 'happiness_diary';
  }

  if (/小剧场|小世界|小剧本|剧场书架|世界书|番外|续写/u.test(text)
    && /角色|剧情|正文|对白|场景|章节/u.test(text)) {
    return 'theater';
  }

  return null;
}

function raiseRoomOutputLimit(body = {}, purpose = '') {
  const scene = detectRoomScene(body, purpose);
  if (!scene || !body.model) {
    return {
      body,
      scene: null,
      requested: Number(body.max_tokens) || 0,
      raisedTo: Number(body.max_tokens) || 0,
    };
  }

  const requested = Number(body.max_tokens) || 0;
  const raisedTo = outputTokenCapForModel(body.model);
  return {
    body: { ...body, max_tokens: raisedTo },
    scene,
    requested,
    raisedTo,
  };
}

module.exports = {
  contentText,
  requestText,
  detectRoomScene,
  raiseRoomOutputLimit,
};
