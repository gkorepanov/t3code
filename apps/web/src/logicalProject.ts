import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import type { Project } from "./types";

export function deriveLogicalProjectKey(
  project: Pick<Project, "environmentId" | "id" | "repositoryIdentity">,
  separateRepositoryPaths = false,
): string {
  const physicalKey = scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  return separateRepositoryPaths
    ? physicalKey
    : (project.repositoryIdentity?.canonicalKey ?? physicalKey);
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project: Pick<Project, "repositoryIdentity"> | null | undefined,
  separateRepositoryPaths = false,
): string {
  const physicalKey = scopedProjectKey(projectRef);
  return separateRepositoryPaths
    ? physicalKey
    : (project?.repositoryIdentity?.canonicalKey ?? physicalKey);
}
