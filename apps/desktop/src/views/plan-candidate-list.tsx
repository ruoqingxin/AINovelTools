import type { InputPlanBatchCandidate } from "../lib/tauri-client";

export function PlanCandidateList({ candidates, excluded, onExcludedChange, onChange, saving, ready = true, unit }: {
  candidates: InputPlanBatchCandidate[]; excluded: Set<string>; onExcludedChange: (titles: Set<string>) => void;
  onChange: (value: string, candidates: InputPlanBatchCandidate[]) => void; saving: boolean; unit: "卷" | "章";
  ready?: boolean;
}) {
  function update(index: number, field: "title" | "content", value: string) {
    const updated = candidates.map((candidate, current) => current === index ? { ...candidate, [field]: value } : candidate);
    onChange(updated.map((candidate) => `${candidate.title}｜${candidate.content}`).join("\n"), updated);
  }
  return <div className="plan-candidate-list">
    {candidates.map((candidate, index) => {
      const prefix = candidate.title.match(new RegExp(`^第[一二三四五六七八九十百零〇两\\d]+${unit}`))?.[0] ?? "";
      return <div className="plan-candidate-item" key={index}>
        <label className="plan-candidate-select"><input type="checkbox" checked={!excluded.has(candidate.title)} disabled={saving || !ready}
          aria-label={`创建${candidate.title}`} onChange={(event) => {
            const next = new Set(excluded);
            if (event.target.checked) next.delete(candidate.title); else next.add(candidate.title);
            onExcludedChange(next);
          }} /><span>{prefix}</span></label>
        <label>名称<input disabled={!ready} aria-label={`候选${index + 1}名称`} value={candidate.title.slice(prefix.length).replace(/^·/, "")}
          onChange={(event) => {
            if (excluded.has(candidate.title)) {
              const next = new Set(excluded); next.delete(candidate.title);
              next.add(`${prefix}·${event.target.value}`); onExcludedChange(next);
            }
            update(index, "title", `${prefix}·${event.target.value}`);
          }} /></label>
        <label className="plan-candidate-content">计划<textarea disabled={!ready} aria-label={`候选${index + 1}计划`} rows={3} value={candidate.content}
          onChange={(event) => update(index, "content", event.target.value)} /></label>
      </div>;
    })}
  </div>;
}
