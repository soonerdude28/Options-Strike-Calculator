// @vitest-environment node

/**
 * The Vercel CLI upload must actually contain the periscope skill files.
 *
 * Why this exists
 * ---------------
 * api/cron/periscope-playbook failed on EVERY production run it ever had —
 * 64 of 64 rows `failed`, ENOENT on SKILL.md — while `.vercelignore` looked
 * correct and `git check-ignore` agreed the files were included.
 *
 * The trap: `vercel deploy` walks the tree with a prune callback that passes
 * SLASH-LESS relative paths to the `ignore` matcher (buildFileTree2 →
 * readdir-recursive: `rel = relative(root, absPath)`), and skips a pruned
 * directory without descending. A gitignore negation written as
 * `!/.claude/skills/` (trailing slash) only matches the string WITH the
 * trailing slash — a string the walker never produces. So `.claude/skills`
 * matched `/.claude/*`, was pruned whole, the negations never fired, and
 * `includeFiles` at build time had nothing to include. Git itself resolves
 * this correctly, which is exactly why the bug was invisible locally.
 *
 * This test replays the CLI's walk semantics (slash-less paths, prune without
 * descend, symlinks not followed) against the REAL `.vercelignore` and the
 * REAL working tree, and pins the upload contents.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ignoreFactory from 'ignore';
import picomatch from 'picomatch';

const RULES = readFileSync('.vercelignore', 'utf8');

/** Mirror of the CLI walk: slash-less rel paths, prune = never descend. */
function walkLikeVercelCli(
  rel: string,
  ig: ReturnType<typeof ignoreFactory>,
): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(process.cwd(), rel), {
    withFileTypes: true,
  })) {
    const r = `${rel}/${e.name}`;
    if (ig.ignores(r)) continue;
    // Symlinked dirs report isDirectory() === false and are treated as file
    // entries — matching the CLI, which does not follow them into .agents/.
    if (e.isDirectory()) out.push(...walkLikeVercelCli(r, ig));
    else out.push(r);
  }
  return out;
}

describe('.vercelignore under the Vercel CLI walker', () => {
  const ig = ignoreFactory().add(RULES);
  const claudeUpload = walkLikeVercelCli('.claude', ig);

  it('ships exactly the periscope skill files', () => {
    expect(claudeUpload.sort()).toEqual([
      '.claude/skills/periscope/SKILL.md',
      '.claude/skills/periscope/references/applying-skill.md',
      '.claude/skills/periscope/references/capture-conventions.md',
      '.claude/skills/periscope/references/vol-signals-mm-heuristics.md',
      '.claude/skills/periscope/references/worked-example-2026-04-29-trap-day.md',
    ]);
  });

  it('every shipped skill file is matched by vercel.json includeFiles', () => {
    // Shipping the file is necessary but not sufficient — the build must also
    // copy it into the function bundle, which is includeFiles' job.
    const vj = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      functions: Record<string, { includeFiles?: string }>;
    };
    const glob = vj.functions['api/cron/periscope-playbook.ts']?.includeFiles;
    expect(glob).toBeTruthy();
    const matches = picomatch(glob!, { dot: true });
    for (const f of claudeUpload) {
      expect(matches(f), `${f} not matched by includeFiles "${glob}"`).toBe(
        true,
      );
    }
  });

  it('does not ship the symlinked plugin skills', () => {
    // .claude/skills/upstash-* are symlinks into .agents/. Beyond bloat, the
    // includeFiles glob resolving through them ABORTS the build ("File
    // .agents/skills/... does not exist") — so they must stay pruned.
    expect(claudeUpload.some((f) => f.includes('upstash'))).toBe(false);
  });

  it('still ships the one script the build needs, and only that one', () => {
    const scriptsUpload = walkLikeVercelCli('scripts', ig);
    expect(scriptsUpload).toContain('scripts/write-build-info.mjs');
    expect(scriptsUpload).toHaveLength(1);
  });

  it('never regresses to trailing-slash negations', () => {
    // A `!dir/` negation is invisible to the CLI walker. Any re-introduction
    // reproduces the outage this file documents.
    const offenders = RULES.split('\n').filter(
      (l) => l.startsWith('!') && l.trimEnd().endsWith('/'),
    );
    expect(
      offenders,
      `trailing-slash negations never fire: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
