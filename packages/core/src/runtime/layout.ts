import { ProjectSchema } from '../schemas/project.js';
import { SHARED_PROJECT_MARKER, isSharedLibraryProject } from '../shared-project.js';
import { slugifyEntityName } from './entities.js';
import { gezelRoot, gezelWrites, listGezels } from './gezels.js';
import { MEESTER_ABOUT_MD, randomMeesterName } from './meester.js';
import { getProject, listProjects, projectRoot, projectWrites, readConfig } from './projects.js';
import type { PortableRepository } from './repository.js';

/** Ordinary desktop entities, with no separate mobile state document. */
export async function ensureLayout(repo: PortableRepository): Promise<void> {
  const config = await readConfig(repo);
  const writes = new Map<string, Uint8Array>();
  const directories = ['projects', 'gezels', 'documents'];
  const at = repo.now();
  const addProject = (id: string, name: string, properties?: Record<string, string>) => {
    const project = ProjectSchema.parse({ id, name, createdAt: at, updatedAt: at, properties });
    for (const [path, bytes] of projectWrites(repo, project)) writes.set(path, bytes);
    directories.push(`${projectRoot(id)}/workspace`, `${projectRoot(id)}/artifacts`);
  };
  if (!(await getProject(repo, 'default'))) addProject('default', 'Default');
  const existingLibrary = (await listProjects(repo)).find(isSharedLibraryProject);
  if (existingLibrary) config.sharedProjectId = existingLibrary.id;
  else {
    const id = await repo.uniqueId(
      'projects',
      (await repo.exists('projects/shared')) ? 'shared-library' : 'shared',
    );
    addProject(id, 'Shared library', { [SHARED_PROJECT_MARKER]: '1' });
    config.sharedProjectId = id;
  }
  const gezels = await listGezels(repo);
  if (!gezels.some((gezel) => gezel.id === config.meesterGezelId)) {
    if (gezels.length) config.meesterGezelId = gezels[0]!.id;
    else {
      const name = randomMeesterName();
      const id = await repo.uniqueId('gezels', slugifyEntityName(name));
      for (const [path, bytes] of gezelWrites(repo, {
        id,
        name,
        role: 'Meester',
        roleBasedName: 'meester',
        about: MEESTER_ABOUT_MD,
      }))
        writes.set(path, bytes);
      directories.push(`${gezelRoot(id)}/sessions`);
      config.meesterGezelId = id;
    }
  }
  config.provider ??= 'llama-cpp';
  const configBytes = repo.json(config);
  const original = await repo.files.read('config.json');
  if (!original || new TextDecoder().decode(original) !== new TextDecoder().decode(configBytes))
    writes.set('config.json', configBytes);
  if (writes.size) await repo.transactions.commit(writes, [], directories);
  else for (const path of directories) await repo.files.mkdir(path);
}
