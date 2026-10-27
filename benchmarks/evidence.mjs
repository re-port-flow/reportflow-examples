import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Only identifiers needed to join private server logs; never URLs or response bodies. */
export function responseIdentity(response, accepted) {
  const identifier = (value) => typeof value === 'string' && /^[\w:-]{1,256}$/.test(value) ? value : null;
  let files = accepted?.files;
  if (!accepted) {
    try {
      files = JSON.parse(decodeURIComponent(response.headers.get('x-file-mapping') ?? '[]'));
    } catch { files = []; }
  }
  return {
    requestId: identifier(accepted?.requestId ?? response.headers.get('request-id')),
    fileIds: Array.isArray(files) ? files.map((f) => identifier(f?.fileId)).filter(Boolean) : [],
  };
}

/** Private JSONL is deliberately separate from the public, aggregate result. */
export async function openEvidence(path, repoRoot) {
  if (!isAbsolute(path)) throw new Error('--evidence-out must be an absolute private path outside the repository');
  const parent = await realpath(dirname(path));
  const root = await realpath(repoRoot);
  const target = resolve(parent, basename(path));
  const rel = relative(root, target);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('--evidence-out must be outside the repository');
  }
  const file = await open(target, 'wx', 0o600);
  return {
    async write(event) {
      await file.writeFile(`${JSON.stringify(event)}\n`);
      await file.sync();
    },
    async close() { await file.close(); },
  };
}
