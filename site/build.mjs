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
buildRevisitingDiscardsPost();
copyPlayerAssets();

function prepareBuildDirectory() {
  rmSync(buildDirectory, {recursive: true, force: true});
  mkdirSync(buildDirectory, {recursive: true});
}

function copyPublicFiles() {
  cpSync(publicDirectory, buildDirectory, {recursive: true});
}

function buildConfigurationPage() {
  const {title, intro, body, markdown} = loadMarkdownDocument('configuration.md');
  const headings = sectionHeadings(markdown.parse(body, {}));
  const output = readTemplate('configuration.html')
    .replaceAll('{{title}}', escapeHtml(title))
    .replace('{{intro}}', markdown.renderInline(intro))
    .replace('{{toc}}', renderTableOfContents(headings))
    .replace('{{content}}', wrapSections(markdown.render(body)));
  writeFileSync(resolve(buildDirectory, 'configuration.html'), output);
}

function buildRevisitingDiscardsPost() {
  const {title, intro, body, markdown} = loadMarkdownDocument('revisiting-discards.md');
  const output = readTemplate('post.html')
    .replaceAll('{{title}}', escapeHtml(title))
    .replaceAll('{{slug}}', 'revisiting-discards')
    .replaceAll('{{description}}', escapeHtml('pi-autoresearch now asks the agent to revisit discarded experiments once their assumptions stop holding, and marks intentional retries in the transcript.'))
    .replaceAll('{{socialImage}}', 'social-preview-revisiting-discards.png')
    .replaceAll('{{socialAlt}}', escapeHtml('A discard is a decision about now, not forever. Run #7 failed while CPUs were busy; run #12 cached that work; run #15 retried and won. A pi terminal shows ↻ Revisiting #7.'))
    .replace('{{eyebrow}}', 'Feature · Revisiting discards')
    .replace('{{intro}}', markdown.renderInline(intro))
    .replaceAll('{{cast}}', 'revisit')
    .replace('{{castCaption}}', 'Run #7 is discarded, run #12 changes the assumption behind it, and run #15 goes back — marked <code>↻ Revisiting #7</code>.')
    .replace('{{shippedIn}}', 'pi-autoresearch 1.8.0 — see the <a href="https://github.com/davebcn87/pi-autoresearch/blob/main/CHANGELOG.md">changelog</a>.')
    .replace('{{content}}', wrapSections(markdown.render(body)));
  writeFileSync(resolve(buildDirectory, 'revisiting-discards.html'), output);
}

function loadMarkdownDocument(filename) {
  const source = readFileSync(resolve(contentDirectory, filename), 'utf8');
  return {...parseDocument(source), markdown: createMarkdownRenderer()};
}

function readTemplate(filename) {
  return readFileSync(resolve(siteDirectory, 'templates', filename), 'utf8');
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
  return new MarkdownIt({html: false, linkify: true})
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
