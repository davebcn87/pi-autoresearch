import {cpSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import MarkdownIt from 'markdown-it';
import markdownItAnchor from 'markdown-it-anchor';

const siteDirectory = import.meta.dirname;
const buildDirectory = resolve(siteDirectory, 'build');
const contentDirectory = resolve(siteDirectory, 'content');
const publicDirectory = resolve(siteDirectory, 'public');
const vendorDirectory = resolve(buildDirectory, 'vendor');
const playerDirectory = resolve(siteDirectory, 'node_modules/asciinema-player/dist/bundle');

prepareBuildDirectory();
copyPublicFiles();
await import('./scripts/generate-casts.mjs');
buildConfigurationPage();
copyPlayerAssets();

function prepareBuildDirectory() {
  rmSync(buildDirectory, {recursive: true, force: true});
  mkdirSync(buildDirectory, {recursive: true});
}

function copyPublicFiles() {
  cpSync(publicDirectory, buildDirectory, {recursive: true});
}

function buildConfigurationPage() {
  const source = readFileSync(resolve(contentDirectory, 'configuration.md'), 'utf8');
  const {title, intro, body} = parseDocument(source);
  const markdown = createMarkdownRenderer();
  const headings = sectionHeadings(markdown.parse(body, {}));
  const renderedContent = wrapSections(markdown.render(body));
  const template = readFileSync(resolve(siteDirectory, 'templates/configuration.html'), 'utf8');
  const output = template
    .replaceAll('{{title}}', escapeHtml(title))
    .replace('{{intro}}', markdown.renderInline(intro))
    .replace('{{toc}}', renderTableOfContents(headings))
    .replace('{{content}}', renderedContent);
  writeFileSync(resolve(buildDirectory, 'configuration.html'), output);
}

function parseDocument(source) {
  const lines = source.trim().split('\n');
  const title = lines.shift()?.replace(/^#\s+/, '') ?? 'Configuration';
  while (lines[0]?.trim() === '') lines.shift();
  const firstSection = lines.findIndex((line) => line.startsWith('## '));
  const intro = lines.slice(0, firstSection).join('\n').trim();
  const body = lines.slice(firstSection).join('\n');
  return {title, intro, body};
}

function createMarkdownRenderer() {
  return new MarkdownIt({html: false, linkify: true, typographer: true})
    .use(markdownItAnchor, {slugify: sectionId});
}

function sectionHeadings(tokens) {
  const headings = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'heading_open' || token.tag !== 'h2') return;
    headings.push({id: token.attrGet('id'), text: tokens[index + 1].content});
  });
  return headings;
}

function sectionId(title) {
  const knownIds = {
    'Session configuration': 'config-file',
    'Session files': 'session-files',
    'Runtime options': 'runtime',
    'Safety and trust': 'safety',
    'Keyboard shortcuts (opt-in)': 'shortcuts',
    'Hooks': 'hooks',
    'Session controls': 'commands',
    'Intentionally fixed behavior': 'fixed',
    'Start with the defaults': 'start',
  };
  return knownIds[title] ?? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function wrapSections(content) {
  let sectionCount = 0;
  const wrapped = content.replace(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g, (_match, id, heading) => {
    const closePrevious = sectionCount > 0 ? '</section>' : '';
    sectionCount += 1;
    return `${closePrevious}<section class="docs-section" id="${id}"><h2>${heading}</h2>`;
  });
  return `${decorateMarkdown(wrapped)}</section>`;
}

function decorateMarkdown(content) {
  return content
    .replaceAll('<pre><code', '<pre class="docs-code"><code')
    .replaceAll('<table>', '<div class="config-table-wrap"><table class="config-table">')
    .replaceAll('</table>', '</table></div>')
    .replaceAll('<blockquote>', '<blockquote class="docs-note">');
}

function renderTableOfContents(headings) {
  return headings
    .filter(({id}) => id !== 'start')
    .map(({id, text}) => `<a href="#${id}">${escapeHtml(text)}</a>`)
    .join('\n');
}

function copyPlayerAssets() {
  mkdirSync(vendorDirectory, {recursive: true});
  copyFileSync(resolve(playerDirectory, 'asciinema-player.min.js'), resolve(vendorDirectory, 'asciinema-player.min.js'));
  copyFileSync(resolve(playerDirectory, 'asciinema-player.css'), resolve(vendorDirectory, 'asciinema-player.css'));
  copyFileSync(resolve(siteDirectory, 'node_modules/asciinema-player/LICENSE'), resolve(vendorDirectory, 'asciinema-player.LICENSE'));
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
