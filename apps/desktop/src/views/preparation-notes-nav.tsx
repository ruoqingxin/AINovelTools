import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { aiWorkspaceHref } from "../lib/content-taxonomy";
import { getCurrentProject } from "../lib/tauri-client";
import { useInAiWorkspace } from "./content-identity";
import { supplementaryPlanningSectionGroups } from "./story-planning-workbench";
import { WorkspaceLink } from "./workspace-link";

export function PreparationNotesNav({ selectedId }: { selectedId?: string }) {
  const router = useRouter({ warn: false });
  const workspace = useInAiWorkspace();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  if (!project.data) return null;
  const projectId = project.data.projectId;
  const noteHref = (id: string) => workspace
    ? aiWorkspaceHref({ projectId, workflow: "section", item: id })
    : `/planning?mode=prepare&note=${encodeURIComponent(id)}`;
  const supplementary = supplementaryPlanningSectionGroups.some((group) => group.children.some((item) => item.id === selectedId));
  const story = selectedId !== "seed-tone" && !supplementary;
  const currentHref = router?.state.location.href ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
  return <nav className="preparation-notes-nav" aria-label="筹备内容">
    <WorkspaceLink href={selectedId === "seed-tone" ? currentHref : noteHref("seed-tone")} aria-current={selectedId === "seed-tone" ? "page" : undefined}>本书偏好</WorkspaceLink>
    <WorkspaceLink href={story ? currentHref : workspace ? aiWorkspaceHref({ projectId, workflow: "preparation", item: "premise" }) : "/planning?mode=prepare&item=premise"}
      aria-current={story ? "page" : undefined}>故事准备</WorkspaceLink>
    <WorkspaceLink href={supplementary ? currentHref : noteHref(supplementaryPlanningSectionGroups[0].children[0].id)}
      aria-current={supplementary ? "page" : undefined}>补充笔记</WorkspaceLink>
    {supplementary && <div className="preparation-note-groups" aria-label="补充笔记目录">{supplementaryPlanningSectionGroups.map((group) => <section key={group.id}>
        <h3>{group.label}</h3>
        {group.children.map((item) => <WorkspaceLink key={item.id}
          href={noteHref(item.id)} aria-current={selectedId === item.id ? "page" : undefined}>{item.label}</WorkspaceLink>)}
      </section>)}</div>}
  </nav>;
}
