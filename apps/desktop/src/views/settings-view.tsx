import { Bot, Settings2 } from "lucide-react";
import { ModelProfileSettings } from "./model-profile-settings";

export function SettingsView() {
  return <section className="settings-view">
    <div className="workspace-heading"><p className="eyebrow">应用设置</p><h1>设置</h1><p className="workspace-lede">管理应用偏好与本机连接配置。</p></div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">
        <button type="button" className="settings-nav-item" data-active><Bot size={16} />模型 API</button>
        <button type="button" className="settings-nav-item" disabled><Settings2 size={16} />项目偏好</button>
      </nav>
      <ModelProfileSettings />
    </div>
  </section>;
}
