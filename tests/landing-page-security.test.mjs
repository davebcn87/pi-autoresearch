import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const landingPage = readFileSync(new URL("../site/public/index.html", import.meta.url), "utf8");
const landingScript = readFileSync(new URL("../site/public/script.js", import.meta.url), "utf8");

function contentSecurityPolicy() {
  return landingPage.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
}

test("social preview uses the current dark website design", () => {
  assert.match(landingPage, /assets\/social-preview-dark\.png/);
  assert.doesNotMatch(landingPage, /assets\/social-preview\.png/);
  assert.ok(existsSync(new URL("../site/public/assets/social-preview-dark.png", import.meta.url)));
});

test("landing page executes only same-origin parent scripts", () => {
  const policy = contentSecurityPolicy();
  assert.ok(policy);
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(policy, /connect-src 'self' blob: https:\/\/api\.github\.com/);
  assert.match(policy, /frame-src https:\/\/platform\.twitter\.com/);
  assert.doesNotMatch(landingScript, /platform\.twitter\.com\/widgets\.js/);
});

test("live GitHub stars accept only a valid non-negative integer", () => {
  assert.match(landingScript, /fetch\('https:\/\/api\.github\.com\/repos\/davebcn87\/pi-autoresearch'/);
  assert.match(landingScript, /!Number\.isSafeInteger\(stars\) \|\| stars < 0/);
  assert.match(landingScript, /credentials: 'omit'/);
});

test("X embeds stay in validated sandboxed cross-origin frames", () => {
  assert.match(landingScript, /new URL\('https:\/\/platform\.twitter\.com\/embed\/Tweet\.html'\)/);
  assert.match(landingScript, /event\.origin !== 'https:\/\/platform\.twitter\.com'/);
  assert.match(landingScript, /embed\.contentWindow !== event\.source/);
  assert.match(landingScript, /allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox/);
});

test("dashboard result query is allowlisted before selector construction", () => {
  assert.match(landingScript, /Object\.hasOwn\(publishedResults, requestedResult\)/);
  assert.doesNotMatch(landingScript, /dashboard-tab="\$\{requestedResult\}"/);
});
