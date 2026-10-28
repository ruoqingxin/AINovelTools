import { useQuery } from "@tanstack/react-query";
import { aiWorkspaceHref } from "../lib/content-taxonomy";
import { getCurrentProject } from "../lib/tauri-client";
import { useInAiWorkspace } from "./content-identity";
import { planningSectionGroups } from "./story-planning-workbench";
import { WorkspaceLink } from "./workspace-link";

export function PreparationNotesNav({ selectedId }: { selectedId?: string }) {
  const workspace = useInAiWorkspace();
  const project = useQuery({ queryKey: ["current-project"], queryFn: getCurrentProject });
  if (!project.data) return null;
  const projectId = project.data.projectId;
  const noteHref = (id: string) => workspace
    ? aiWorkspaceHref({ projectId, workflow: "section", item: id })
    : `/planning?mode=prepare&note=${encodeURIComponent(id)}`;
  return <nav className="preparation-notes-nav" aria-label="创作准备内容">
    {selectedId ? <WorkspaceLink href={workspace ? aiWorkspaceHref({ projectId, workflow: "preparation" }) : "/planning?mode=prepare"}>准备事项</WorkspaceLink> : null}
    <WorkspaceLink href={noteHref("seed-tone")} aria-current={selectedId === "seed-tone" ? "page" : undefined}>本书偏好</WorkspaceLink>
    <details>
      <summary>准备笔记</summary>
      <div className="preparation-note-groups">{planningSectionGroups.map((group) => <section key={group.id}>
        <h3>{group.label}</h3>
        {group.children.filter((item) => item.id !== "seed-tone").map((item) => <WorkspaceLink key={item.id}
          href={noteHref(item.id)} aria-current={selectedId === item.id ? "page" : undefined}>{item.label}</WorkspaceLink>)}
      </section>)}</div>
    </details>
  </nav>;
}
