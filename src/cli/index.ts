import { Command } from "commander";

import { VERSION } from "../index.js";

const program = new Command();

program
  .name("diarchy")
  .description(
    "Two AI coding agents, each running as a product manager, coordinating through an Obsidian vault.",
  )
  .version(VERSION);

program
  .command("init")
  .description("Install diarchy into Claude Code and Codex CLI")
  .action(() => {
    console.error("diarchy init: not implemented yet");
    process.exit(1);
  });

program.parse(process.argv);
