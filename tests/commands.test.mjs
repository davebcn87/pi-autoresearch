import assert from "node:assert/strict";
import test from "node:test";

import {
  SUBCOMMANDS,
  getAutoresearchArgumentCompletions,
  isHelpRequest,
  renderAutoresearchHelp,
} from "../extensions/pi-autoresearch/commands.ts";

const subcommandNames = SUBCOMMANDS.map((subcommand) => subcommand.name);
const completedValues = (prefix) => getAutoresearchArgumentCompletions(prefix)?.map((item) => item.value) ?? null;

test("an empty prefix offers every subcommand with its description", () => {
  const items = getAutoresearchArgumentCompletions("");
  assert.deepEqual(items.map((item) => item.value), ["off", "finalize", "clear", "export", "dashboard", "help"]);
  for (const item of items) {
    assert.equal(item.label, item.value);
    assert.ok(item.description.length > 0, `${item.value} has a description`);
  }
});

test("completions filter by prefix, ignoring case and surrounding whitespace", () => {
  assert.deepEqual(completedValues("fi"), ["finalize"]);
  assert.deepEqual(completedValues("e"), ["export"]);
  assert.deepEqual(completedValues("D"), ["dashboard"]);
  assert.deepEqual(completedValues(" cl"), ["clear"]);
});

test("a subcommand typed in full gets no popup, so the first Enter runs it", () => {
  for (const name of subcommandNames) {
    assert.equal(getAutoresearchArgumentCompletions(name), null, `${name} still shows a popup`);
    assert.equal(getAutoresearchArgumentCompletions(`${name.toUpperCase()} `), null, `${name} in caps still shows a popup`);
  }
});

test("completions return null when nothing matches so pi shows no popup for a free-text goal", () => {
  assert.equal(getAutoresearchArgumentCompletions("optimize test runtime"), null);
  assert.equal(getAutoresearchArgumentCompletions("--"), null);
});

test("help is requested by an empty command or any help alias", () => {
  for (const alias of ["", "help", "--help", "-h"]) {
    assert.equal(isHelpRequest(alias), true, `"${alias}" is a help request`);
  }
});

test("a free-text goal that merely mentions help is not a help request", () => {
  assert.equal(isHelpRequest("help me optimize the build"), false);
  assert.equal(isHelpRequest("off"), false);
});

test("the usage line lists every subcommand in completion order", () => {
  const [usage] = renderAutoresearchHelp().split("\n");
  assert.equal(usage, `Usage: /autoresearch [${[...subcommandNames, "<text>"].join("|")}]`);
});

test("help describes every subcommand with the description its completion shows", () => {
  const helpLines = renderAutoresearchHelp().split("\n");
  for (const { name, description } of SUBCOMMANDS) {
    const documented = helpLines.some((line) => line.startsWith(`${name} `) && line.endsWith(description));
    assert.ok(documented, `help documents ${name}`);
  }
  assert.ok(helpLines.some((line) => /^<text> {2,}Enter autoresearch mode/.test(line)));
  assert.match(renderAutoresearchHelp(), /\nExamples:\n {2}\/autoresearch /);
});

test("help aligns every description in one column", () => {
  const describedLines = renderAutoresearchHelp()
    .split("\n")
    .filter((line) => ["<text>", ...subcommandNames].some((name) => line.startsWith(`${name} `)));
  const descriptionColumns = describedLines.map((line) => line.match(/^\S+ +/)[0].length);
  assert.equal(describedLines.length, subcommandNames.length + 1);
  assert.equal(new Set(descriptionColumns).size, 1, `descriptions start at one column, got ${descriptionColumns}`);
});
