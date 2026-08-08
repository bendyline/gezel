import { appendFile, copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ExternalFolders,
  gezelMemoriesDir,
  projectMemoriesDir,
  projectMemoryIndexDir,
} from '@bendyline/gezel/paths';
import {
  DEFAULT_MEMORY_KIND,
  type MemoryKind,
  formatMemoryBlock,
} from '../memory/daily-markdown.js';
import { writeFileAtomic } from './atomic.js';

export interface MemoryStoreOptions {
  home: string;
  external?: ExternalFolders;
}

/** Owns the durable daily-memory, lessons, summary, and index paths. */
export class MemoryStore {
  private readonly home: string;
  private readonly external?: ExternalFolders;

  constructor(opts: MemoryStoreOptions) {
    this.home = opts.home;
    this.external = opts.external;
  }

  private memoryBaseDir(scope: 'gezel' | 'project', id: string): string {
    return scope === 'gezel'
      ? gezelMemoriesDir(this.home, id, this.external)
      : projectMemoriesDir(this.home, id, this.external);
  }

  private memoryDir(scope: 'gezel' | 'project', id: string): string {
    return join(this.memoryBaseDir(scope, id), 'daily');
  }

  private todayFile(scope: 'gezel' | 'project', id: string): string {
    const date = new Date().toISOString().slice(0, 10);
    return join(this.memoryDir(scope, id), `${date}.md`);
  }

  async appendMemory(
    scope: 'gezel' | 'project',
    id: string,
    text: string,
    kind: MemoryKind = DEFAULT_MEMORY_KIND,
  ): Promise<void> {
    const dir = this.memoryDir(scope, id);
    await mkdir(dir, { recursive: true });
    const file = this.todayFile(scope, id);
    const time = new Date().toISOString().slice(11, 16);
    await appendFile(file, formatMemoryBlock(time, text, kind), 'utf8');
  }

  async listMemoryDays(scope: 'gezel' | 'project', id: string): Promise<string[]> {
    const dir = this.memoryDir(scope, id);
    try {
      const entries = await readdir(dir);
      return entries
        .filter((entry) => entry.endsWith('.md'))
        .map((entry) => entry.replace('.md', ''))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  async readMemoryDay(scope: 'gezel' | 'project', id: string, day: string): Promise<string> {
    try {
      return await readFile(join(this.memoryDir(scope, id), `${day}.md`), 'utf8');
    } catch {
      return '';
    }
  }

  async readRecentMemories(scope: 'gezel' | 'project', id: string, days = 7): Promise<string> {
    const recent = (await this.listMemoryDays(scope, id)).slice(0, days);
    const parts: string[] = [];
    for (const day of recent) {
      const content = await this.readMemoryDay(scope, id, day);
      if (content.trim()) parts.push(`# ${day}\n${content}`);
    }
    return parts.join('\n\n');
  }

  async writeMemoryDay(
    scope: 'gezel' | 'project',
    id: string,
    day: string,
    content: string,
  ): Promise<void> {
    const dir = this.memoryDir(scope, id);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, `${day}.md`), content);
  }

  async deleteMemoryDay(scope: 'gezel' | 'project', id: string, day: string): Promise<void> {
    await rm(join(this.memoryDir(scope, id), `${day}.md`), { force: true });
  }

  async archiveMemoryDays(
    scope: 'gezel' | 'project',
    id: string,
    days: string[],
    runId: string,
  ): Promise<string> {
    const archiveDir = join(this.memoryBaseDir(scope, id), 'archive', runId);
    await mkdir(archiveDir, { recursive: true });
    for (const day of days) {
      await copyFile(join(this.memoryDir(scope, id), `${day}.md`), join(archiveDir, `${day}.md`));
    }
    return archiveDir;
  }

  memorySummaryPath(scope: 'gezel' | 'project', id: string): string {
    return join(this.memoryBaseDir(scope, id), 'summary.md');
  }

  memoryLessonsPath(gezelId: string): string {
    return join(this.memoryBaseDir('gezel', gezelId), 'lessons.md');
  }

  async readMemoryLessons(gezelId: string): Promise<string> {
    try {
      return await readFile(this.memoryLessonsPath(gezelId), 'utf8');
    } catch {
      return '';
    }
  }

  async writeMemoryLessons(gezelId: string, content: string): Promise<void> {
    await mkdir(this.memoryBaseDir('gezel', gezelId), { recursive: true });
    await writeFileAtomic(this.memoryLessonsPath(gezelId), content);
  }

  async readMemorySummary(scope: 'gezel' | 'project', id: string): Promise<string> {
    try {
      return await readFile(this.memorySummaryPath(scope, id), 'utf8');
    } catch {
      return '';
    }
  }

  memoryIndexDir(scope: 'gezel' | 'project', id: string): string {
    return scope === 'project'
      ? projectMemoryIndexDir(this.home, id)
      : join(this.memoryBaseDir(scope, id), 'index');
  }
}
