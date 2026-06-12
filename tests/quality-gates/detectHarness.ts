import { mkdtemp, cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

export interface GateResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly root: string;
}

export async function runGateFixture(
  fixtureName: string,
  flag: string,
): Promise<GateResult> {
  const sourceRoot = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "pike-quality-gate-"));
  await writeFile(join(root, "AGENTS.md"), "# Test repository\n", "utf8");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, ".omp/skills/quality-gates/scripts"), { recursive: true });
  await cp(
    join(sourceRoot, "scripts/quality-gates.sh"),
    join(root, "scripts/quality-gates.sh"),
  );
  await cp(
    join(sourceRoot, ".omp/skills/quality-gates/scripts/detect.sh"),
    join(root, ".omp/skills/quality-gates/scripts/detect.sh"),
  );
  await copyIfExists(join(sourceRoot, "quality-gates-rules.json"), join(root, "quality-gates-rules.json"));
  await copyIfExists(join(sourceRoot, "quality-gates-suppressions.json"), join(root, "quality-gates-suppressions.json"));
  const fixturePath = join(sourceRoot, "tests/quality-gates/fixtures", fixtureName);
  await cp(fixturePath, root, {
    recursive: true,
  });
  await mkdir(join(root, "server/src"), { recursive: true });
  await cp(fixturePath, join(root, "server/src"), { recursive: true });
  const result = spawnSync("bash", ["scripts/quality-gates.sh", flag], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
    root,
  };
}

async function copyIfExists(source: string, target: string): Promise<void> {
  if (!existsSync(source)) return;
  await cp(source, target);
}
