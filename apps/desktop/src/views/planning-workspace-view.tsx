import { ClipboardCheck, ListTree } from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { CreationPreparationView } from "./creation-preparation-view";
import { ProjectWorkspaceView } from "./project-workspace-view";
import "./creation-preparation.css";

export function PlanningWorkspaceView() {
  const location = useRouterState({ select: (state) => state.location });
  const search = new URLSearchParams(location.searchStr);
  const exactTarget = ["planNode", "discussionTarget", "referenceChapter"].some((key) => search.has(key)) || Boolean(location.hash);
  const structure = search.get("mode") === "structure" || exactTarget;
  return <section className="planning-workspace">
    <header className="workspace-heading planning-workspace-heading">
      <h1>大纲与规划</h1>
      <nav className="planning-workspace-modes" aria-label="规划工作区">
        <Link to="/planning" search={{ mode: "prepare" }} aria-current={!structure ? "page" : undefined}><ClipboardCheck size={15} />创作准备与主线</Link>
        <Link to="/planning" search={{ mode: "structure" }} aria-current={structure ? "page" : undefined}><ListTree size={15} />分卷与细化</Link>
      </nav>
    </header>
    {structure ? <ProjectWorkspaceView embedded /> : <CreationPreparationView key={search.get("item") ?? "continue"} embedded initialItem={search.get("item") ?? undefined} />}
  </section>;
}
