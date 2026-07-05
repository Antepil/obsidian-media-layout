import { Extension, RangeSetBuilder, Text } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType
} from "@codemirror/view";
import {
  App,
  Editor,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile
} from "obsidian";

type MediaKind = "image" | "video";
type FillMode = "cover" | "contain";

interface MediaLayoutSettings {
  enableReadingView: boolean;
  enableLivePreview: boolean;
  defaultGap: number;
  maxColumns: number;
  minMediaWidth: number;
  fillMode: FillMode;
  persistResize: boolean;
}

interface ParsedMediaToken {
  raw: string;
  target: string;
  alt?: string;
  kind: MediaKind;
  syntax: "wiki" | "markdown";
  width?: number;
  start: number;
  end: number;
  from: number;
  to: number;
}

interface ParsedMediaLine {
  lineNumber: number;
  from: number;
  to: number;
  tokens: ParsedMediaToken[];
}

interface MediaLayoutMetadata {
  width?: number;
}

interface MediaGroup {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  commentLine?: number;
  commentFrom?: number;
  commentTo?: number;
  layout: MediaLayoutMetadata;
  tokens: ParsedMediaToken[];
  key: string;
}

interface RenderOptions {
  sourcePath: string;
  editorView?: EditorView;
  interactive: boolean;
}

const DEFAULT_SETTINGS: MediaLayoutSettings = {
  enableReadingView: true,
  enableLivePreview: true,
  defaultGap: 8,
  maxColumns: 3,
  minMediaWidth: 160,
  fillMode: "cover",
  persistResize: true
};

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp"
]);

const VIDEO_EXTENSIONS = new Set([
  "m4v",
  "mov",
  "mp4",
  "ogv",
  "webm"
]);

const MEDIA_LAYOUT_COMMENT_PATTERN = /^<!--\s*media-layout:\s*(\{.*\})\s*-->$/;

export default class MediaLayoutPlugin extends Plugin {
  settings!: MediaLayoutSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.processReadingView(el, ctx);
    });

    this.registerEditorExtension(createMediaLayoutExtension(this));

    this.addCommand({
      id: "reset-current-media-sizes",
      name: "Reset current media sizes",
      editorCallback: (editor) => {
        this.resetCurrentMediaSizes(editor);
      }
    });

    this.addCommand({
      id: "reset-current-media-layout",
      name: "Reset current media layout",
      editorCallback: (editor) => {
        this.resetCurrentMediaLayout(editor);
      }
    });

    this.addCommand({
      id: "toggle-media-fill-mode",
      name: "Toggle media fill mode",
      callback: async () => {
        this.settings.fillMode = this.settings.fillMode === "cover" ? "contain" : "cover";
        await this.saveSettings();
        this.refreshMarkdownViews();
        new Notice(`Media Layout: ${this.settings.fillMode}`);
      }
    });

    this.addSettingTab(new MediaLayoutSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  resolveMediaSrc(target: string, sourcePath: string): string {
    const normalized = normalizeTarget(target);
    if (/^(https?:|app:|data:|file:)/i.test(normalized)) {
      return normalized;
    }

    const decoded = safeDecodeURIComponent(normalized);
    const file = this.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
    if (file instanceof TFile) {
      return this.app.vault.getResourcePath(file);
    }

    return normalized;
  }

  getSourcePathForEditorView(view: EditorView): string {
    const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeEditorView = (activeMarkdownView?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    if (activeEditorView === view) {
      return activeMarkdownView?.file?.path ?? "";
    }

    return this.app.workspace.getActiveFile()?.path ?? "";
  }

  isLivePreviewEditor(view: EditorView): boolean {
    return Boolean(view.dom.closest(".markdown-source-view.is-live-preview"));
  }

  createLivePreviewGroupElement(group: MediaGroup, options: RenderOptions): HTMLElement {
    const root = document.createElement("div");
    root.className = buildGroupClassName(group.tokens.length, "media-layout-widget");
    root.style.setProperty("--media-layout-gap", `${this.settings.defaultGap}px`);
    root.style.setProperty("--media-layout-min-width", `${this.settings.minMediaWidth}px`);
    root.style.setProperty("--media-layout-columns", String(getColumnCount(group.tokens.length, this.settings.maxColumns)));
    root.dataset.fillMode = group.tokens.length === 1 ? "contain" : this.settings.fillMode;

    if (group.layout.width) {
      root.style.maxWidth = `${group.layout.width}px`;
    }

    if (group.tokens.length === 1 && group.tokens[0].width) {
      root.style.width = `${group.tokens[0].width}px`;
    }

    for (const token of group.tokens) {
      const item = document.createElement("div");
      item.className = "media-layout-item";
      item.appendChild(this.createMediaElement(token, options.sourcePath));
      root.appendChild(item);

      if (options.interactive && group.tokens.length === 1) {
        this.attachResizeHandle(item, root, {
          label: "Resize media",
          initialWidth: token.width,
          onEnd: (width) => {
            if (!options.editorView || !this.settings.persistResize) {
              return;
            }
            const changed = persistTokenWidth(options.editorView, token, width);
            if (!changed) {
              new Notice("Media Layout: this embed syntax cannot store a native width.");
            }
          }
        });
      }
    }

    if (options.interactive && group.tokens.length > 1) {
      this.attachResizeHandle(root, root, {
        label: "Resize media group",
        initialWidth: group.layout.width,
        onEnd: (width) => {
          if (options.editorView && this.settings.persistResize) {
            persistGroupWidth(options.editorView, group, width);
          }
        }
      });
    }

    return root;
  }

  createMediaElement(token: ParsedMediaToken, sourcePath: string): HTMLElement {
    const src = this.resolveMediaSrc(token.target, sourcePath);
    if (token.kind === "video") {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = src;
      return video;
    }

    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = src;
    img.alt = token.alt ?? token.target;
    return img;
  }

  attachResizeHandle(
    host: HTMLElement,
    resizedElement: HTMLElement,
    options: {
      label: string;
      initialWidth?: number;
      onEnd: (width: number) => void;
    }
  ): void {
    const handle = document.createElement("button");
    handle.className = "media-layout-resize-handle";
    handle.type = "button";
    handle.setAttribute("aria-label", options.label);
    handle.setAttribute("title", options.label);
    host.appendChild(handle);

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);

      const startX = event.clientX;
      const startWidth = options.initialWidth ?? resizedElement.getBoundingClientRect().width;
      const maxWidth = getResizeMaxWidth(resizedElement);
      let latestWidth = startWidth;

      const onPointerMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientX - startX;
        latestWidth = clampWidth(
          Math.round(startWidth + delta),
          this.settings.minMediaWidth,
          maxWidth
        );
        resizedElement.style.width = `${latestWidth}px`;
        resizedElement.style.maxWidth = "100%";
      };

      const onPointerUp = () => {
        handle.removeEventListener("pointermove", onPointerMove);
        handle.removeEventListener("pointerup", onPointerUp);
        handle.removeEventListener("pointercancel", onPointerUp);
        options.onEnd(latestWidth);
      };

      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerUp);
      handle.addEventListener("pointercancel", onPointerUp);
    });
  }

  processReadingView(el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    if (!this.settings.enableReadingView) {
      return;
    }

    const children = Array.from(el.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    let run: HTMLElement[] = [];

    const flush = () => {
      if (run.length === 0) {
        return;
      }
      this.wrapReadingMediaRun(run);
      run = [];
    };

    for (const child of children) {
      if (child.closest(".media-layout-group")) {
        flush();
        continue;
      }

      if (this.isRenderedMediaOnlyBlock(child)) {
        run.push(child);
      } else {
        flush();
      }
    }

    flush();
  }

  wrapReadingMediaRun(blocks: HTMLElement[]): void {
    const firstBlock = blocks[0];
    const parent = firstBlock.parentElement;
    if (!parent) {
      return;
    }

    const itemCount = blocks.reduce((count, block) => count + this.extractRenderedMediaNodes(block).length, 0);
    const wrapper = document.createElement("div");
    wrapper.className = buildGroupClassName(itemCount, "media-layout-reading");
    wrapper.style.setProperty("--media-layout-gap", `${this.settings.defaultGap}px`);
    wrapper.style.setProperty("--media-layout-min-width", `${this.settings.minMediaWidth}px`);
    wrapper.style.setProperty("--media-layout-columns", String(getColumnCount(itemCount, this.settings.maxColumns)));
    wrapper.dataset.fillMode = itemCount === 1 ? "contain" : this.settings.fillMode;

    parent.insertBefore(wrapper, firstBlock);

    for (const block of blocks) {
      const mediaNodes = this.extractRenderedMediaNodes(block);
      for (const node of mediaNodes) {
        const item = document.createElement("div");
        item.className = "media-layout-item";
        item.appendChild(node);
        wrapper.appendChild(item);
      }

      if (mediaNodes.every((node) => node !== block) && block.parentElement) {
        block.remove();
      }
    }

    if (itemCount > 1) {
      this.attachResizeHandle(wrapper, wrapper, {
        label: "Resize media group",
        onEnd: () => undefined
      });
    } else {
      const item = wrapper.querySelector<HTMLElement>(".media-layout-item");
      if (item) {
        this.attachResizeHandle(item, wrapper, {
          label: "Resize media",
          onEnd: () => undefined
        });
      }
    }
  }

  isRenderedMediaOnlyBlock(element: HTMLElement): boolean {
    if (element.matches("pre, code, table, ul, ol, blockquote")) {
      return false;
    }

    const mediaNodes = this.extractRenderedMediaNodes(element);
    if (mediaNodes.length === 0) {
      return false;
    }

    const clone = element.cloneNode(true) as HTMLElement;
    for (const mediaNode of Array.from(clone.querySelectorAll(getRenderedMediaSelector()))) {
      mediaNode.remove();
    }

    for (const br of Array.from(clone.querySelectorAll("br"))) {
      br.remove();
    }

    return (clone.textContent ?? "").trim().length === 0;
  }

  extractRenderedMediaNodes(element: HTMLElement): HTMLElement[] {
    if (isRenderedMediaElement(element)) {
      return [element];
    }

    const directMediaNodes = Array.from(element.children).filter((child): child is HTMLElement => {
      return child instanceof HTMLElement && this.isRenderedMediaOnlyBlock(child);
    });

    if (directMediaNodes.length > 0) {
      return directMediaNodes;
    }

    const mediaNodes = Array.from(element.querySelectorAll(getRenderedMediaSelector())).filter(
      (child): child is HTMLElement => child instanceof HTMLElement
    );
    return mediaNodes.length > 0 ? mediaNodes : [];
  }

  resetCurrentMediaSizes(editor: Editor): void {
    const group = getEditorGroupAroundCursor(editor);
    if (!group) {
      new Notice("Media Layout: no media group at cursor.");
      return;
    }

    for (let lineNumber = group.endLine; lineNumber >= group.startLine; lineNumber--) {
      const line = editor.getLine(lineNumber);
      const next = removeWikiWidths(line);
      if (line !== next) {
        editor.replaceRange(next, { line: lineNumber, ch: 0 }, { line: lineNumber, ch: line.length });
      }
    }

    this.resetCurrentMediaLayout(editor, false);
    new Notice("Media Layout: media sizes reset.");
  }

  resetCurrentMediaLayout(editor: Editor, showNotice = true): void {
    const group = getEditorGroupAroundCursor(editor);
    if (!group) {
      if (showNotice) {
        new Notice("Media Layout: no media group at cursor.");
      }
      return;
    }

    const commentLineNumber = group.endLine + 1;
    if (commentLineNumber < editor.lineCount() && parseLayoutComment(editor.getLine(commentLineNumber))) {
      const line = editor.getLine(commentLineNumber);
      editor.replaceRange("", { line: commentLineNumber, ch: 0 }, { line: commentLineNumber + 1, ch: 0 });
      if (commentLineNumber === editor.lineCount() - 1) {
        editor.replaceRange("", { line: commentLineNumber, ch: 0 }, { line: commentLineNumber, ch: line.length });
      }
      if (showNotice) {
        new Notice("Media Layout: group layout reset.");
      }
      return;
    }

    if (showNotice) {
      new Notice("Media Layout: no stored layout metadata found.");
    }
  }

  refreshMarkdownViews(): void {
    const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editorView = (activeMarkdownView?.editor as unknown as { cm?: EditorView } | undefined)?.cm;
    editorView?.dispatch({});
    (activeMarkdownView as unknown as { previewMode?: { rerender?: (force?: boolean) => void } })?.previewMode?.rerender?.(true);
  }
}

class MediaGroupWidget extends WidgetType {
  constructor(
    private readonly plugin: MediaLayoutPlugin,
    private readonly group: MediaGroup
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    return this.plugin.createLivePreviewGroupElement(this.group, {
      sourcePath: this.plugin.getSourcePathForEditorView(view),
      editorView: view,
      interactive: true
    });
  }

  eq(): boolean {
    return false;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function createMediaLayoutExtension(plugin: MediaLayoutPlugin): Extension {
  return ViewPlugin.fromClass(
    class MediaLayoutLivePreviewPlugin {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildLivePreviewDecorations(view, plugin);
      }

      update(update: ViewUpdate): void {
        this.decorations = buildLivePreviewDecorations(update.view, plugin);
      }
    },
    {
      decorations: (value) => value.decorations
    }
  );
}

function buildLivePreviewDecorations(view: EditorView, plugin: MediaLayoutPlugin): DecorationSet {
  if (!plugin.settings.enableLivePreview || !plugin.isLivePreviewEditor(view)) {
    return Decoration.none;
  }

  const groups = parseMediaGroups(view.state.doc);
  if (groups.length === 0) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const group of groups) {
    if (selectionIntersectsGroup(view, group)) {
      continue;
    }

    builder.add(
      group.from,
      group.to,
      Decoration.replace({
        block: true,
        widget: new MediaGroupWidget(plugin, group)
      })
    );
  }

  return builder.finish();
}

function selectionIntersectsGroup(view: EditorView, group: MediaGroup): boolean {
  return view.state.selection.ranges.some((range) => {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    return from <= group.to && to >= group.from;
  });
}

function parseMediaGroups(doc: Text): MediaGroup[] {
  const groups: MediaGroup[] = [];
  let lineNumber = 1;

  while (lineNumber <= doc.lines) {
    const parsedLine = parseMediaLine(doc, lineNumber);
    if (!parsedLine) {
      lineNumber++;
      continue;
    }

    const groupLines = [parsedLine];
    let nextLineNumber = lineNumber + 1;
    while (nextLineNumber <= doc.lines) {
      const nextLine = parseMediaLine(doc, nextLineNumber);
      if (!nextLine) {
        break;
      }
      groupLines.push(nextLine);
      nextLineNumber++;
    }

    const first = groupLines[0];
    const last = groupLines[groupLines.length - 1];
    const tokens = groupLines.flatMap((line) => line.tokens);
    const nextLine = nextLineNumber <= doc.lines ? doc.line(nextLineNumber) : undefined;
    const layout = nextLine ? parseLayoutComment(nextLine.text) : undefined;

    const to = layout ? nextLine?.to ?? last.to : last.to;
    groups.push({
      from: first.from,
      to,
      startLine: first.lineNumber,
      endLine: last.lineNumber,
      commentLine: layout ? nextLineNumber : undefined,
      commentFrom: layout ? nextLine?.from : undefined,
      commentTo: layout ? nextLine?.to : undefined,
      layout: layout ?? {},
      tokens,
      key: buildGroupKey(first.from, to, tokens, layout)
    });

    lineNumber = layout ? nextLineNumber + 1 : nextLineNumber;
  }

  return groups;
}

function parseMediaLine(doc: Text, lineNumber: number): ParsedMediaLine | null {
  const line = doc.line(lineNumber);
  const tokens = parseMediaTokens(line.text, line.from);
  if (tokens.length === 0) {
    return null;
  }

  let remaining = line.text;
  for (const token of [...tokens].sort((a, b) => b.start - a.start)) {
    remaining = remaining.slice(0, token.start) + remaining.slice(token.end);
  }

  if (remaining.trim().length > 0) {
    return null;
  }

  return {
    lineNumber,
    from: line.from,
    to: line.to,
    tokens
  };
}

function parseMediaTokens(text: string, lineFrom = 0): ParsedMediaToken[] {
  const tokens: ParsedMediaToken[] = [];
  const wikiPattern = /!\[\[([^\]]+)\]\]/g;
  const markdownPattern = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

  for (const match of text.matchAll(wikiPattern)) {
    const raw = match[0];
    const inside = match[1];
    const parts = inside.split("|").map((part) => part.trim());
    const target = parts[0];
    const kind = classifyMedia(target);
    if (!kind || match.index === undefined) {
      continue;
    }

    tokens.push({
      raw,
      target,
      kind,
      syntax: "wiki",
      width: extractWidthFromWikiParts(parts),
      start: match.index,
      end: match.index + raw.length,
      from: lineFrom + match.index,
      to: lineFrom + match.index + raw.length
    });
  }

  for (const match of text.matchAll(markdownPattern)) {
    const raw = match[0];
    const target = normalizeTarget(match[2]);
    const kind = classifyMedia(target);
    if (!kind || match.index === undefined) {
      continue;
    }

    const start = match.index;
    const end = match.index + raw.length;
    if (tokens.some((token) => rangesOverlap(start, end, token.start, token.end))) {
      continue;
    }

    tokens.push({
      raw,
      target,
      alt: match[1],
      kind,
      syntax: "markdown",
      start,
      end,
      from: lineFrom + start,
      to: lineFrom + end
    });
  }

  return tokens.sort((a, b) => a.start - b.start);
}

function parseLayoutComment(text: string): MediaLayoutMetadata | null {
  const match = text.trim().match(MEDIA_LAYOUT_COMMENT_PATTERN);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as MediaLayoutMetadata;
    return Number.isFinite(parsed.width) ? { width: parsed.width } : {};
  } catch {
    return {};
  }
}

function persistTokenWidth(view: EditorView, token: ParsedMediaToken, width: number): boolean {
  if (token.syntax !== "wiki") {
    return false;
  }

  const next = setWikiWidth(token.raw, width);
  view.dispatch({
    changes: {
      from: token.from,
      to: token.to,
      insert: next
    }
  });
  return true;
}

function persistGroupWidth(view: EditorView, group: MediaGroup, width: number): void {
  const comment = `<!-- media-layout: ${JSON.stringify({ width })} -->`;
  if (group.commentFrom !== undefined && group.commentTo !== undefined) {
    view.dispatch({
      changes: {
        from: group.commentFrom,
        to: group.commentTo,
        insert: comment
      }
    });
    return;
  }

  const endLine = view.state.doc.line(group.endLine);
  view.dispatch({
    changes: {
      from: endLine.to,
      insert: `\n${comment}`
    }
  });
}

function setWikiWidth(raw: string, width: number): string {
  const inside = raw.slice(3, -2);
  const parts = inside.split("|").map((part) => part.trim()).filter(Boolean);
  const widthText = String(width);
  const widthIndex = parts.findIndex((part, index) => index > 0 && isWidthPart(part));

  if (widthIndex >= 0) {
    parts[widthIndex] = widthText;
  } else {
    parts.push(widthText);
  }

  return `![[${parts.join("|")}]]`;
}

function removeWikiWidths(text: string): string {
  return text.replace(/!\[\[([^\]]+)\]\]/g, (raw: string) => {
    const inside = raw.slice(3, -2);
    const parts = inside.split("|").map((part) => part.trim()).filter(Boolean);
    const next = parts.filter((part, index) => index === 0 || !isWidthPart(part));
    return `![[${next.join("|")}]]`;
  });
}

function getEditorGroupAroundCursor(editor: Editor): { startLine: number; endLine: number } | null {
  const cursorLine = editor.getCursor().line;
  let anchorLine = cursorLine;

  if (!isEditorMediaLine(editor, anchorLine) && anchorLine > 0 && parseLayoutComment(editor.getLine(anchorLine))) {
    anchorLine--;
  }

  if (!isEditorMediaLine(editor, anchorLine)) {
    return null;
  }

  let startLine = anchorLine;
  while (startLine > 0 && isEditorMediaLine(editor, startLine - 1)) {
    startLine--;
  }

  let endLine = anchorLine;
  while (endLine + 1 < editor.lineCount() && isEditorMediaLine(editor, endLine + 1)) {
    endLine++;
  }

  return { startLine, endLine };
}

function isEditorMediaLine(editor: Editor, lineNumber: number): boolean {
  const line = editor.getLine(lineNumber);
  const tokens = parseMediaTokens(line);
  if (tokens.length === 0) {
    return false;
  }

  let remaining = line;
  for (const token of [...tokens].sort((a, b) => b.start - a.start)) {
    remaining = remaining.slice(0, token.start) + remaining.slice(token.end);
  }
  return remaining.trim().length === 0;
}

function extractWidthFromWikiParts(parts: string[]): number | undefined {
  for (const part of parts.slice(1)) {
    const width = parseWidthPart(part);
    if (width) {
      return width;
    }
  }
  return undefined;
}

function isWidthPart(part: string): boolean {
  return /^\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?$/.test(part.trim());
}

function parseWidthPart(part: string): number | undefined {
  const match = part.trim().match(/^(\d+(?:\.\d+)?)(?:x\d+(?:\.\d+)?)?$/);
  if (!match) {
    return undefined;
  }
  return Math.round(Number(match[1]));
}

function classifyMedia(target: string): MediaKind | null {
  const extension = getExtension(target);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return null;
}

function getExtension(target: string): string {
  const clean = normalizeTarget(target).split("#")[0].split("?")[0];
  const index = clean.lastIndexOf(".");
  return index >= 0 ? clean.slice(index + 1).toLowerCase() : "";
}

function normalizeTarget(target: string): string {
  const trimmed = target.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function rangesOverlap(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}

function buildGroupKey(
  from: number,
  to: number,
  tokens: ParsedMediaToken[],
  layout?: MediaLayoutMetadata | null
): string {
  return `${from}:${to}:${layout?.width ?? "auto"}:${tokens.map((token) => token.raw).join("|")}`;
}

function buildGroupClassName(count: number, extraClassName: string): string {
  const countClass = count >= 5 ? "media-layout-count-many" : `media-layout-count-${count}`;
  return `media-layout-group ${countClass} ${extraClassName}`;
}

function getColumnCount(count: number, maxColumns: number): number {
  if (count <= 1) {
    return 1;
  }
  if (count === 2 || count === 4) {
    return 2;
  }
  return Math.min(Math.max(1, maxColumns), count);
}

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(Math.max(width, minWidth), maxWidth);
}

function getResizeMaxWidth(element: HTMLElement): number {
  const parentWidth = element.parentElement?.getBoundingClientRect().width ?? 0;
  const viewportWidth = document.documentElement.clientWidth;
  return Math.max(240, Math.floor(parentWidth || viewportWidth));
}

function getRenderedMediaSelector(): string {
  return [
    "img",
    "video",
    ".internal-embed.media-embed",
    ".internal-embed.image-embed",
    ".internal-embed.video-embed",
    ".media-embed",
    ".image-embed",
    ".video-embed"
  ].join(",");
}

function isRenderedMediaElement(element: HTMLElement): boolean {
  return element.matches(getRenderedMediaSelector());
}

class MediaLayoutSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: MediaLayoutPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Media Layout" });

    new Setting(containerEl)
      .setName("Enable Reading View")
      .setDesc("Apply automatic media layouts in reading view.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableReadingView).onChange(async (value) => {
          this.plugin.settings.enableReadingView = value;
          await this.plugin.saveSettings();
          this.plugin.refreshMarkdownViews();
        });
      });

    new Setting(containerEl)
      .setName("Enable Live Preview")
      .setDesc("Replace consecutive media-only lines with an interactive layout while editing.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.enableLivePreview).onChange(async (value) => {
          this.plugin.settings.enableLivePreview = value;
          await this.plugin.saveSettings();
          this.plugin.refreshMarkdownViews();
        });
      });

    new Setting(containerEl)
      .setName("Persist resize")
      .setDesc("Write drag resize results back to Markdown when the syntax supports it.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.persistResize).onChange(async (value) => {
          this.plugin.settings.persistResize = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Gap")
      .setDesc("Space between media items.")
      .addSlider((slider) => {
        slider
          .setLimits(0, 32, 1)
          .setValue(this.plugin.settings.defaultGap)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.defaultGap = value;
            await this.plugin.saveSettings();
            this.plugin.refreshMarkdownViews();
          });
      });

    new Setting(containerEl)
      .setName("Maximum columns")
      .setDesc("Maximum columns for groups with five or more media items.")
      .addSlider((slider) => {
        slider
          .setLimits(2, 5, 1)
          .setValue(this.plugin.settings.maxColumns)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxColumns = value;
            await this.plugin.saveSettings();
            this.plugin.refreshMarkdownViews();
          });
      });

    new Setting(containerEl)
      .setName("Minimum media width")
      .setDesc("Lower bound used by resize handles and responsive grids.")
      .addSlider((slider) => {
        slider
          .setLimits(96, 320, 8)
          .setValue(this.plugin.settings.minMediaWidth)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.minMediaWidth = value;
            await this.plugin.saveSettings();
            this.plugin.refreshMarkdownViews();
          });
      });

    new Setting(containerEl)
      .setName("Multi-item fill mode")
      .setDesc("Cover crops media into a tidy wall; contain keeps the whole image visible.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("cover", "Cover")
          .addOption("contain", "Contain")
          .setValue(this.plugin.settings.fillMode)
          .onChange(async (value) => {
            this.plugin.settings.fillMode = value as FillMode;
            await this.plugin.saveSettings();
            this.plugin.refreshMarkdownViews();
          });
      });
  }
}
