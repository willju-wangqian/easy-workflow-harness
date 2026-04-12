#!/usr/bin/env node
/**
 * Build HTML docs from markdown files with clipboard copy buttons on code blocks.
 * Output goes to out/ in the project root.
 *
 * Usage: npm run docs:build
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join, basename } from 'path'

const ROOT = new URL('..', import.meta.url).pathname
const OUT_DIR = join(ROOT, 'out')

const targets = [
  { src: join(ROOT, 'README.md'), name: 'index' },
  ...readdirSync(join(ROOT, 'docs'))
    .filter(f => f.endsWith('.md'))
    .map(f => ({ src: join(ROOT, 'docs', f), name: basename(f, '.md') })),
]

/** Rehype plugin: wrap every <pre> in a .code-block div with a Copy button. */
function rehypeCodeCopy() {
  return tree => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'pre' || !parent) return
      const copyBtn = {
        type: 'element',
        tagName: 'button',
        properties: { className: ['copy-btn'] },
        children: [{ type: 'text', value: 'Copy' }],
      }
      parent.children.splice(index, 1, {
        type: 'element',
        tagName: 'div',
        properties: { className: ['code-block'] },
        children: [copyBtn, node],
      })
    })
  }
}

const STYLES = `
* { box-sizing: border-box; }
body {
  max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem;
  font-family: system-ui, sans-serif; line-height: 1.65; color: #1a1a1a;
}
h1, h2, h3, h4 { line-height: 1.3; margin-top: 2rem; }
a { color: #0066cc; }
code {
  background: #f0f0f0; padding: 0.15em 0.35em;
  border-radius: 3px; font-size: 0.88em;
}
.code-block { position: relative; margin: 1rem 0; }
.copy-btn {
  position: absolute; top: 0.5rem; right: 0.5rem; z-index: 1;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25);
  color: #aaa; padding: 0.2rem 0.65rem; border-radius: 4px;
  cursor: pointer; font-size: 12px; font-family: system-ui, sans-serif;
  transition: background 0.15s, color 0.15s;
}
.copy-btn:hover { background: rgba(255,255,255,0.22); color: #fff; }
.copy-btn.copied { color: #6fcf97; border-color: #6fcf97; }
pre {
  background: #1e1e2e; color: #cdd6f4;
  padding: 1.25rem 1rem; border-radius: 8px;
  overflow-x: auto; margin: 0;
}
pre code { background: none; padding: 0; font-size: 0.875rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid #ddd; padding: 0.5rem 0.75rem; text-align: left; }
th { background: #f6f6f6; }
blockquote {
  border-left: 4px solid #ddd; margin: 0; padding: 0.5rem 1rem; color: #555;
}
`

const CLIPBOARD_SCRIPT = `
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const pre = btn.nextElementSibling;
    const text = (pre.querySelector('code') || pre).innerText;
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    }).catch(() => {
      btn.textContent = 'Failed';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    });
  });
});
`

function template(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — EWH Docs</title>
  <style>${STYLES}</style>
</head>
<body>
${body}
<script>${CLIPBOARD_SCRIPT}</script>
</body>
</html>`
}

const processor = unified()
  .use(remarkParse)
  .use(remarkRehype)
  .use(rehypeCodeCopy)
  .use(rehypeStringify)

mkdirSync(OUT_DIR, { recursive: true })

for (const { src, name } of targets) {
  const md = readFileSync(src, 'utf8')
  const result = await processor.process(md)
  const title = name === 'index' ? 'Easy Workflow Harness' : name
  writeFileSync(join(OUT_DIR, `${name}.html`), template(title, String(result)))
  console.log(`  out/${name}.html`)
}

console.log(`\nBuilt ${targets.length} files → out/`)
