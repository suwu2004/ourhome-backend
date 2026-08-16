'use strict';

const express = require('express');
const {
  getDrawingConfig,
  saveDrawingConfig,
  listDrawingHistory,
  generateDrawing,
  deleteDrawing,
  downloadDrawing,
} = require('./drawingService');

const originalListen = express.application.listen;
let registered = false;

function errorStatus(error) {
  const message = String(error?.message || '');
  if (/没有保存密钥|没有启用|还没有启用/.test(message)) return 400;
  if (/找不到/.test(message)) return 404;
  if (/超时|timeout/i.test(message)) return 504;
  return 500;
}

function registerDrawingRoutes(app) {
  if (registered) return;
  registered = true;

  app.get('/drawing/config', async (req, res) => {
    try { res.json(await getDrawingConfig()); }
    catch (error) { res.status(500).json({ error: error.message || '读取画画 API 配置失败' }); }
  });

  app.put('/drawing/config', async (req, res) => {
    try {
      const config = await saveDrawingConfig(req.body || {});
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: error.message || '保存画画 API 配置失败' });
    }
  });

  app.get('/drawing/history', async (req, res) => {
    try { res.json(await listDrawingHistory(req.query?.limit)); }
    catch (error) { res.status(500).json({ error: error.message || '读取小画册失败' }); }
  });

  app.post('/drawing/generate', async (req, res) => {
    try {
      const requestId = String(req.headers['x-ourhome-request-id'] || req.body?.request_id || '').trim();
      const drawing = await generateDrawing({
        prompt: req.body?.prompt,
        requestId,
        source: req.body?.source === 'chat' ? 'chat' : 'drawing-room',
      });
      res.json({ ...drawing, image_url: drawing.image });
    } catch (error) {
      console.error('[drawing:generate]', error.message);
      res.status(errorStatus(error)).json({ error: error.message || '这次没画出来' });
    }
  });

  app.delete('/drawing/history/:id', async (req, res) => {
    try { res.json(await deleteDrawing(req.params.id)); }
    catch (error) { res.status(errorStatus(error)).json({ error: error.message || '删除画作失败' }); }
  });

  app.get('/drawing/history/:id/download', async (req, res) => {
    try {
      const file = await downloadDrawing(req.params.id);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'private, max-age=0');
      res.send(file.buffer);
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error.message || '下载画作失败' });
    }
  });
}

express.application.listen = function drawingRoutePatchedListen(...args) {
  registerDrawingRoutes(this);
  return originalListen.apply(this, args);
};

module.exports = { registerDrawingRoutes };
