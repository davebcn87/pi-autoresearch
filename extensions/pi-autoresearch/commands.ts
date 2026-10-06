import type { AutocompleteItem } from "@earendil-works/pi-tui";

// The one list of /autoresearch subcommands. Completions, the usage line and
// the help text are all derived from it, so a new subcommand cannot be left
// out of one of them.
export interface Subcommand {
  name: string;
  description: string;
}

export const SUBCOMMANDS: readonly Subcommand[] = [
  { name: "off", description: "Leave autoresearch mode." },
  { name: "finalize", description: "Stop the loop and turn kept experiments into reviewable branches." },
  { name: "clear", description: "Delete the session log (.auto/log.jsonl) and turn autoresearch mode off." },
  { name: "export", description: "Open a local live dashboard for the session log in your browser." },
  { name: "dashboard", description: "Open the fullscreen dashboard overlay in the terminal." },
  { name: "help", description: "Show this help." },
];

const FREE_TEXT: Subcommand = {
  name: "<text>",
  description: "Enter autoresearch mode and start or resume the loop.",
};

// Accepted but not offered as completions: `help` already covers them.
const HELP_ALIASES: ReadonlySet<string> = new Set(["help", "--help", "-h"]);

const EXAMPLES = [
  "/autoresearch optimize unit test runtime, monitor correctness",
  "/autoresearch model training, run 5 minutes of train.py and note the loss ratio as optimization target",
  "/autoresearch export",
  "/autoresearch dashboard",
];

const NAME_GUTTER = 2;

export function isHelpRequest(command: string): boolean {
  return command.length === 0 || HELP_ALIASES.has(command);
}

export function getAutoresearchArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const typed = argumentPrefix.trim().toLowerCase();
  // pi applies an open completion on Enter instead of submitting, so offering
  // a subcommand that is already typed in full would make it take two Enters.
  if (isSubcommandName(typed)) return null;
  const matches = SUBCOMMANDS.filter((subcommand) => subcommand.name.startsWith(typed));
  return matches.length > 0 ? matches.map(toAutocompleteItem) : null;
}

export function renderAutoresearchHelp(): string {
  return [
    usageLine(),
    "",
    ...describedLines([FREE_TEXT, ...SUBCOMMANDS]),
    "",
    "Examples:",
    ...EXAMPLES.map((example) => `  ${example}`),
  ].join("\n");
}

function isSubcommandName(typed: string): boolean {
  return SUBCOMMANDS.some((subcommand) => subcommand.name === typed);
}

function toAutocompleteItem(subcommand: Subcommand): AutocompleteItem {
  return { value: subcommand.name, label: subcommand.name, description: subcommand.description };
}

function usageLine(): string {
  const names = [...SUBCOMMANDS, FREE_TEXT].map((entry) => entry.name);
  return `Usage: /autoresearch [${names.join("|")}]`;
}

function describedLines(entries: readonly Subcommand[]): string[] {
  const nameColumnWidth = Math.max(...entries.map((entry) => entry.name.length)) + NAME_GUTTER;
  return entries.map((entry) => `${entry.name.padEnd(nameColumnWidth)}${entry.description}`);
}
