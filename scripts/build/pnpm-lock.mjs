import { readFileSync } from "node:fs";
import YAML from "yaml";

/**
 * pnpm 12 writes two YAML documents into pnpm-lock.yaml: the first pins pnpm itself,
 * the second is the project's dependency lock. Return the project importer of the second.
 */
export function readProjectLock(file = "pnpm-lock.yaml") {
  const documents = YAML.parseAllDocuments(readFileSync(file, "utf8")).map(document => {
    if (document.errors.length > 0) throw document.errors[0];
    return document.toJS();
  });
  const project = documents.find(document => document?.importers?.["."]?.dependencies || document?.importers?.["."]?.devDependencies);
  if (!project) throw new Error("pnpm-lock.yaml has no project importer");
  return { lockfileVersion: project.lockfileVersion, importer: project.importers["."], packages: project.packages ?? {} };
}

/** The resolved version of a direct dependency, without pnpm's peer suffix such as "4.1.11(@types/node@20.19.43)". */
export function lockedVersion(importer, name) {
  const entry = importer.dependencies?.[name] ?? importer.devDependencies?.[name] ?? importer.optionalDependencies?.[name];
  return entry ? String(entry.version).replace(/\(.*$/, "") : undefined;
}
