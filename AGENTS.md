# Agent 工作约定

## 管理课程书籍

- 新建或修改课程书籍前，先阅读 `content/books/README.md`。
- 仓库课程放在 `content/books/<稳定课程 ID>/`，每门课维护一个 `book.json`，章节维护为 Markdown 文件。
- 章节文件名使用数字前缀（例如 `01-`、`02-`）表示阅读顺序；每篇文档使用一个一级标题作为章节名称。
- `book.json` 的 `id` 创建后保持不变，以保留阅读进度关联。
- 课程目录中的 Markdown 文件会自动进入对应书籍，无需手动改 Vue 页面或服务注册表。
- 更新课程内容时，保持相邻章节顺序清楚，并检查书籍标题、类别和封面主题。

## 个人学习数据

- 日程、待办、笔记、复习卡和阅读状态保存在本机 `data/local/records.json`。
- EPUB/PDF 电子书原文件保存在本机 `data/local/ebooks/<书籍 ID>/`（`source.epub`/`source.pdf` 加同目录 `book.json`），由本机 Node 服务的 `/api/ebooks` 接口读写；浏览器 IndexedDB 不再是电子书主存储。
- `data/local/` 与旧版 `data/private/` 均由 `.gitignore` 排除，不得加入 Git、同步到 GitHub 或移动进 `content/books/`。
- GitHub 同步只处理 `content/books/`。课程目录内容在公开仓库中可见，不得放入私人资料。
- 当前仅在这台电脑使用平台；第二台电脑同步方案暂缓。