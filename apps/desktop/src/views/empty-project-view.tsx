import { FilePlus2, FolderOpen } from "lucide-react";

export function EmptyProjectView() {
  return (
    <section className="empty-project-view">
      <div className="workspace-heading">
        <p className="eyebrow">项目工作区</p>
        <h1>小说工程</h1>
      </div>

      <div className="project-actions" aria-label="项目操作">
        <button className="primary-action" type="button" disabled>
          <FilePlus2 size={17} />
          新建工程
        </button>
        <button className="secondary-action" type="button" disabled>
          <FolderOpen size={17} />
          打开工程
        </button>
      </div>

      <div className="recent-projects">
        <div className="section-heading">
          <h2>最近使用</h2>
          <span>0 个工程</span>
        </div>
        <div className="empty-list">
          <div className="empty-list-icon" aria-hidden="true">
            <FolderOpen size={21} strokeWidth={1.5} />
          </div>
          <p>最近打开的工程会显示在这里</p>
        </div>
      </div>
    </section>
  );
}
