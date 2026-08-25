import { AppMark } from "@ainoveltools/ui";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "@tanstack/react-router";
import {
  BookOpenText,
  Bot,
  Clock3,
  FileSearch,
  LibraryBig,
  ListTree,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { getBootstrapStatus } from "../lib/tauri-client";

const navigation = [
  { label: "项目", icon: LibraryBig, active: true },
  { label: "规划", icon: ListTree },
  { label: "正文", icon: BookOpenText },
  { label: "知识", icon: FileSearch },
  { label: "AI", icon: Bot },
  { label: "审核", icon: ShieldCheck },
];

export function AppShell() {
  const bootstrap = useQuery({
    queryKey: ["bootstrap-status"],
    queryFn: getBootstrapStatus,
  });

  const serviceLabel = bootstrap.isSuccess
    ? `核心服务 ${bootstrap.data.appVersion}`
    : bootstrap.isError
      ? "核心服务不可用"
      : "正在连接核心服务";

  return (
    <div className="app-shell">
      <header className="title-bar">
        <div className="brand-lockup">
          <AppMark className="app-mark" />
          <span>AI Novel Tools</span>
        </div>
        <div className="project-context">未打开项目</div>
      </header>

      <aside className="activity-bar" aria-label="主要导航">
        <nav>
          {navigation.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              className="activity-button"
              data-active={active || undefined}
              aria-label={label}
              title={label}
              disabled={!active}
            >
              <Icon size={19} strokeWidth={1.8} />
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="activity-button activity-settings"
          aria-label="设置"
          title="设置"
          disabled
        >
          <Settings size={19} strokeWidth={1.8} />
        </button>
      </aside>

      <aside className="primary-sidebar">
        <div className="sidebar-heading">
          <span>项目</span>
          <span className="sidebar-count">0</span>
        </div>
        <div className="sidebar-empty">
          <LibraryBig size={18} strokeWidth={1.6} />
          <span>没有打开的小说工程</span>
        </div>
      </aside>

      <main className="workspace">
        <Outlet />
      </main>

      <footer className="status-bar">
        <span className="status-item">
          <span
            className="status-dot"
            data-state={bootstrap.status}
            aria-hidden="true"
          />
          {serviceLabel}
        </span>
        <span className="status-item">
          <Clock3 size={13} /> 本地优先
        </span>
      </footer>
    </div>
  );
}
