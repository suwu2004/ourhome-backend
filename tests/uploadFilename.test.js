const test = require('node:test');
const assert = require('node:assert/strict');
const { wrapMulterFilenameNormalization } = require('../uploadFilename');

test('multer 文件名包装会覆盖共读、聊天和小剧场后续使用的 single 中间件', async () => {
  const mojibake = Buffer.from('老婆的照片.png', 'utf8').toString('latin1');
  const upload = {
    single(fieldName) {
      return (req, _res, next) => {
        req.file = { fieldname: fieldName, originalname: mojibake };
        next();
      };
    },
  };

  wrapMulterFilenameNormalization(upload);
  wrapMulterFilenameNormalization(upload);

  const req = {};
  await new Promise((resolve, reject) => {
    upload.single('file')(req, {}, error => error ? reject(error) : resolve());
  });
  assert.equal(req.file.originalname, '老婆的照片.png');
});

test('multer 文件名包装会原样传递上传错误', async () => {
  const expected = new Error('too large');
  const upload = { single: () => (_req, _res, next) => next(expected) };
  wrapMulterFilenameNormalization(upload);

  await new Promise(resolve => {
    upload.single('file')({}, {}, error => {
      assert.equal(error, expected);
      resolve();
    });
  });
});
