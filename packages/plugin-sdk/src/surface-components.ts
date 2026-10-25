/** 样式节点 ID，确保多个 Surface 组件模块只注入一次基础规范。 */
const PLUGIN_SURFACE_COMPONENT_STYLE_ID = 'dutydeck-plugin-surface-components'

/**
 * DutyDeck 公开的插件 Surface 组件视觉规范。
 * 该样式只使用宿主主题令牌，供不依赖 React/Radix 的沙箱 Surface 复用。
 */
export const PLUGIN_SURFACE_COMPONENT_STYLES = `
:root {
  color-scheme: var(--dutydeck-color-scheme, light dark);
  color: var(--dutydeck-foreground, #1f2937);
  background: var(--dutydeck-background, #fff);
  font-family: var(--dutydeck-font-family, system-ui, sans-serif);
  font-feature-settings: "cv11", "ss01", "ss03", "tnum";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  min-height: 100%;
  margin: 0;
}

body {
  background: var(--dutydeck-background, #fff);
  color: var(--dutydeck-foreground, #111827);
}

button, input, select, textarea {
  color: inherit;
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: .5;
}

/* 与项目 Dialog 保持一致：512px 内容宽度、24px 内距、xl 阴影和 hairline 边框。 */
.dd-dialog {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  width: min(32rem, calc(100vw - 2rem));
  max-height: calc(100dvh - 2rem);
  margin: auto;
  padding: 1.5rem;
  gap: 1rem;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--dutydeck-border, #d8dce0) 50%, transparent);
  border-radius: var(--dutydeck-radius-cap, 6px);
  background: var(--dutydeck-dialog, var(--dutydeck-card, #fff));
  color: var(--dutydeck-dialog-foreground, var(--dutydeck-foreground, #111827));
  box-shadow: var(--dutydeck-shadow-xl, none);
}

.dd-dialog:not([open]) {
  display: none;
}

.dd-dialog[open] {
  animation: dd-dialog-in 150ms ease-out;
}

.dd-dialog::backdrop {
  background: rgb(0 0 0 / .4);
  animation: dd-dialog-backdrop-in 150ms ease-out;
}

.dd-dialog-form {
  display: grid;
  min-width: 0;
  gap: 1rem;
}

.dd-dialog-head {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: .375rem;
  padding-right: 2rem;
  text-align: left;
}

.dd-dialog-kicker {
  margin: 0;
  color: var(--dutydeck-muted-foreground, #6b7280);
  font: 600 10px/1.35 var(--dutydeck-font-mono, ui-monospace, monospace);
  letter-spacing: .08em;
  text-transform: uppercase;
}

.dd-dialog-title {
  margin: 0;
  color: inherit;
  font-size: 1.125rem;
  font-weight: 600;
  line-height: 1;
  letter-spacing: -.01em;
}

.dd-dialog-description {
  margin: 0;
  color: var(--dutydeck-muted-foreground, #6b7280);
  font-size: .875rem;
  line-height: 1.55;
}

.dd-dialog-close {
  position: absolute;
  top: 1rem;
  right: 1rem;
}

.dd-dialog-body {
  display: grid;
  min-width: 0;
  gap: 1rem;
}

.dd-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: .5rem;
}

/* 字段与 Radix Input/Textarea/SelectTrigger 使用同一组尺寸和焦点反馈。 */
.dd-field {
  display: grid;
  min-width: 0;
  gap: .375rem;
}

.dd-label {
  color: var(--dutydeck-foreground, #111827);
  font-size: .75rem;
  font-weight: 500;
  line-height: 1.4;
}

.dd-hint {
  color: var(--dutydeck-muted-foreground, #6b7280);
  font-size: .6875rem;
  line-height: 1.5;
}

.dd-input,
.dd-select,
.dd-textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid color-mix(in srgb, var(--dutydeck-border, #d8dce0) 60%, transparent);
  border-radius: calc(var(--dutydeck-radius, 6px) - 2px);
  background: color-mix(in srgb, var(--dutydeck-background, #fff) 40%, transparent);
  box-shadow: var(--dutydeck-shadow-xs, none);
  outline: none;
  transition:
    border-color 150ms ease-out,
    box-shadow 150ms ease-out,
    background-color 150ms ease-out;
}

.dd-input,
.dd-select {
  height: 2.25rem;
  font-size: .875rem;
}

.dd-input {
  padding: .25rem .75rem;
}

.dd-textarea {
  min-height: 4.5rem;
  padding: .5rem .75rem;
  font-size: .875rem;
  line-height: 1.5;
  resize: vertical;
}

.dd-code-input {
  min-height: 18rem;
  font-family: var(--dutydeck-font-mono, ui-monospace, monospace);
  font-size: .875rem;
  line-height: 1.55;
}

.dd-select {
  appearance: none;
  padding: .5rem 2rem .5rem .75rem;
}

.dd-select-wrap {
  position: relative;
  min-width: 0;
}

.dd-select-wrap::after {
  position: absolute;
  top: 50%;
  right: .9rem;
  width: .4rem;
  height: .4rem;
  transform: translateY(-70%) rotate(45deg);
  border-right: 1.5px solid var(--dutydeck-muted-foreground, #6b7280);
  border-bottom: 1.5px solid var(--dutydeck-muted-foreground, #6b7280);
  content: "";
  pointer-events: none;
}

.dd-input::placeholder,
.dd-textarea::placeholder {
  color: color-mix(in srgb, var(--dutydeck-muted-foreground, #6b7280) 70%, transparent);
}

.dd-input:hover,
.dd-select:hover,
.dd-textarea:hover {
  border-color: var(--dutydeck-border, #d8dce0);
}

.dd-input:focus-visible,
.dd-select:focus-visible,
.dd-textarea:focus-visible {
  border-color: var(--dutydeck-ring, #111827);
  background: var(--dutydeck-background, #fff);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dutydeck-ring, #111827) 15%, transparent);
}

/* 与项目 Button 的 default/outline/ghost 规格保持一致。 */
.dd-button,
.dd-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  font-weight: 500;
  user-select: none;
  transition:
    transform 150ms ease-out,
    background-color 150ms ease-out,
    box-shadow 150ms ease-out,
    border-color 150ms ease-out,
    color 150ms ease-out;
}

.dd-button {
  height: 2.25rem;
  padding: .5rem 1rem;
  gap: .5rem;
  border-radius: calc(var(--dutydeck-radius, 6px) - 2px);
  font-size: .875rem;
}

.dd-button[data-size="sm"] {
  height: 2rem;
  padding: 0 .75rem;
  border-radius: calc(var(--dutydeck-radius, 6px) - 4px);
  font-size: .75rem;
}

.dd-button:not([data-variant]),
.dd-button[data-variant="primary"] {
  background: var(--dutydeck-primary, #111827);
  color: var(--dutydeck-primary-foreground, #fff);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / .10),
    0 1px 2px rgb(0 0 0 / .18),
    0 0 0 1px rgb(0 0 0 / .06);
}

.dd-button:not([data-variant]):hover,
.dd-button[data-variant="primary"]:hover {
  background: color-mix(in srgb, var(--dutydeck-primary, #111827) 92%, transparent);
}

.dd-button[data-variant="outline"] {
  border: 1px solid color-mix(in srgb, var(--dutydeck-border, #d8dce0) 60%, transparent);
  background: color-mix(in srgb, var(--dutydeck-background, #fff) 80%, transparent);
  color: var(--dutydeck-foreground, #111827);
  box-shadow: 0 1px 1px rgb(0 0 0 / .04);
}

.dd-button[data-variant="outline"]:hover,
.dd-button[data-variant="ghost"]:hover {
  border-color: var(--dutydeck-border, #d8dce0);
  background: color-mix(in srgb, var(--dutydeck-accent, #f3f4f6) 80%, transparent);
  color: var(--dutydeck-accent-foreground, #111827);
}

.dd-button[data-variant="ghost"] {
  color: var(--dutydeck-foreground, #111827);
}

.dd-button[data-variant="destructive"] {
  background: var(--dutydeck-destructive, #dc2626);
  color: var(--dutydeck-destructive-foreground, #fff);
}

.dd-button:active,
.dd-icon-button:active {
  transform: scale(.97);
}

.dd-button:focus-visible,
.dd-icon-button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dutydeck-ring, #111827) 40%, transparent);
  outline-offset: 1px;
}

.dd-button svg,
.dd-icon-button svg {
  width: 1rem;
  height: 1rem;
  flex: none;
  pointer-events: none;
}

.dd-icon-button {
  width: 1.5rem;
  height: 1.5rem;
  padding: 0;
  border-radius: calc(var(--dutydeck-radius, 6px) - 2px);
  color: var(--dutydeck-foreground, #111827);
  opacity: .6;
}

.dd-icon-button:hover {
  background: color-mix(in srgb, var(--dutydeck-accent, #f3f4f6) 60%, transparent);
  color: var(--dutydeck-foreground, #111827);
  opacity: 1;
}

.dd-error {
  margin: 0;
  color: var(--dutydeck-destructive, #dc2626);
  font-size: .75rem;
  line-height: 1.5;
}

@keyframes dd-dialog-in {
  from { opacity: 0; transform: scale(.96); }
  to { opacity: 1; transform: scale(1); }
}

@keyframes dd-dialog-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (max-width: 640px) {
  .dd-dialog {
    width: calc(100vw - 1.5rem);
    padding: 1.125rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dd-dialog[open],
  .dd-dialog::backdrop {
    animation: none;
  }

  .dd-button,
  .dd-icon-button,
  .dd-input,
  .dd-select,
  .dd-textarea {
    transition: none;
  }
}
`

/**
 * 向插件 Surface 注入公开组件样式。
 * @param targetDocument Surface 文档，默认当前 document。
 */
export function installPluginSurfaceComponentStyles(targetDocument: Document = document): void {
  if (targetDocument.getElementById(PLUGIN_SURFACE_COMPONENT_STYLE_ID)) return
  const style = targetDocument.createElement('style')
  style.id = PLUGIN_SURFACE_COMPONENT_STYLE_ID
  style.textContent = PLUGIN_SURFACE_COMPONENT_STYLES
  targetDocument.head.append(style)
}
