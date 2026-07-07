# Media Intelligent layout

![Obsidian plugin](https://img.shields.io/badge/Obsidian-plugin-7c3aed?style=flat-square)
![Version](https://img.shields.io/badge/version-0.1.1-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

Media Intelligent layout 是一款 Obsidian 插件，用于把 Markdown 里的原生图片、视频嵌入渲染成类似飞书和 Notion 的智能媒体排版：连续多张图片会自动组成图片墙，单个媒体或媒体组可以通过拖拽调整宽度。

插件优先保持 Markdown 兼容性。你依然使用 Obsidian 原生语法，例如 `![[image.png]]`、`![[video.mp4]]`、`![](https://example.com/image.jpg)`；禁用插件后，文档仍然是普通 Markdown/Obsidian 嵌入。

## Features

- 自动识别连续的图片/视频嵌入，并组成媒体区域。
- 支持 1、2、3、4、5+ 个媒体的响应式布局。
- 三图布局采用类似知识库工具常见的左大右小视觉结构。
- 支持图片和视频：`png`、`jpg`、`gif`、`webp`、`svg`、`mp4`、`mov`、`webm` 等。
- Live Preview 中支持拖拽调整单个媒体或整个媒体组宽度。
- 单个 wiki embed 会写回 Obsidian 原生宽度语法，例如 `![[image.png|320]]`。
- 多媒体组宽度用隐藏 HTML 注释保存，不引入专用代码块。
- 提供设置页控制 Live Preview、Reading View、间距、最大列数、最小宽度和填充模式。

## Installation

### BRAT / BART

如果你说的 BART 指的是 Obsidian 社区常用的 BRAT，可以这样安装：

1. 在 Obsidian 中安装并启用 BRAT。
2. 打开命令面板，执行 `BRAT: Add a beta plugin for testing`。
3. 填入仓库地址：

```text
https://github.com/Antepil/obsidian-media-layout
```

4. 等待 BRAT 下载 release 中的 `main.js`、`manifest.json`、`styles.css`。
5. 到 Obsidian 的 Community plugins 页面启用 `Media Intelligent layout`。

### Manual

下载 GitHub Release 里的三个文件：

- `main.js`
- `manifest.json`
- `styles.css`

放到你的 vault：

```text
<your-vault>/.obsidian/plugins/media-layout/
```

然后在 Obsidian 设置中启用插件。

插件显示名是 `Media Intelligent layout`，插件 ID 仍为 `media-layout`，这样已安装用户可以平滑更新。

## Usage

连续写多行媒体嵌入即可自动布局：

```md
![[photo-a.jpg]]
![[photo-b.jpg]]
![[photo-c.jpg]]
```

空行、普通文字、标题、列表正文会打断媒体区域：

```md
![[photo-a.jpg]]
![[photo-b.jpg]]

这一段文字会打断上面的媒体组。

![[clip.mp4]]
```

在 Live Preview 中，把鼠标移动到媒体右下角，会出现拖拽控制点。拖动结束后，插件会在支持的语法中写回尺寸。

## Layout Rules

- 1 个媒体：单独显示，默认完整展示。
- 2 个媒体：左右双列。
- 3 个媒体：左侧大图，右侧上下两张。
- 4 个媒体：二乘二网格。
- 5 个及以上：按设置中的最大列数生成响应式网格。

## Commands

- `Reset current media sizes`
- `Reset current media layout`
- `Toggle media fill mode`

## Settings

- Enable Reading View
- Enable Live Preview
- Persist resize
- Gap
- Maximum columns
- Minimum media width
- Multi-item fill mode: `Cover` 或 `Contain`

## Development

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
```

构建产物：

- `main.js`
- `manifest.json`
- `styles.css`

## Project Structure

```text
.
├── src/main.ts
├── styles.css
├── manifest.json
├── versions.json
├── esbuild.config.mjs
├── samples/
└── .github/workflows/release.yml
```

## Roadmap

- 增加媒体工具栏。
- 支持更多布局模板。
- 支持为 Markdown image 语法持久化尺寸。
- 增加截图和演示动图。

## License

MIT
