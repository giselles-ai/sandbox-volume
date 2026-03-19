import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

type PackageManager = "npm" | "yarn" | "pnpm" | "bun";

type SetupAnswers = {
  packageManager: PackageManager;
  ci: boolean;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const PACKAGE_MANAGER_LABELS: Record<PackageManager, string> = {
  npm: "npm",
  yarn: "yarn",
  pnpm: "pnpm",
  bun: "bun",
};

const SCRIPT_UPDATES = {
  lint: "oxlint",
  "lint:fix": "oxlint --fix",
  fmt: "oxfmt",
  "fmt:check": "oxfmt --check",
} as const;

const OXC_EDITOR_DOCS_URL = "https://oxc.rs/docs/guide/usage/linter/editors";

async function main() {
  const cwd = process.cwd();
  const packageJsonPath = path.join(cwd, "package.json");

  if (!(await fileExists(packageJsonPath))) {
    console.error("package.json was not found. Run this command from the root of a Node.js project.");
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const detectedPackageManager = await detectPackageManager(cwd);
    const answers = await runCheckPhase(rl, cwd, detectedPackageManager);

    console.log("");
    console.log("### Execution phase");
    console.log(`- package manager: ${answers.packageManager}`);
    console.log(`- CI: ${answers.ci ? "yes" : "no"}`);

    const shouldRun = await confirm(rl, "Run setup now?", true);

    if (!shouldRun) {
      console.log("Aborted.");
      return;
    }

    await installDependencies(cwd, answers.packageManager);
    await updateProjectPackageJson(packageJsonPath);
    await initializeOxcConfig(rl, cwd, answers.packageManager, "oxlint", ".oxlintrc.json");
    await initializeOxcConfig(rl, cwd, answers.packageManager, "oxfmt", ".oxfmtrc.json");

    if (answers.ci) {
      await writeConfigFile(
        rl,
        path.join(cwd, ".github", "workflows", "ci.yml"),
        createCiWorkflow(answers.packageManager),
        ".github/workflows/ci.yml",
      );
    }

    console.log(`- Editor setup: ${OXC_EDITOR_DOCS_URL}`);
    console.log("");
    console.log("Completed.");
  } finally {
    rl.close();
  }
}

async function runCheckPhase(
  rl: readline.Interface,
  cwd: string,
  detectedPackageManager: PackageManager,
): Promise<SetupAnswers> {
  console.log("### Check phase");

  const packageManager = await selectPackageManager(rl, detectedPackageManager);
  const ciDefault = await fileExists(path.join(cwd, ".github", "workflows", "ci.yml"));
  const ci = await confirm(rl, "Need CI workflow?", ciDefault);

  console.log(
    `- package manager detect(${Object.keys(PACKAGE_MANAGER_LABELS).join(", ")}) -> ${packageManager}`,
  );
  console.log(`- need CI?(.github/workflows/ci.yml) -> ${ci ? "yes" : "no"}`);

  return { packageManager, ci };
}

async function selectPackageManager(
  rl: readline.Interface,
  detectedPackageManager: PackageManager,
): Promise<PackageManager> {
  const choices = Object.entries(PACKAGE_MANAGER_LABELS).map(([value, label]) => ({
    value: value as PackageManager,
    label,
  }));

  return selectOption(rl, "Package manager?", choices, detectedPackageManager);
}

async function selectOption<T extends string>(
  rl: readline.Interface,
  label: string,
  choices: Array<{ value: T; label: string }>,
  defaultValue: T,
): Promise<T> {
  console.log(label);
  choices.forEach((choice, index) => {
    const suffix = choice.value === defaultValue ? " (default)" : "";
    console.log(`  ${index + 1}. ${choice.label}${suffix}`);
  });

  while (true) {
    const answer = (await rl.question("> ")).trim();

    if (answer.length === 0) {
      return defaultValue;
    }

    const selectedIndex = Number.parseInt(answer, 10);
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= choices.length) {
      const choice = choices[selectedIndex - 1];
      if (choice) {
        return choice.value;
      }
    }

    const selectedByValue = choices.find((choice) => choice.value === answer.toLowerCase());
    if (selectedByValue) {
      return selectedByValue.value;
    }

    console.log("Enter a valid option number or value.");
  }
}

async function confirm(
  rl: readline.Interface,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";

  while (true) {
    const answer = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();

    if (answer.length === 0) {
      return defaultValue;
    }

    if (["y", "yes"].includes(answer)) {
      return true;
    }

    if (["n", "no"].includes(answer)) {
      return false;
    }

    console.log("Enter y or n.");
  }
}

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const checks: Array<[PackageManager, string]> = [
    ["pnpm", "pnpm-lock.yaml"],
    ["bun", "bun.lockb"],
    ["bun", "bun.lock"],
    ["yarn", "yarn.lock"],
    ["npm", "package-lock.json"],
  ];

  for (const [manager, filename] of checks) {
    if (await fileExists(path.join(cwd, filename))) {
      return manager;
    }
  }

  const userAgent = process.env.npm_config_user_agent ?? "";
  if (userAgent.startsWith("pnpm/")) {
    return "pnpm";
  }

  if (userAgent.startsWith("yarn/")) {
    return "yarn";
  }

  if (userAgent.startsWith("bun/")) {
    return "bun";
  }

  return "npm";
}

async function installDependencies(cwd: string, packageManager: PackageManager) {
  const command = getInstallCommand(packageManager);
  runCommand(cwd, command);
}

function getInstallCommand(packageManager: PackageManager): [string, ...string[]] {
  switch (packageManager) {
    case "npm":
      return ["npm", "install", "-D", "-E", "oxlint", "oxfmt"];
    case "yarn":
      return ["yarn", "add", "-D", "-E", "oxlint", "oxfmt"];
    case "pnpm":
      return ["pnpm", "add", "-D", "-E", "oxlint", "oxfmt"];
    case "bun":
      return ["bun", "add", "-d", "-E", "oxlint", "oxfmt"];
  }
}

async function updateProjectPackageJson(packageJsonPath: string) {
  const source = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(source) as {
    scripts?: Record<string, string>;
  } & Record<string, JsonValue>;

  const nextScripts = {
    ...(packageJson.scripts ?? {}),
    ...SCRIPT_UPDATES,
  };

  packageJson.scripts = nextScripts;

  await writeFile(`${packageJsonPath}`, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  console.log("- updated package.json scripts");
}

async function initializeOxcConfig(
  rl: readline.Interface,
  cwd: string,
  packageManager: PackageManager,
  toolName: "oxlint" | "oxfmt",
  configFilename: ".oxlintrc.json" | ".oxfmtrc.json",
) {
  const configPath = path.join(cwd, configFilename);

  if (await fileExists(configPath)) {
    const overwrite = await confirm(
      rl,
      `${configFilename} already exists. Recreate with ${toolName} --init?`,
      false,
    );
    if (!overwrite) {
      console.log(`- skipped ${configFilename}`);
      return;
    }

    await rm(configPath, { force: true });
  }

  runCommand(cwd, getInitCommand(packageManager, toolName));
  console.log(`- initialized ${configFilename}`);
}

async function writeConfigFile(
  rl: readline.Interface,
  filePath: string,
  content: string,
  label: string,
) {
  if (await fileExists(filePath)) {
    const overwrite = await confirm(rl, `${label} already exists. Overwrite?`, false);
    if (!overwrite) {
      console.log(`- skipped ${label}`);
      return;
    }
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  console.log(`- wrote ${label}`);
}

async function fileExists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(cwd: string, command: [string, ...string[]]) {
  const [bin, ...args] = command;

  console.log(`- ${command.join(" ")}`);

  const result = spawnSync(bin, args, {
    cwd,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`command failed: ${command.join(" ")}`);
  }
}

function getInitCommand(
  packageManager: PackageManager,
  toolName: "oxlint" | "oxfmt",
): [string, ...string[]] {
  switch (packageManager) {
    case "npm":
      return ["npm", "exec", "--", toolName, "--init"];
    case "yarn":
      return ["yarn", "exec", toolName, "--init"];
    case "pnpm":
      return ["pnpm", "exec", toolName, "--init"];
    case "bun":
      return ["bun", "x", toolName, "--init"];
  }
}

function createCiWorkflow(packageManager: PackageManager) {
  switch (packageManager) {
    case "npm":
      return `name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  format:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
          cache: npm

      - run: npm ci
      - run: npx oxfmt --check
      - run: npx oxlint --format=github
`;
    case "yarn":
      return `name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  format:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
          cache: yarn

      - run: corepack enable
      - run: yarn install --frozen-lockfile
      - run: yarn oxfmt --check
      - run: yarn oxlint --format=github
`;
    case "pnpm":
      return `name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  format:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: lts/*
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm exec oxfmt --check
      - run: pnpm exec oxlint --format=github
`;
    case "bun":
      return `name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  format:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2

      - run: bun install --frozen-lockfile
      - run: bun x oxfmt --check
      - run: bun x oxlint --format=github
`;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
