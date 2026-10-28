import { ClipboardCheck, ListTree } from "lucide-react";
import { useRouterState } from "@tanstack/react-router";
import { CreationPreparationView } from "./creation-preparation-view";
import { ProjectWorkspaceView } from "./project-workspace-view";
import "./creation-preparation.css";
import { WorkspaceLink } from "./workspace-link";
import { PreparationNotesNav } from "./preparation-notes-nav";
import { StoryPlanningWorkbench } from "./story-planning-workbench";

export function PlanningWorkspaceView() {
  const location = useRouterState({ select: (state) => state.location });
  const search = new URLSearchParams(location.searchStr);
  const exactTarget = ["planNode", "discussionTarget", "referenceChapter"].some((key) => search.has(key)) || Boolean(location.hash);
  const structure = search.get("mode") !== "prepare" || exactTarget;
  return <section className="planning-workspace">
    <header className="workspace-heading planning-workspace-heading">
      <h1>{structure ? "大纲" : "创作准备"}</h1>
      <nav className="planning-workspace-modes" aria-label="规划工作区">
        <WorkspaceLink href="/planning?mode=structure" aria-current={structure ? "page" : undefined}><ListTree size={15} />大纲</WorkspaceLink>
        <WorkspaceLink href="/planning?mode=prepare" aria-current={!structure ? "page" : undefined}><ClipboardCheck size={15} />创作准备</WorkspaceLink>
      </nav>
    </header>
    {!structure && <PreparationNotesNav selectedId={search.get("note") ?? undefined} />}
    {structure ? <ProjectWorkspaceView key={location.searchStr} embedded /> : search.has("note")
      ? <StoryPlanningWorkbench key={search.get("note")} selectedSectionId={search.get("note") ?? ""} />
      : <CreationPreparationView key={search.get("item") ?? "continue"} embedded initialItem={search.get("item") ?? undefined} />}
  </section>;
}
