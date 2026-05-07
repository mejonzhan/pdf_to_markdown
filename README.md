# PDF 转 Markdown（Chrome 插件）

提供能力：
- PDF 内文字自动转换为 Markdown
- PDF 内图片/公式/图表以“页面图片”的形式写入 Markdown（每页渲染一张 PNG，并在 Markdown 中引用）

## 开发与构建

```bash
npm install
npm run build
```

构建产物在 `dist/`，可直接在 Chrome 加载：
- 打开 `chrome://extensions/`
- 开启“开发者模式”
- “加载已解压的扩展程序”选择 `dist/`

## 使用

- 点击扩展图标 → 打开转换器
- 选择 PDF 后会自动转换
- 下载：
  - ZIP：包含 `output.md` 与 `images/`
  - MD：仅下载 Markdown（若勾选“包含页面图片”，Markdown 仍会包含 images 路径引用）
