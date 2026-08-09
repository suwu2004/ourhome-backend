'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('编辑并重新生成使用生成函数返回的实际模型，不引用作用域外的 result', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/messages/:id/edit-and-regenerate'");
  const routeEnd = source.indexOf("app.get('/settings'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const route = source.slice(routeStart, routeEnd);

  assert.match(route, /model:\s*modelName/);
  assert.doesNotMatch(route, /model:\s*result\?\.model/);
});
