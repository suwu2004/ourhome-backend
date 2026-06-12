const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ message: '灯一直为你亮着', status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`OurHome后端运行中，端口：${PORT}`);
});
