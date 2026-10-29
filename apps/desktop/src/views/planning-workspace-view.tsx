import { useRouterState } from "@tanstack/react-router";
import { CreationPreparationView } from "./creation-preparation-view";
import { ProjectWorkspaceView } from "./project-workspace-view";
import "./creation-preparation.css";
import { PreparationNotesNav } from "./preparation-notes-nav";
import { StoryPlanningWorkbench } from "./story-planning-workbench";
import { BookPreparationView } from "./book-preparation-view";

export function PlanningWorkspaceView() {
  const location = useRouterState({ select: (state) => state.location });
  const search = new URLSearchParams(location.searchStr);
  const exactTarget = ["planNode", "discussionTarget", "referenceChapter"].some((key) => search.has(key)) || Boolean(location.hash);
  const structure = search.get("mode") !== "prepare" || exactTarget;
  return <section className="planning-workspace">
    <header className="workspace-heading planning-workspace-heading">
      <h1>{structure ? "大纲" : "筹备"}</h1>
    </header>
    {!structure && <PreparationNotesNav selectedId={search.get("note") ?? (search.has("item") ? undefined : "seed-tone")} />}
    {structure ? <ProjectWorkspaceView key={location.searchStr} embedded /> : search.has("note")
      ? <StoryPlanningWorkbench key={search.get("note")} selectedSectionId={search.get("note") ?? ""} />
      : search.has("item") ? <CreationPreparationView key={search.get("item")} embedded initialItem={search.get("item") ?? undefined} />
        : <BookPreparationView />}
  </section>;
}
